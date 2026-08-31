import { resolve } from "node:path";
import { projectGraph } from "../graph/kernel.js";
import { appendGraphTransition, loadGraphRuntime, verifyGraphStore, } from "../graph/store.js";
import { sha256 } from "../ledger/canonical.js";
import { WorktreePool } from "../orchestration/worktree-pool.js";
export class DeterministicResumeEngine {
    workspaceRoot;
    schedulerId;
    targetEpoch;
    worktreePool;
    constructor(options) {
        this.workspaceRoot = resolve(options.workspaceRoot);
        this.schedulerId = options.schedulerId ?? "oma-scheduler";
        this.targetEpoch = options.targetEpoch;
        this.worktreePool = options.worktreePool ?? new WorktreePool({ workspaceRoot: this.workspaceRoot });
    }
    static async resume(options) {
        const engine = new DeterministicResumeEngine(options);
        return engine.resume();
    }
    async resume() {
        // 1. Load and verify graph store
        const runtime = loadGraphRuntime(this.workspaceRoot);
        const verification = verifyGraphStore(runtime);
        if (!verification.valid) {
            throw new Error(`Cannot resume corrupt or invalid graph store: ${verification.errors.join("; ")}`);
        }
        // 2. Derive activeEpoch monotonically from event ledger
        let maxObservedEpoch = 0;
        for (const event of verification.events) {
            const match = event.dispatchId?.match(/epoch-(\d+)/) ||
                (event.eventType === "node_completed" ? event.evidenceHash?.match(/epoch-(\d+)/) : null);
            if (match) {
                const epochNum = parseInt(match[1], 10);
                if (!isNaN(epochNum) && epochNum > maxObservedEpoch) {
                    maxObservedEpoch = epochNum;
                }
            }
        }
        const activeEpoch = this.targetEpoch !== undefined
            ? Math.max(this.targetEpoch, maxObservedEpoch + 1)
            : maxObservedEpoch + 1;
        // 3. Project current state to detect zombie tasks
        const initialProjection = projectGraph(runtime.graph, verification.events);
        const runningNodes = initialProjection.nodes.filter((n) => n.state === "running");
        const purgedZombies = [];
        const inFlightResumed = [];
        // 4. Terminate in-flight zombie tasks with monotonic epoch fencing
        for (const node of runningNodes) {
            const targetNode = runtime.graph.nodes.find((n) => n.id === node.id);
            const dispatchId = node.dispatchId ?? `resume-epoch-${activeEpoch}-${node.id}-${Date.now()}`;
            appendGraphTransition(runtime, {
                eventType: "node_completed",
                nodeId: node.id,
                dispatchId,
                outcome: "failure",
                authority: targetNode?.completionAuthority ?? "broker",
                authorityId: targetNode?.completionAuthorityId ?? this.schedulerId,
                evidenceHash: sha256(`crash-recovery-epoch-${activeEpoch}-${node.id}-${dispatchId}`),
            });
            purgedZombies.push(node.id);
            inFlightResumed.push(node.id);
        }
        // 5. Purge orphaned worktrees
        await this.worktreePool.purgeOrphans();
        // 6. Re-project graph to obtain exact fresh readySet
        const freshRuntime = loadGraphRuntime(this.workspaceRoot);
        const freshVerification = verifyGraphStore(freshRuntime);
        if (!freshVerification.valid) {
            throw new Error(`Graph store verification failed after resume transitions: ${freshVerification.errors.join("; ")}`);
        }
        const freshProjection = projectGraph(freshRuntime.graph, freshVerification.events);
        return {
            restoredRevision: freshRuntime.graph.revision,
            activeEpoch,
            readySet: freshProjection.readySet,
            inFlightResumed,
            purgedZombies,
        };
    }
}
