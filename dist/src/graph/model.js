import { isRecord } from "../control/model.js";
const authorityByKind = {
    agent: "broker",
    broker: "broker",
    gate: "oracle",
    join: "scheduler",
    human: "human",
};
export function parseExecutionGraph(value) {
    if (!isRecord(value) || value.schemaVersion !== 1) {
        throw new Error("Unsupported execution graph schema");
    }
    assertExactKeys(value, ["schemaVersion", "graphId", "revision", "schedulerAuthorityId", "nodes", "edges"], "graph");
    if (!Number.isInteger(value.revision) || Number(value.revision) < 1) {
        throw new Error("Graph revision must be a positive integer");
    }
    if (!Array.isArray(value.nodes) || value.nodes.length === 0 || !Array.isArray(value.edges)) {
        throw new Error("Execution graph requires nodes and edges arrays");
    }
    const nodes = value.nodes.map(parseNode);
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
        schemaVersion: 1,
        graphId: requireString(value, "graphId"),
        revision: Number(value.revision),
        schedulerAuthorityId: requireString(value, "schedulerAuthorityId"),
        nodes,
        edges,
    };
}
function parseNode(value, index) {
    if (!isRecord(value))
        throw new Error(`Invalid graph node at index ${index}`);
    assertExactKeys(value, [
        "id",
        "title",
        "kind",
        "activation",
        "completionAuthority",
        "completionAuthorityId",
        "executor",
    ], `node[${index}]`, ["executor"]);
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
    if (kind === "agent") {
        if (!isRecord(value.executor))
            throw new Error(`Agent node ${requireString(value, "id")} requires executor`);
        assertExactKeys(value.executor, ["adapter", "persona"], `node[${index}].executor`);
        executor = {
            adapter: requireString(value.executor, "adapter"),
            persona: requireString(value.executor, "persona"),
        };
    }
    else if (value.executor !== undefined) {
        throw new Error(`Only agent nodes may define an executor`);
    }
    return {
        id: requireString(value, "id"),
        title: requireString(value, "title"),
        kind,
        activation: requireEnum(value, "activation", ["all", "any"]),
        completionAuthority,
        completionAuthorityId: requireString(value, "completionAuthorityId"),
        ...(executor ? { executor } : {}),
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
