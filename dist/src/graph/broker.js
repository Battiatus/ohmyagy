import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hashJson } from "../ledger/canonical.js";
import { JournalStore } from "../ledger/journal-store.js";
import { parseExecutionGraph } from "./model.js";
import { projectGraph } from "./kernel.js";
import { parseGraphProposal, ProposalValidationError, } from "./proposal.js";
import { graphPaths } from "./store.js";
export class GraphBrokerError extends Error {
    code;
    diagnostics;
    cyclePath;
    constructor(code, message, diagnostics = [], cyclePath) {
        super(message);
        this.code = code;
        this.diagnostics = diagnostics;
        this.cyclePath = cyclePath;
        this.name = "GraphBrokerError";
    }
}
/**
 * Executes Kahn's Algorithm in O(V+E) to verify acyclicity.
 * If cycles are present, extracts the exact offending cycle path via 3-color DFS.
 */
export function validateKahnAcyclicity(nodes, edges) {
    const nodeIds = new Set(nodes.map((n) => n.id));
    const inDegree = new Map();
    const adjacency = new Map();
    const edgeLookup = new Map();
    for (const node of nodes) {
        inDegree.set(node.id, 0);
        adjacency.set(node.id, []);
        edgeLookup.set(node.id, []);
    }
    // 1. Detect immediate self-loops and unknown node references
    for (const edge of edges) {
        if (edge.from === edge.to) {
            return {
                valid: false,
                code: "SELF_LOOP_FORBIDDEN",
                topologicalOrder: [],
                cyclePath: [edge.from, edge.to],
                error: `Self-loop strictly forbidden on node: "${edge.from}" (edge: "${edge.id}")`,
                offendingEdges: [edge],
            };
        }
        if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
            const missing = !nodeIds.has(edge.from) ? edge.from : edge.to;
            return {
                valid: false,
                code: "INVALID_EDGE",
                topologicalOrder: [],
                error: `Edge "${edge.id}" references unknown node (${edge.from} -> ${edge.to}, missing "${missing}")`,
                offendingEdges: [edge],
            };
        }
        inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
        adjacency.get(edge.from).push(edge.to);
        edgeLookup.get(edge.from).push(edge);
    }
    // 2. Collect 0-inDegree nodes (sorted alphabetically for determinism)
    const queue = [];
    for (const [nodeId, deg] of inDegree.entries()) {
        if (deg === 0)
            queue.push(nodeId);
    }
    queue.sort();
    const topologicalOrder = [];
    while (queue.length > 0) {
        const current = queue.shift();
        topologicalOrder.push(current);
        const neighbors = [...(adjacency.get(current) ?? [])].sort();
        for (const neighbor of neighbors) {
            const updated = (inDegree.get(neighbor) ?? 1) - 1;
            inDegree.set(neighbor, updated);
            if (updated === 0) {
                queue.push(neighbor);
                queue.sort();
            }
        }
    }
    // 3. Cycle Detection and Path Extraction via 3-color DFS
    if (topologicalOrder.length !== nodes.length) {
        const cycleCandidates = nodes
            .filter((n) => !topologicalOrder.includes(n.id))
            .map((n) => n.id);
        const cyclePath = extractExactCyclePath(new Set(cycleCandidates), adjacency);
        const offendingEdges = [];
        for (let i = 0; i < cyclePath.length - 1; i++) {
            const u = cyclePath[i];
            const v = cyclePath[i + 1];
            const matching = (edgeLookup.get(u) ?? []).filter((e) => e.to === v);
            offendingEdges.push(...matching);
        }
        return {
            valid: false,
            code: "CYCLE_DETECTED",
            topologicalOrder: [],
            cyclePath,
            error: `Mathematical cycle detected in extended DAG: ${cyclePath.join(" -> ")}`,
            offendingEdges,
        };
    }
    return {
        valid: true,
        topologicalOrder,
    };
}
/**
 * 3-color DFS to extract minimal deterministic cycle path.
 */
