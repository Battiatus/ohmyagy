import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, hashJson, sha256 } from "../control/canonical.js";
import { parseExecutionGraph, parseGraphEvent } from "./model.js";
import { assertTransitionAllowed, projectGraph } from "./kernel.js";
export const GRAPH_GENESIS_HASH = "0".repeat(64);
export function graphPaths(root) {
    const normalizedRoot = resolve(root);
    const graphDir = join(normalizedRoot, ".oma", "graph");
    return {
        root: normalizedRoot,
        graphDir,
        definition: join(graphDir, "execution-graph.json"),
        events: join(graphDir, "events.jsonl"),
        head: join(graphDir, "head.json"),
        lock: join(graphDir, "graph.lock"),
    };
}
export function loadGraphRuntime(root) {
    const paths = graphPaths(root);
    const raw = JSON.parse(readFileSync(paths.definition, "utf8"));
    return { paths, graph: parseExecutionGraph(raw), graphHash: hashJson(raw) };
}
export function initializeGraphStore(root) {
    const runtime = loadGraphRuntime(root);
    if (existsSync(runtime.paths.events) || existsSync(runtime.paths.head)) {
        throw new Error("Graph event store is already initialized");
    }
    mkdirSync(runtime.paths.graphDir, { recursive: true });
    writeFileSync(runtime.paths.events, "", { encoding: "utf8", flag: "wx" });
    writeFileSync(runtime.paths.head, `${JSON.stringify({ entries: 0, headHash: GRAPH_GENESIS_HASH }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return runtime;
}
export function verifyGraphStore(runtime) {
    if (!existsSync(runtime.paths.events) || !existsSync(runtime.paths.head)) {
        return {
            valid: false,
            errors: ["Graph event store is not initialized"],
            events: [],
            headHash: GRAPH_GENESIS_HASH,
        };
    }
    const lines = readFileSync(runtime.paths.events, "utf8")
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0);
    const events = [];
    const errors = [];
    let previousHash = GRAPH_GENESIS_HASH;
    for (let index = 0; index < lines.length; index += 1) {
        try {
            const event = parseGraphEvent(JSON.parse(lines[index]));
            if (event.sequence !== index + 1)
                errors.push(`Sequence mismatch at event ${index + 1}`);
            if (event.previousHash !== previousHash)
                errors.push(`Previous hash mismatch at event ${index + 1}`);
            if (event.graphId !== runtime.graph.graphId ||
                event.graphRevision !== runtime.graph.revision ||
                event.graphHash !== runtime.graphHash) {
                errors.push(`Graph identity mismatch at event ${index + 1}`);
            }
            const { eventHash, ...unsigned } = event;
            if (eventHash !== sha256(canonicalJson(unsigned))) {
                errors.push(`Event hash mismatch at event ${index + 1}`);
            }
            assertTransitionAllowed(runtime.graph, events, event);
            previousHash = event.eventHash;
            events.push(event);
        }
        catch (error) {
            errors.push(`Invalid graph event ${index + 1}: ${messageOf(error)}`);
        }
    }
    try {
        const head = JSON.parse(readFileSync(runtime.paths.head, "utf8"));
        if (typeof head !== "object" ||
            head === null ||
            !("entries" in head) ||
            head.entries !== events.length ||
            !("headHash" in head) ||
            head.headHash !== previousHash) {
            errors.push("Graph head does not match event store");
        }
    }
    catch (error) {
        errors.push(`Invalid graph head: ${messageOf(error)}`);
    }
    try {
        projectGraph(runtime.graph, events);
    }
    catch (error) {
        errors.push(`Graph replay failed: ${messageOf(error)}`);
    }
    return { valid: errors.length === 0, errors, events, headHash: previousHash };
}
export function appendGraphTransition(runtime, input) {
    return withGraphLock(runtime.paths, () => {
        const verification = verifyGraphStore(runtime);
        if (!verification.valid) {
            throw new Error(`Cannot append to invalid graph store: ${verification.errors.join("; ")}`);
        }
        const common = {
            sequence: verification.events.length + 1,
            timestamp: new Date().toISOString(),
            graphId: runtime.graph.graphId,
            graphRevision: runtime.graph.revision,
            graphHash: runtime.graphHash,
            nodeId: input.nodeId,
            dispatchId: input.dispatchId,
            authority: input.eventType === "node_dispatched" ? "scheduler" : input.authority,
            authorityId: input.authorityId,
            previousHash: verification.headHash,
        };
        const unsigned = input.eventType === "node_dispatched"
            ? { ...common, eventType: input.eventType }
            : {
                ...common,
                eventType: input.eventType,
                outcome: input.outcome,
                evidenceHash: input.evidenceHash,
            };
        const event = parseGraphEvent({
            ...unsigned,
            eventHash: sha256(canonicalJson(unsigned)),
        });
        assertTransitionAllowed(runtime.graph, verification.events, event);
        appendFileSync(runtime.paths.events, `${canonicalJson(event)}\n`, "utf8");
        writeFileSync(runtime.paths.head, `${JSON.stringify({ entries: event.sequence, headHash: event.eventHash }, null, 2)}\n`, "utf8");
        return event;
    });
}
function withGraphLock(paths, operation) {
    mkdirSync(dirname(paths.lock), { recursive: true });
    let descriptor;
    try {
        descriptor = openSync(paths.lock, "wx");
    }
    catch {
        throw new Error(`Graph state is locked: ${paths.lock}`);
    }
    try {
        return operation();
    }
    finally {
        closeSync(descriptor);
        rmSync(paths.lock, { force: true });
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
