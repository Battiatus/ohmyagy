import { isRecord } from "../ledger/canonical.js";
const authorityByKind = {
    agent: "broker",
    broker: "broker",
    gate: "oracle",
    join: "scheduler",
    human: "human",
};
export function parseExecutionGraph(value) {
    if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
        throw new Error("Unsupported execution graph schema");
    }
    const schemaVersion = value.schemaVersion;
    assertExactKeys(value, ["schemaVersion", "graphId", "revision", "schedulerAuthorityId", "nodes", "edges"], "graph");
    if (!Number.isInteger(value.revision) || Number(value.revision) < 1) {
        throw new Error("Graph revision must be a positive integer");
    }
    if (!Array.isArray(value.nodes) || value.nodes.length === 0 || !Array.isArray(value.edges)) {
        throw new Error("Execution graph requires nodes and edges arrays");
    }
    const nodes = value.nodes.map((node, index) => parseNode(node, index, schemaVersion));
    const edges = value.edges.map(parseEdge);
    assertUnique(nodes.map((node) => node.id), "node");
    assertUnique(edges.map((edge) => edge.id), "edge");
    const nodeIds = new Set(nodes.map((node) => node.id));
    for (const edge of edges) {
        if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
            throw new Error(`Edge ${edge.id} references an unknown node`);
        }
        if (edge.from === edge.to) {
            throw new Error(`Self-loop is forbidden: ${edge.id}`);
        }
    }
    assertAcyclic(nodes, edges);
    return {
        schemaVersion,
        graphId: requireString(value, "graphId"),
        revision: Number(value.revision),
        schedulerAuthorityId: requireString(value, "schedulerAuthorityId"),
        nodes,
        edges,
    };
}
function parseNode(value, index, schemaVersion) {
    if (!isRecord(value))
        throw new Error(`Invalid graph node at index ${index}`);
    const contractFields = ["scope", "acceptance", "artifacts", "maxDiff"];
    assertExactKeys(value, [
        "id",
        "title",
        "kind",
        "activation",
        "completionAuthority",
        "completionAuthorityId",
        "executor",
        ...(schemaVersion === 2 ? contractFields : []),
    ], `node[${index}]`, ["executor", ...(schemaVersion === 2 ? contractFields : [])]);
    const kind = requireEnum(value, "kind", ["agent", "broker", "gate", "join", "human"]);
    const completionAuthority = requireEnum(value, "completionAuthority", [
        "broker",
        "oracle",
        "scheduler",
        "human",
    ]);
    if (completionAuthority !== authorityByKind[kind]) {
        throw new Error(`Node ${requireString(value, "id")} requires ${authorityByKind[kind]} authority`);
    }
    let executor;
    let scope;
    let acceptance;
    let artifacts;
    let maxDiff;
    if (kind === "agent") {
        if (!isRecord(value.executor))
            throw new Error(`Agent node ${requireString(value, "id")} requires executor`);
        assertExactKeys(value.executor, ["adapter", "persona"], `node[${index}].executor`);
        executor = {
            adapter: requireString(value.executor, "adapter"),
            persona: requireString(value.executor, "persona"),
        };
        if (schemaVersion === 2) {
            if ("scope" in value)
                scope = parseRepoPaths(value.scope, `node[${index}].scope`);
            if ("acceptance" in value) {
                acceptance = parseNodeAcceptance(value.acceptance, `node[${index}].acceptance`);
            }
            if ("artifacts" in value) {
                artifacts = parseRepoPaths(value.artifacts, `node[${index}].artifacts`);
            }
            if ("maxDiff" in value)
                maxDiff = parseNodeMaxDiff(value.maxDiff, `node[${index}].maxDiff`);
        }
    }
    else if (value.executor !== undefined) {
        throw new Error(`Only agent nodes may define an executor`);
    }
    if (kind !== "agent") {
        for (const field of ["scope", "acceptance", "artifacts", "maxDiff"]) {
            if (field in value)
                throw new Error(`Only agent nodes may define ${field}`);
        }
    }
    return {
        id: requireString(value, "id"),
        title: requireString(value, "title"),
        kind,
        activation: requireEnum(value, "activation", ["all", "any"]),
        completionAuthority,
        completionAuthorityId: requireString(value, "completionAuthorityId"),
        ...(executor ? { executor } : {}),
        ...(scope ? { scope } : {}),
        ...(acceptance ? { acceptance } : {}),
        ...(artifacts ? { artifacts } : {}),
        ...(maxDiff ? { maxDiff } : {}),
    };
}
function parseRepoPaths(value, label) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${label} must be a non-empty array`);
    }
    return value.map((entry, index) => {
        if (typeof entry !== "string" || entry.length === 0) {
            throw new Error(`Expected non-empty ${label}[${index}]`);
        }
        if (entry.includes("\0"))
            throw new Error(`${label}[${index}] must not contain NUL bytes`);
        if (entry.includes("\\"))
            throw new Error(`${label}[${index}] must use forward slashes`);
        if (entry.startsWith("/") || /^[A-Za-z]:/u.test(entry)) {
            throw new Error(`${label}[${index}] must be repo-relative`);
        }
        if (entry.split("/").includes("..")) {
            throw new Error(`${label}[${index}] must not contain .. segments`);
        }
        return entry;
    });
}
function parseNodeAcceptance(value, label) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${label} must be a non-empty array`);
    }
    const acceptance = value.map((entry, index) => {
        const entryLabel = `${label}[${index}]`;
        if (!isRecord(entry))
            throw new Error(`Invalid ${entryLabel}`);
        assertExactKeys(entry, ["id", "description", "gateId"], entryLabel);
        const gateId = requireString(entry, "gateId");
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(gateId)) {
            throw new Error(`${entryLabel}.gateId must match /^[a-z0-9][a-z0-9-]{0,63}$/`);
        }
        return {
            id: requireString(entry, "id"),
            description: requireString(entry, "description"),
            gateId,
        };
    });
    assertUnique(acceptance.map((entry) => entry.id), "acceptance");
    return acceptance;
}
function parseNodeMaxDiff(value, label) {
    if (!isRecord(value))
        throw new Error(`Invalid ${label}`);
    assertExactKeys(value, ["files", "lines"], label);
    return {
        files: requirePositiveInteger(value, "files"),
        lines: requirePositiveInteger(value, "lines"),
    };
}
function parseEdge(value, index) {
    if (!isRecord(value))
        throw new Error(`Invalid graph edge at index ${index}`);
    assertExactKeys(value, ["id", "from", "to", "when"], `edge[${index}]`);
    return {
        id: requireString(value, "id"),
        from: requireString(value, "from"),
        to: requireString(value, "to"),
        when: requireEnum(value, "when", ["success", "failure", "always"]),
    };
}
export function parseGraphEvent(value) {
    if (!isRecord(value))
        throw new Error("Invalid graph event");
    const eventType = requireEnum(value, "eventType", ["node_dispatched", "node_completed"]);
    const base = {
        sequence: requirePositiveInteger(value, "sequence"),
        timestamp: requireString(value, "timestamp"),
        graphId: requireString(value, "graphId"),
        graphRevision: requirePositiveInteger(value, "graphRevision"),
        graphHash: requireSha256(value, "graphHash"),
        nodeId: requireString(value, "nodeId"),
        dispatchId: requireString(value, "dispatchId"),
        authority: requireEnum(value, "authority", ["broker", "oracle", "scheduler", "human"]),
        authorityId: requireString(value, "authorityId"),
        previousHash: requireSha256(value, "previousHash"),
        eventHash: requireSha256(value, "eventHash"),
    };
    if (eventType === "node_dispatched") {
        assertExactKeys(value, [...Object.keys(base), "eventType"], "node_dispatched event");
        return { ...base, eventType };
    }
    assertExactKeys(value, [...Object.keys(base), "eventType", "outcome", "evidenceHash"], "node_completed event");
    return {
        ...base,
        eventType,
        outcome: requireEnum(value, "outcome", ["success", "failure"]),
        evidenceHash: requireSha256(value, "evidenceHash"),
    };
}
export function topologicalNodeIds(graph) {
    const incomingCount = new Map(graph.nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(graph.nodes.map((node) => [node.id, []]));
    for (const edge of graph.edges) {
        incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
        outgoing.get(edge.from)?.push(edge.to);
    }
    const ready = [...incomingCount.entries()]
        .filter(([, count]) => count === 0)
        .map(([id]) => id)
        .sort();
    const ordered = [];
    while (ready.length > 0) {
        const id = ready.shift();
        if (!id)
            break;
        ordered.push(id);
        for (const child of [...(outgoing.get(id) ?? [])].sort()) {
            const next = (incomingCount.get(child) ?? 0) - 1;
            incomingCount.set(child, next);
            if (next === 0) {
                ready.push(child);
                ready.sort();
            }
        }
    }
    if (ordered.length !== graph.nodes.length)
        throw new Error("Execution graph contains a cycle");
    return ordered;
}
function assertAcyclic(nodes, edges) {
    topologicalNodeIds({
        schemaVersion: 1,
        graphId: "validation",
        revision: 1,
        schedulerAuthorityId: "validation-scheduler",
        nodes,
        edges,
    });
}
function requireString(record, key) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0)
        throw new Error(`Expected non-empty ${key}`);
    return value;
}
function requirePositiveInteger(record, key) {
    const value = record[key];
    if (!Number.isInteger(value) || Number(value) < 1)
        throw new Error(`Expected positive integer ${key}`);
    return Number(value);
}
function requireSha256(record, key) {
    const value = requireString(record, key);
    if (!/^[a-f0-9]{64}$/u.test(value))
        throw new Error(`${key} must be a SHA-256 hex digest`);
    return value;
}
function requireEnum(record, key, values) {
    const value = record[key];
    if (typeof value !== "string" || !values.includes(value)) {
        throw new Error(`Invalid ${key}: ${String(value)}`);
    }
    return value;
}
function assertUnique(values, label) {
    const seen = new Set();
    for (const value of values) {
        if (seen.has(value))
            throw new Error(`Duplicate ${label} id: ${value}`);
        seen.add(value);
    }
}
function assertExactKeys(record, allowed, label, optional = []) {
    const allowedSet = new Set(allowed);
    const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
    if (unknown.length > 0)
        throw new Error(`${label} contains unexpected fields: ${unknown.join(", ")}`);
    const optionalSet = new Set(optional);
    const missing = allowed.filter((key) => !optionalSet.has(key) && !(key in record));
    if (missing.length > 0)
        throw new Error(`${label} is missing fields: ${missing.join(", ")}`);
}
