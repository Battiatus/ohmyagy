import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectGraph } from "../graph/kernel.js";
import { appendGraphTransition, loadGraphRuntime, verifyGraphStore, } from "../graph/store.js";
import { sha256 } from "../ledger/canonical.js";
export function resumeMission(options) {
    const root = resolve(options.workspaceRoot);
    const schedulerId = options.schedulerId ?? "oma-scheduler";
    const worktreesDir = join(root, ".oma", "worktrees");
    // 1. Load and verify graph runtime
    const runtime = loadGraphRuntime(root);
    const verification = verifyGraphStore(runtime);
    if (!verification.valid) {
        throw new Error(`Cannot resume corrupt graph store: ${verification.errors.join("; ")}`);
    }
    // 2. Project current state
    const projection = projectGraph(runtime.graph, verification.events);
    // 3. Identify zombie nodes (dispatched/running but not completed)
    const runningNodes = projection.nodes.filter((n) => n.state === "running");
    const recoveredNodes = [];
    // For any running node, record a failure transition to free it for rescheduling
    for (const node of runningNodes) {
        const targetNode = runtime.graph.nodes.find((n) => n.id === node.id);
        const dispatchId = node.dispatchId ?? `resume-cleanup-${node.id}-${Date.now()}`;
        appendGraphTransition(runtime, {
            eventType: "node_completed",
            nodeId: node.id,
            dispatchId,
            outcome: "failure",
            authority: targetNode?.completionAuthority ?? "broker",
            authorityId: targetNode?.completionAuthorityId ?? schedulerId,
            evidenceHash: sha256(`crash-recovery-${node.id}-${Date.now()}`),
        });
        recoveredNodes.push(node.id);
    }
    // 4. Clean orphan worktrees
    const cleanedWorktrees = [];
    if (existsSync(worktreesDir)) {
        const entries = readdirSync(worktreesDir);
        for (const entry of entries) {
            const fullPath = join(worktreesDir, entry);
            try {
                rmSync(fullPath, { recursive: true, force: true });
                cleanedWorktrees.push(entry);
            }
            catch {
                // Continue cleanup
            }
        }
    }
    // 5. Re-project graph to obtain fresh readySet
    const freshRuntime = loadGraphRuntime(root);
    const freshVerification = verifyGraphStore(freshRuntime);
    const freshProjection = projectGraph(freshRuntime.graph, freshVerification.events);
    const retainedCompletedNodes = freshProjection.nodes
        .filter((n) => n.state === "succeeded")
        .map((n) => n.id);
    const epochId = `epoch-${Date.now()}`;
    return {
        graphId: freshRuntime.graph.graphId,
        revision: freshRuntime.graph.revision,
        recoveredNodes,
        retainedCompletedNodes,
        currentReadySet: freshProjection.readySet,
        cleanedWorktrees,
        epochId,
        resumable: freshProjection.readySet.length > 0 ||
            freshProjection.status === "succeeded" ||
            freshProjection.status === "ready",
    };
}
