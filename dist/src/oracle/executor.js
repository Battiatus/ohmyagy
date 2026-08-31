import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { hashJson, sha256 } from "../ledger/canonical.js";
import { assertStagedTransactionState, discardStagedTransaction, } from "../broker/staging.js";
export class OracleError extends Error {
    constructor(message) {
        super(message);
        this.name = "OracleError";
    }
}
const approvals = new WeakMap();
export function evaluateStagedTransaction(staged, gates) {
    validateGates(gates);
    assertStagedTransactionState(staged);
    const observations = [];
    for (const gate of gates) {
        const result = spawnSync(gate.program, gate.args, {
            cwd: staged.worktreePath,
            encoding: "utf8",
            shell: false,
            windowsHide: true,
            timeout: gate.timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
        });
        const stdout = result.stdout ?? "";
        const stderr = result.stderr ?? result.error?.message ?? "";
        const exitCode = result.status ?? 124;
        observations.push({
            id: gate.id,
            commandHash: hashJson({ program: gate.program, args: gate.args }),
            exitCode,
            stdoutHash: sha256(stdout),
            stderrHash: sha256(stderr),
        });
        if (exitCode !== 0) {
            discardStagedTransaction(staged);
            return {
                status: "rejected",
                reason: "gate_failed",
                failedGateId: gate.id,
                observations,
            };
        }
        try {
            assertStagedTransactionState(staged);
        }
        catch {
            discardStagedTransaction(staged);
            return {
                status: "rejected",
                reason: "stage_mutated",
                failedGateId: gate.id,
                observations,
            };
        }
    }
    const verdictHash = hashJson({
        transactionId: staged.transaction.transactionId,
        nextVersion: staged.transaction.nextVersion,
        observations,
    });
    const approval = Object.freeze({
        transactionId: staged.transaction.transactionId,
        verdictHash,
    });
    approvals.set(approval, { staged, verdictHash });
    return { status: "approved", approval, observations };
}
export function claimApproval(input) {
    if (typeof input !== "object" || input === null) {
        throw new OracleError("Promotion requires an opaque oracle approval.");
    }
    const record = approvals.get(input);
    if (!record) {
        throw new OracleError("Oracle approval is missing, forged, or already consumed.");
    }
    approvals.delete(input);
    return record;
}
function validateGates(gates) {
    if (!Array.isArray(gates) || gates.length === 0) {
        throw new OracleError("At least one deterministic gate is required.");
    }
    const ids = new Set();
    for (const gate of gates) {
        if (typeof gate.id !== "string" ||
            gate.id.length === 0 ||
            ids.has(gate.id) ||
            typeof gate.program !== "string" ||
            !isAbsolute(gate.program) ||
            !existsSync(gate.program) ||
            !Array.isArray(gate.args) ||
            gate.args.some((arg) => typeof arg !== "string") ||
            !Number.isInteger(gate.timeoutMs) ||
            gate.timeoutMs < 1 ||
            gate.timeoutMs > 300_000) {
            throw new OracleError(`Invalid or duplicate gate definition: ${String(gate.id)}`);
        }
        ids.add(gate.id);
    }
}