function extractExactCyclePath(unvisitedNodes, adjacency) {
    const COLOR_WHITE = 0;
    const COLOR_GRAY = 1;
    const COLOR_BLACK = 2;
    const color = new Map();
    for (const node of unvisitedNodes) {
        color.set(node, COLOR_WHITE);
    }
    const stack = [];
    function dfs(u) {
        color.set(u, COLOR_GRAY);
        stack.push(u);
        const neighbors = (adjacency.get(u) ?? []).filter((v) => unvisitedNodes.has(v));
        neighbors.sort();
        for (const v of neighbors) {
            const vColor = color.get(v) ?? COLOR_WHITE;
            if (vColor === COLOR_GRAY) {
                const startIndex = stack.indexOf(v);
                return [...stack.slice(startIndex), v];
            }
            if (vColor === COLOR_WHITE) {
                const result = dfs(v);
                if (result !== null)
                    return result;
            }
        }
        stack.pop();
        color.set(u, COLOR_BLACK);
        return null;
    }
    const sortedCandidates = [...unvisitedNodes].sort();
    for (const candidate of sortedCandidates) {
        if ((color.get(candidate) ?? COLOR_WHITE) === COLOR_WHITE) {
            const path = dfs(candidate);
            if (path !== null)
                return path;
        }
    }
    return sortedCandidates.length > 0 ? [sortedCandidates[0], sortedCandidates[0]] : [];
}
export class GraphBroker {
    root;
    maxTotalNodes;
    maxDagDepth;
    maxFanOut;
    lockTimeoutMs;
    paths;
    _journalStore;
    constructor(rootOrOptions, options) {
        let resolvedRoot;
        let resolvedOptions = {};
        if (typeof rootOrOptions === "string") {
            resolvedRoot = rootOrOptions;
            resolvedOptions = options ?? {};
        }
        else {
            resolvedRoot = rootOrOptions.rootDir ?? rootOrOptions.root ?? process.cwd();
            resolvedOptions = rootOrOptions;
        }
        this.root = resolve(resolvedRoot);
        this.paths = graphPaths(this.root);
        this._journalStore = resolvedOptions.journalStore;
        this.maxTotalNodes = resolvedOptions.maxTotalNodes ?? 50;
        this.maxDagDepth = resolvedOptions.maxDagDepth ?? 10;
        this.maxFanOut = resolvedOptions.maxFanOut ?? 8;
        this.lockTimeoutMs = resolvedOptions.lockTimeoutMs ?? 5000;
    }
    get rootDir() {
        return this.root;
    }
    get journalStore() {
        if (this._journalStore)
            return this._journalStore;
        const ledgerDir = join(this.root, ".oma", "ledger");
        if (!existsSync(ledgerDir)) {
            mkdirSync(ledgerDir, { recursive: true });
        }
        const ledgerEvents = join(ledgerDir, "events.jsonl");
        return new JournalStore(ledgerEvents);
    }
    /**
     * Pure validation pipeline: validates a proposal against current graph and events
     * without mutating on-disk state.
     */
    async validateProposal(proposalInput) {
        let proposal;
        try {
            proposal = parseGraphProposal(proposalInput);
        }
        catch (err) {
            if (err instanceof ProposalValidationError) {
                return {
                    valid: false,
                    diagnostics: [
                        {
                            code: "CAS_CONFLICT",
                            message: `Proposal schema invalid: ${err.message}`,
                            details: { error: err.details },
                        },
                    ],
                };
            }
            throw err;
        }
        // 1. Load current graph from disk
        if (!existsSync(this.paths.definition)) {
            return {
                valid: false,
                diagnostics: [
                    {
                        code: "IO_ERROR",
                        message: `Execution graph definition not found at ${this.paths.definition}`,
                    },
                ],
            };
        }
        const rawGraph = JSON.parse(readFileSync(this.paths.definition, "utf8"));
        const currentGraph = parseExecutionGraph(rawGraph);
        const currentGraphHash = hashJson(rawGraph);
        // 2. Check CAS revision match
        const diagnostics = [];
        const expectedRevision = proposal.expectedRevision ?? proposal.parentRevision;
        if (expectedRevision !== currentGraph.revision) {
            diagnostics.push({
                code: "REVISION_MISMATCH",
                message: `Proposal expectedRevision (${expectedRevision}) does not match current graph revision (${currentGraph.revision}).`,
                details: { expected: expectedRevision, current: currentGraph.revision },
            });
            return { valid: false, diagnostics };
        }
        if (proposal.parentGraphHash && proposal.parentGraphHash !== currentGraphHash) {
            diagnostics.push({
                code: "PARENT_HASH_MISMATCH",
                message: `Proposal parentGraphHash (${proposal.parentGraphHash}) does not match current graph hash (${currentGraphHash}).`,
            });
            return { valid: false, diagnostics };
        }
        if (proposal.parentJournalHeadHash) {
            const head = this.journalStore.getHead();
            if (proposal.parentJournalHeadHash !== head.hash) {
                diagnostics.push({
                    code: "CAS_CONFLICT",
                    message: `Proposal parentJournalHeadHash (${proposal.parentJournalHeadHash}) does not match journal head (${head.hash}).`,
                });
                return { valid: false, diagnostics };
            }
        }
        // 3. Load historical events to project current state
        const historicalEvents = this.loadHistoricalEvents();
        let projection;
        try {
            projection = projectGraph(currentGraph, historicalEvents);
        }
        catch (err) {
            diagnostics.push({
                code: "IO_ERROR",
                message: `Failed to project current graph: ${err instanceof Error ? err.message : String(err)}`,
            });
            return { valid: false, diagnostics };
        }
        // 4. Construct candidate graph G_{N+1} = G_N ⊕ Delta/Operations
        const candidateNodes = [...currentGraph.nodes];
        const candidateEdges = [...currentGraph.edges];
        const nodeMap = new Map(candidateNodes.map((n) => [n.id, n]));
        const edgeMap = new Map(candidateEdges.map((e) => [e.id, e]));
        let nodesAdded = 0;
        let edgesAdded = 0;
        let edgesRemoved = 0;
        // Apply delta operations
        const operations = proposal.operations
            ? [...proposal.operations]
            : proposal.delta
                ? [
                    ...proposal.delta.nodesToAdd.map((node) => ({ type: "add_node", node })),
                    ...proposal.delta.edgesToAdd.map((edge) => ({ type: "add_edge", edge })),
                    ...(proposal.delta.edgesToDelete ?? []).map((edgeId) => ({
                        type: "remove_edge",
                        edge: { id: edgeId, from: "", to: "" },
                    })),
                ]
                : [];
        for (let i = 0; i < operations.length; i++) {
            const op = operations[i];
            if (op.type === "add_node") {
                if (nodeMap.has(op.node.id)) {
                    diagnostics.push({
                        code: "DUPLICATE_NODE_ID",
                        message: `Cannot add node "${op.node.id}": node already exists in graph.`,
                    });
                    continue;
                }
                // Anti-retry check: forbid disguised retries of failed node with identical ID
                const failedNode = projection.nodes.find((n) => n.id === op.node.id && n.state === "failed");
                if (failedNode) {
                    diagnostics.push({
                        code: "DISGUISED_RETRY_FORBIDDEN",
                        message: `Disguised retry forbidden for failed node "${op.node.id}". New nodes must have distinct IDs.`,
                    });
                }
                nodeMap.set(op.node.id, op.node);
                candidateNodes.push(op.node);
                nodesAdded++;
            }
            else if (op.type === "add_edge") {
                const edge = op.edge;
                if (edgeMap.has(edge.id)) {
                    diagnostics.push({
                        code: "INVALID_EDGE",
                        message: `Duplicate edge ID "${edge.id}".`,
                    });
                    continue;
                }
                // Terminal Node Mutation Check: Cannot create incoming edge to already completed/running node
                const targetNodeState = projection.nodes.find((n) => n.id === edge.to)?.state;
                if (targetNodeState && ["succeeded", "failed", "skipped", "running"].includes(targetNodeState)) {
                    diagnostics.push({
                        code: "TERMINAL_NODE_MUTATION",
                        message: `Cannot add incoming edge to terminal/active node "${edge.to}" (current state: ${targetNodeState}).`,
                        details: { edge, targetNodeState },
                    });
                }
                edgeMap.set(edge.id, edge);
                candidateEdges.push(edge);
                edgesAdded++;
            }
            else if (op.type === "remove_edge") {
                const targetEdge = candidateEdges.find((e) => (op.edge.id && e.id === op.edge.id) ||
                    (op.edge.from && op.edge.to && e.from === op.edge.from && e.to === op.edge.to));
                if (!targetEdge) {
                    const byId = op.edge.id ? candidateEdges.find((e) => e.id === op.edge.id) : undefined;
                    if (!byId) {
                        diagnostics.push({
                            code: "INVALID_EDGE",
                            message: `Cannot remove non-existent edge (${op.edge.id ?? `${op.edge.from} -> ${op.edge.to}`}).`,
                        });
                        continue;
                    }
                }
                const edgeToRemove = targetEdge ?? candidateEdges.find((e) => e.id === op.edge.id);
                // Forbid removing edges originating from or leading to completed nodes
                const targetNodeState = projection.nodes.find((n) => n.id === edgeToRemove.to)?.state;
                if (targetNodeState && ["succeeded", "failed", "running"].includes(targetNodeState)) {
                    diagnostics.push({
                        code: "TERMINAL_NODE_MUTATION",
                        message: `Cannot remove edge "${edgeToRemove.id}" leading to historical state node "${edgeToRemove.to}".`,
                    });
                }
                edgeMap.delete(edgeToRemove.id);
                const idx = candidateEdges.findIndex((e) => e.id === edgeToRemove.id);
                if (idx !== -1)
                    candidateEdges.splice(idx, 1);
                edgesRemoved++;
            }
        }
        // Check nodesToModify if delta was used
        if (proposal.delta?.nodesToModify) {
            for (const mod of proposal.delta.nodesToModify) {
                const state = projection.nodes.find((n) => n.id === mod.id)?.state;
                if (state && ["succeeded", "failed", "skipped", "running"].includes(state)) {
                    diagnostics.push({
                        code: "TERMINAL_NODE_MUTATION",
                        message: `Cannot modify node "${mod.id}" with status "${state}". Terminal/running nodes are immutable.`,
                        details: { nodeId: mod.id, state, attemptedMutation: mod },
                    });
                }
            }
        }
        // 5. Verify unknown node references
        for (const edge of candidateEdges) {
            if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) {
                const missing = !nodeMap.has(edge.from) ? edge.from : edge.to;
                diagnostics.push({
                    code: "UNKNOWN_NODE_REFERENCE",
                    message: `Edge "${edge.id}" references unknown node (${edge.from} -> ${edge.to}, missing "${missing}").`,
                });
            }
        }
        // 6. Acyclicity and Cycle Path Extraction via Kahn
        const kahn = validateKahnAcyclicity(candidateNodes, candidateEdges);
        if (!kahn.valid) {
            diagnostics.push({
                code: kahn.code ?? "CYCLE_DETECTED",
                message: kahn.error ?? "Cycle detected in proposed graph extension.",
                details: { cyclePath: kahn.cyclePath },
                cyclePath: kahn.cyclePath,
            });
            return {
                valid: false,
                diagnostics,
                cyclePath: kahn.cyclePath,
            };
        }
        // 7. Resource and Budget Guardrails
        if (candidateNodes.length > this.maxTotalNodes) {
            diagnostics.push({
                code: "RESOURCE_BUDGET_EXCEEDED",
                message: `Proposed graph exceeds maximum allowed nodes (${candidateNodes.length} > ${this.maxTotalNodes}).`,
            });
        }
        // Fan-out check
        const fanOutCount = new Map();
        for (const edge of candidateEdges) {
            const count = (fanOutCount.get(edge.from) ?? 0) + 1;
            fanOutCount.set(edge.from, count);
            if (count > this.maxFanOut) {
                diagnostics.push({
                    code: "MAX_FANOUT_EXCEEDED",
                    message: `Node "${edge.from}" exceeds maximum allowed fan-out (${count} > ${this.maxFanOut}).`,
                });
            }
        }
        // Depth check
        const dagDepth = this.computeDagDepth(candidateNodes, candidateEdges);
        if (dagDepth > this.maxDagDepth) {
            diagnostics.push({
                code: "MAX_DEPTH_EXCEEDED",
                message: `Proposed DAG depth (${dagDepth}) exceeds maximum allowed depth (${this.maxDagDepth}).`,
            });
        }
        // 8. Scope collision checks for parallel active nodes
        const scopeDiagnostics = this.checkScopeCollisions(candidateNodes, candidateEdges, projection);
        diagnostics.push(...scopeDiagnostics);
        if (diagnostics.length > 0) {
            return {
                valid: false,
                diagnostics,
            };
        }
        const proposedGraph = {
            schemaVersion: currentGraph.schemaVersion,
            graphId: currentGraph.graphId,
            revision: currentGraph.revision + 1,
            schedulerAuthorityId: currentGraph.schedulerAuthorityId,
            nodes: candidateNodes,
            edges: candidateEdges,
        };
        return {
            valid: true,
            diagnostics: [],
            proposedGraph,
            topologicalOrder: kahn.topologicalOrder,
            deltaSummary: {
                nodesAdded,
                edgesAdded,
                edgesRemoved,
            },
        };
    }
    /**
     * Applies the proposal with CAS atomicity, archiving the revision,
     * overwriting execution-graph.json and appending revision_published event to JournalStore.
     */
    async applyProposal(proposalInput) {
        return this.withExclusiveLock(async () => {
            // 0. Verify journal integrity before attempting CAS
            let integrity;
            try {
                integrity = this.journalStore.verifyIntegrity();
            }
            catch (err) {
                return {
                    success: false,
                    code: "JOURNAL_INTEGRITY_MISMATCH",
                    error: `Journal integrity verification failed: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
            if (!integrity.valid) {
                return {
                    success: false,
                    code: "JOURNAL_INTEGRITY_MISMATCH",
                    error: `Journal integrity verification failed: ${integrity.error ?? "corrupted hash chain"}`,
                };
            }
            // 1. Re-validate under exclusive file lock
            const validation = await this.validateProposal(proposalInput);
            if (!validation.valid || !validation.proposedGraph || !validation.deltaSummary) {
                const primaryError = validation.diagnostics[0];
                let code = primaryError?.code ?? "CAS_CONFLICT";
                if (code === "REVISION_MISMATCH" || code === "PARENT_HASH_MISMATCH") {
                    code = "CAS_CONFLICT";
                }
                return {
                    success: false,
                    code,
                    error: primaryError?.message ?? "Proposal validation failed under lock.",
                    diagnostics: validation.diagnostics,
                    cyclePath: validation.cyclePath,
                };
            }
            const proposal = parseGraphProposal(proposalInput);
            const newGraph = validation.proposedGraph;
            const newRevision = newGraph.revision;
            const expectedRevision = proposal.expectedRevision ?? proposal.parentRevision;
            // 2. Prepare paths and directories
            const revisionsDir = join(this.paths.graphDir, "revisions");
            mkdirSync(revisionsDir, { recursive: true });
            // Archive current revision (rev_{expectedRevision}.json) if missing
            const prevRevFile = join(revisionsDir, `rev_${expectedRevision}.json`);
            if (!existsSync(prevRevFile) && existsSync(this.paths.definition)) {
                const currentContent = readFileSync(this.paths.definition, "utf8");
                writeFileSync(prevRevFile, currentContent, "utf8");
            }
            // Write new revision archive file (rev_{newRevision}.json and padded version)
            const revFile = join(revisionsDir, `rev_${newRevision}.json`);
            const paddedRevFile = join(revisionsDir, `rev_${String(newRevision).padStart(3, "0")}.json`);
            const graphContent = `${JSON.stringify(newGraph, null, 2)}\n`;
            writeFileSync(revFile, graphContent, "utf8");
            writeFileSync(paddedRevFile, graphContent, "utf8");
            // 3. Atomically replace execution-graph.json using temp file + rename
            const tempFile = join(this.paths.graphDir, `execution-graph.tmp.${Date.now()}`);
            writeFileSync(tempFile, graphContent, "utf8");
            try {
                renameSync(tempFile, this.paths.definition);
            }
            catch (err) {
                // Fallback for Windows cross-device or permission race
                try {
                    unlinkSync(this.paths.definition);
                    renameSync(tempFile, this.paths.definition);
                }
                catch (innerErr) {
                    rmSync(tempFile, { force: true });
                    return {
                        success: false,
                        code: "IO_ERROR",
                        error: `Failed to atomically update execution-graph.json: ${err instanceof Error ? err.message : String(err)}`,
                    };
                }
            }
            const rawOldGraph = JSON.parse(readFileSync(prevRevFile, "utf8"));
            const previousGraphHash = proposal.parentGraphHash ?? hashJson(rawOldGraph);
            const newGraphHash = hashJson(newGraph);
            // 4. Append revision_published event to JournalStore (events.jsonl)
            const eventPayload = {
                eventType: "revision_published",
                timestamp: new Date().toISOString(),
                missionId: proposal.missionId ?? newGraph.graphId,
                graphId: newGraph.graphId,
                oldRevision: expectedRevision ?? newRevision - 1,
                previousRevision: expectedRevision ?? newRevision - 1,
                newRevision,
                previousGraphHash,
                newGraphHash,
                proposalId: proposal.proposalId,
                author: proposal.author ?? proposal.proposerPersona ?? "oma-planner",
                proposerPersona: proposal.proposerPersona ?? proposal.author ?? "oma-planner",
                reason: proposal.reason ?? proposal.rationale?.summary ?? "Dynamic workflow mutation",
                deltaSummary: validation.deltaSummary,
            };
            const chainedEvent = this.journalStore.appendEvent(eventPayload);
            // 5. Update head.json metadata
            if (existsSync(this.paths.head)) {
                try {
                    const currentHead = JSON.parse(readFileSync(this.paths.head, "utf8"));
                    const headPayload = {
                        ...currentHead,
                        lastRevision: newRevision,
                    };
                    writeFileSync(this.paths.head, `${JSON.stringify(headPayload, null, 2)}\n`, "utf8");
                }
                catch {
                    // Keep existing head format
                }
            }
            return {
                success: true,
                revision: newRevision,
                graphHash: newGraphHash,
                journalHeadHash: chainedEvent.eventHash,
                event: chainedEvent,
                graph: newGraph,
            };
        });
    }
    checkScopeCollisions(nodes, edges, projection) {
        const diagnostics = [];
        const nodeStateMap = new Map(projection.nodes.map((n) => [n.id, n.state]));
        const agentNodes = nodes.filter((n) => {
            if (n.kind !== "agent" || !n.scope || n.scope.length === 0)
                return false;
            const state = nodeStateMap.get(n.id);
            return !state || !["succeeded", "failed", "skipped"].includes(state);
        });
        if (agentNodes.length < 2)
            return diagnostics;
        // Build reachability map using BFS
        const reachable = new Map();
        const adjacency = new Map();
        for (const n of nodes) {
            reachable.set(n.id, new Set([n.id]));
            adjacency.set(n.id, []);
        }
        for (const e of edges) {
            adjacency.get(e.from)?.push(e.to);
            reachable.get(e.from)?.add(e.to);
        }
        // Floyd-Warshall / BFS transitive reachability
        for (const startNode of nodes) {
            const visited = reachable.get(startNode.id);
            const queue = [...(adjacency.get(startNode.id) ?? [])];
            for (const neighbor of queue)
                visited.add(neighbor);
            let head = 0;
            while (head < queue.length) {
                const curr = queue[head++];
                for (const nxt of adjacency.get(curr) ?? []) {
                    if (!visited.has(nxt)) {
                        visited.add(nxt);
                        queue.push(nxt);
                    }
                }
            }
        }
        // Check all unordered pairs of active agent nodes
        for (let i = 0; i < agentNodes.length; i++) {
            for (let j = i + 1; j < agentNodes.length; j++) {
                const nodeA = agentNodes[i];
                const nodeB = agentNodes[j];
                const hasCausalOrder = reachable.get(nodeA.id)?.has(nodeB.id) ||
                    reachable.get(nodeB.id)?.has(nodeA.id);
                if (!hasCausalOrder) {
                    // Check for overlapping scope paths
                    const conflictingPaths = [];
                    for (const pathA of nodeA.scope ?? []) {
                        for (const pathB of nodeB.scope ?? []) {
                            if (isPathOverlap(pathA, pathB)) {
                                conflictingPaths.push({ pathA, pathB });
                            }
                        }
                    }
                    if (conflictingPaths.length > 0) {
                        diagnostics.push({
                            code: "SCOPE_COLLISION_DETECTED",
                            message: `Parallel concurrent nodes "${nodeA.id}" and "${nodeB.id}" have overlapping file scopes without a causal dependency edge.`,
                            nodeA: nodeA.id,
                            nodeB: nodeB.id,
                            conflictingPaths,
                            remediationGuidance: `Add an ordering edge between "${nodeA.id}" and "${nodeB.id}" or partition scopes to be disjoint.`,
                        });
                    }
                }
            }
        }
        return diagnostics;
    }
    computeDagDepth(nodes, edges) {
        const inDegree = new Map(nodes.map((n) => [n.id, 0]));
        const outgoing = new Map(nodes.map((n) => [n.id, []]));
        for (const e of edges) {
            inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
            outgoing.get(e.from)?.push(e.to);
        }
        const depth = new Map(nodes.map((n) => [n.id, 1]));
        const queue = nodes.filter((n) => inDegree.get(n.id) === 0).map((n) => n.id);
        let maxDepth = 1;
        while (queue.length > 0) {
            const u = queue.shift();
            const currentDepth = depth.get(u) ?? 1;
            maxDepth = Math.max(maxDepth, currentDepth);
            for (const v of outgoing.get(u) ?? []) {
                const newD = Math.max(depth.get(v) ?? 1, currentDepth + 1);
                depth.set(v, newD);
                const updatedIn = (inDegree.get(v) ?? 1) - 1;
                inDegree.set(v, updatedIn);
                if (updatedIn === 0)
                    queue.push(v);
            }
        }
        return maxDepth;
    }
    loadHistoricalEvents() {
        if (!existsSync(this.paths.events))
            return [];
        const lines = readFileSync(this.paths.events, "utf8")
            .split(/\r?\n/u)
            .filter((l) => l.trim().length > 0);
        const events = [];
        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                if (parsed.eventType === "node_dispatched" || parsed.eventType === "node_completed") {
                    events.push(parsed);
                }
            }
            catch {
                // Skip non-node events in unified journal
            }
        }
        return events;
    }
    withExclusiveLock(action) {
        mkdirSync(dirname(this.paths.lock), { recursive: true });
        const startTime = Date.now();
        let fd;
        while (Date.now() - startTime < this.lockTimeoutMs) {
            try {
                fd = openSync(this.paths.lock, "wx");
                break;
            }
            catch {
                const sleepMs = 50;
                const waitUntil = Date.now() + sleepMs;
                while (Date.now() < waitUntil) {
                    // brief backoff
                }
            }
        }
        if (fd === undefined) {
            return Promise.resolve({
                success: false,
                code: "CAS_CONFLICT",
                error: `Could not acquire graph lock at ${this.paths.lock} within ${this.lockTimeoutMs}ms.`,
            });
        }
        try {
            const result = action();
            if (result instanceof Promise) {
                return result.finally(() => {
                    if (fd !== undefined)
                        closeSync(fd);
                    rmSync(this.paths.lock, { force: true });
                });
            }
            return Promise.resolve(result).finally(() => {
                if (fd !== undefined)
                    closeSync(fd);
                rmSync(this.paths.lock, { force: true });
            });
        }
        catch (err) {
            if (fd !== undefined)
                closeSync(fd);
            rmSync(this.paths.lock, { force: true });
            throw err;
        }
    }
}
export function isPathOverlap(pathA, pathB) {
    const normA = pathA.replace(/\/+$/u, "");
    const normB = pathB.replace(/\/+$/u, "");
    if (normA === normB)
        return true;
    if (normA.startsWith(normB + "/"))
        return true;
    if (normB.startsWith(normA + "/"))
        return true;
    return false;
}
