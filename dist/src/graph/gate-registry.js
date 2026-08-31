import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isRecord } from "../ledger/canonical.js";
export function resolveGraphGates(graph, repositoryRoot) {
    const nodesWithAcceptance = graph.nodes.filter((node) => node.acceptance !== undefined);
    if (nodesWithAcceptance.length === 0)
        return new Map();
    const registryPath = process.env.OMA_GATES_PATH ?? join(repositoryRoot, ".agents", "plugins", "oma", "gates.json");
    let raw;
    try {
        raw = JSON.parse(readFileSync(registryPath, "utf8"));
    }
    catch (error) {
        throw new Error(`Invalid gate registry at ${registryPath}: ${messageOf(error)}`);
    }
    const registry = parseGateRegistry(raw);
    const byId = new Map(registry.map((gate) => [gate.id, gate]));
    const resolved = new Map();
    for (const node of nodesWithAcceptance) {
        const gates = node.acceptance?.map((criterion) => {
            const gate = byId.get(criterion.gateId);
            if (!gate) {
                throw new Error(`Unknown gateId ${criterion.gateId} for node ${node.id} acceptance ${criterion.id}`);
            }
            return { ...gate, args: [...gate.args] };
        });
        resolved.set(node.id, gates ?? []);
    }
    return resolved;
}
function parseGateRegistry(value) {
    if (!isRecord(value))
        throw new Error("Malformed gate registry: expected an object");
    assertExactKeys(value, ["schemaVersion", "gates"], "gate registry");
    if (value.schemaVersion !== 1 || !Array.isArray(value.gates)) {
        throw new Error("Malformed gate registry: expected schemaVersion 1 and a gates array");
    }
    const gates = value.gates.map((gate, index) => parseGate(gate, index));
    const ids = new Set();
    for (const gate of gates) {
        if (ids.has(gate.id))
            throw new Error(`Duplicate gate registry id: ${gate.id}`);
        ids.add(gate.id);
    }
    return gates;
}
function parseGate(value, index) {
    const label = `gate registry entry ${index}`;
    if (!isRecord(value))
        throw new Error(`Malformed ${label}`);
    assertExactKeys(value, ["id", "program", "args", "timeoutMs"], label);
    if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.id)) {
        throw new Error(`Malformed ${label}: invalid id`);
    }
    if (typeof value.program !== "string" ||
        value.program.length === 0 ||
        !isAbsolute(value.program) ||
        !existsSync(value.program)) {
        throw new Error(`Malformed ${label}: program must be an existing absolute path`);
    }
    if (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string")) {
        throw new Error(`Malformed ${label}: args must be an array of strings`);
    }
    if (!Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 1 || Number(value.timeoutMs) > 300_000) {
        throw new Error(`Malformed ${label}: timeoutMs must be an integer from 1 to 300000`);
    }
    return {
        id: value.id,
        program: value.program,
        args: value.args,
        timeoutMs: Number(value.timeoutMs),
    };
}
function assertExactKeys(record, allowed, label) {
    const allowedSet = new Set(allowed);
    const unexpected = Object.keys(record).filter((key) => !allowedSet.has(key));
    const missing = allowed.filter((key) => !(key in record));
    if (unexpected.length > 0) {
        throw new Error(`Malformed ${label}: unexpected fields: ${unexpected.join(", ")}`);
    }
    if (missing.length > 0) {
        throw new Error(`Malformed ${label}: missing fields: ${missing.join(", ")}`);
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
