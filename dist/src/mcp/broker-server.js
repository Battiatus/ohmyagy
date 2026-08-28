import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { discardStagedTransaction, snapshotCleanGitWorkspace, stageProposal, } from "../broker/staging.js";
import { promoteApprovedTransaction } from "../broker/promotion.js";
import { validateProposal } from "../broker/transaction.js";
import { isRecord } from "../control/model.js";
import { evaluateStagedTransaction, } from "../oracle/executor.js";
const protocolVersion = "2025-06-18";
const toolName = "propose_change";
function main() {
    try {
        const config = loadConfig(process.env);
        const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
        lines.on("line", (line) => {
            let request;
            try {
                const message = JSON.parse(line);
                if (isNotification(message)) {
                    return;
                }
                request = parseRequest(message);
                send({ jsonrpc: "2.0", id: request.id, result: handleRequest(config, request) });
            }
            catch (error) {
                if (request) {
                    send({
                        jsonrpc: "2.0",
                        id: request.id,
                        error: { code: -32602, message: messageOf(error) },
                    });
                }
            }
        });
    }
    catch (error) {
        process.stderr.write(`OMA MCP startup error: ${messageOf(error)}\n`);
        process.exitCode = 1;
    }
}
function handleRequest(config, request) {
    if (request.method === "initialize") {
        const requested = isRecord(request.params) && typeof request.params.protocolVersion === "string"
            ? request.params.protocolVersion
            : protocolVersion;
        return {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "oma-broker", version: "1.0.0" },
            instructions: "The model may only propose typed changes. OMA alone validates, stages, gates and promotes.",
        };
    }
    if (request.method === "ping") {
        return {};
    }
    if (request.method === "tools/list") {
        return { tools: [brokerToolDefinition()] };
    }
    if (request.method === "tools/call") {
        if (!isRecord(request.params) || request.params.name !== toolName) {
            throw new Error("Unknown MCP tool");
        }
        const args = request.params.arguments;
        try {
            const result = executeProposal(config, args);
            return {
                content: [{ type: "text", text: JSON.stringify(result) }],
                structuredContent: result,
                isError: result.status !== "promoted",
            };
        }
        catch (error) {
            const failure = { status: "rejected", reason: messageOf(error) };
            return {
                content: [{ type: "text", text: JSON.stringify(failure) }],
                structuredContent: failure,
                isError: true,
            };
        }
    }
    throw new Error(`Unsupported MCP method: ${request.method}`);
}
function executeProposal(config, input) {
    assertUnprotectedProposalInput(input);
    const source = snapshotCleanGitWorkspace(config.workspaceRoot);
    const validated = validateProposal(source, input);
    assertUnprotectedOperations(validated.operations.map((operation) => operation.path));
    let staged;
    try {
        staged = stageProposal(config.workspaceRoot, input);
        const evaluation = evaluateStagedTransaction(staged, config.gates);
        if (evaluation.status === "rejected") {
            staged = undefined;
            return {
                status: "rejected",
                transactionId: validated.transactionId,
                reason: evaluation.reason,
                failedGateId: evaluation.failedGateId,
                observations: evaluation.observations,
            };
        }
        const promotion = promoteApprovedTransaction(evaluation.approval);
        staged = undefined;
        return {
            status: "promoted",
            transactionId: promotion.transactionId,
            verdictHash: promotion.verdictHash,
            parentVersion: promotion.parentVersion,
            promotedVersion: promotion.promotedVersion,
            targetRef: promotion.targetRef,
            observations: evaluation.observations,
        };
    }
    finally {
        if (staged && existsSync(staged.containerPath)) {
            discardStagedTransaction(staged);
        }
    }
}
function assertUnprotectedProposalInput(input) {
    if (!isRecord(input) || !Array.isArray(input.operations))
        return;
    const paths = input.operations.flatMap((operation) => isRecord(operation) && typeof operation.path === "string" ? [operation.path] : []);
    assertUnprotectedOperations(paths);
}
function assertUnprotectedOperations(paths) {
    const protectedPrefixes = [
        ".git",
        ".agents",
        "_agents",
        ".oma/control",
        ".oma/graph",
    ];
    for (const path of paths) {
        const normalized = path.toLocaleLowerCase("en-US");
        if (protectedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
            throw new Error(`Transaction targets protected OMA control path: ${path}`);
        }
    }
}
function brokerToolDefinition() {
    const operationSchema = {
        oneOf: [
            {
                type: "object",
                additionalProperties: false,
                required: ["kind", "path", "baseHash", "content"],
                properties: {
                    kind: { const: "write" },
                    path: { type: "string" },
                    baseHash: { type: ["string", "null"] },
                    content: { type: "string" },
                },
            },
            {
                type: "object",
                additionalProperties: false,
                required: ["kind", "path", "baseHash"],
                properties: {
                    kind: { const: "delete" },
                    path: { type: "string" },
                    baseHash: { type: "string" },
                },
            },
        ],
    };
    return {
        name: toolName,
        title: "Propose an OMA-governed code transaction",
        description: "Submit a typed proposal. The broker performs CAS, isolated Git worktree staging, fixed external gates and atomic promotion. The caller cannot choose commands, gates or verdicts.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["schemaVersion", "parentVersion", "operations"],
            properties: {
                schemaVersion: { const: 1 },
                parentVersion: { type: "string" },
                operations: { type: "array", minItems: 1, items: operationSchema },
            },
        },
        outputSchema: {
            type: "object",
            required: ["status"],
            properties: { status: { enum: ["promoted", "rejected"] } },
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
        },
    };
}
function loadConfig(environment) {
    const workspaceRoot = environment.OMA_WORKSPACE_ROOT;
    const gatesPath = environment.OMA_GATES_PATH;
    if (!workspaceRoot || !gatesPath) {
        throw new Error("OMA_WORKSPACE_ROOT and OMA_GATES_PATH are required");
    }
    const raw = JSON.parse(readFileSync(resolve(gatesPath), "utf8"));
    if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.gates)) {
        throw new Error("Malformed frozen gate configuration");
    }
    const gates = raw.gates.map(parseGate);
    return { workspaceRoot: resolve(workspaceRoot), gates };
}
function parseGate(input, index) {
    if (!isRecord(input) ||
        typeof input.id !== "string" ||
        typeof input.program !== "string" ||
        !Array.isArray(input.args) ||
        input.args.some((arg) => typeof arg !== "string") ||
        !Number.isInteger(input.timeoutMs)) {
        throw new Error(`Malformed gate ${index}`);
    }
    const expected = new Set(["id", "program", "args", "timeoutMs"]);
    if (Object.keys(input).some((key) => !expected.has(key))) {
        throw new Error(`Gate ${index} contains unexpected fields`);
    }
    return {
        id: input.id,
        program: input.program,
        args: input.args,
        timeoutMs: Number(input.timeoutMs),
    };
}
function parseRequest(input) {
    if (!isRecord(input) ||
        input.jsonrpc !== "2.0" ||
        (typeof input.id !== "string" && typeof input.id !== "number") ||
        typeof input.method !== "string") {
        throw new Error("Malformed JSON-RPC request");
    }
    return {
        jsonrpc: "2.0",
        id: input.id,
        method: input.method,
        params: input.params,
    };
}
function isNotification(input) {
    return isRecord(input) && input.jsonrpc === "2.0" && !("id" in input);
}
function send(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
main();
