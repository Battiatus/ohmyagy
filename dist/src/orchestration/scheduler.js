import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectGraph } from "../graph/kernel.js";
import { appendGraphTransition, loadGraphRuntime, verifyGraphStore, } from "../graph/store.js";
import { AgyDriver } from "../runtime/agy-driver.js";
import { sha256 } from "../ledger/canonical.js";
import { WorktreePool } from "./worktree-pool.js";
export class ParallelScheduler {
    workspaceRoot;
    maxConcurrency;
    driver;
    worktreePool;
    schedulerId;
    worktreesDir;
    activeScopeLocks = new Set();
    constructor(options) {
        this.workspaceRoot = resolve(options.workspaceRoot);
        this.maxConcurrency = options.maxConcurrency ?? 4;
        this.driver = options.driver ?? new AgyDriver();
        this.schedulerId = options.schedulerId ?? "oma-scheduler";
        this.worktreesDir = join(this.workspaceRoot, ".oma", "worktrees");
        this.worktreePool = options.worktreePool ?? new WorktreePool({ workspaceRoot: this.workspaceRoot });
    }
    getActiveScopeLocks() {
        return this.activeScopeLocks;
    }
    async run() {
        const startTime = Date.now();
        const taskSummaries = [];
        const activeDispatches = new Map();
        if (!existsSync(this.worktreesDir)) {
            mkdirSync(this.worktreesDir, { recursive: true });
        }
        try {
            while (true) {
                const runtime = loadGraphRuntime(this.workspaceRoot);
                const verification = verifyGraphStore(runtime);
                if (!verification.valid) {
                    throw new Error(`Graph store invalid before schedule cycle: ${verification.errors.join("; ")}`);
                }
                const projection = projectGraph(runtime.graph, verification.events);
                const readyNodes = projection.readySet.filter((nodeId) => !activeDispatches.has(nodeId));
                // If no tasks are ready and no dispatches are active, we are finished
                if (readyNodes.length === 0 && activeDispatches.size === 0) {
                    const completedNodes = projection.nodes
                        .filter((n) => n.state === "succeeded")
                        .map((n) => n.id);
                    const failedNodes = projection.nodes
                        .filter((n) => n.state === "failed")
                        .map((n) => n.id);
                    return {
                        graphId: runtime.graph.graphId,
                        finalRevision: runtime.graph.revision,
                        completedNodes,
                        failedNodes,
                        totalDurationMs: Date.now() - startTime,
                        taskSummaries,
                        success: failedNodes.length === 0,
                    };
                }
                // Launch ready tasks up to concurrency limit, respecting file scope exclusivity
                for (const nodeId of readyNodes) {
                    if (activeDispatches.size >= this.maxConcurrency) {
                        break;
                    }
                    const node = runtime.graph.nodes.find((n) => n.id === nodeId);
                    if (!node)
                        continue;
                    const nodeScope = node.scope ?? [];
                    const hasScopeConflict = nodeScope.some((file) => this.activeScopeLocks.has(file));
                    if (hasScopeConflict) {
                        // Task has conflicting file scope with an actively running task; defer dispatch
                        continue;
                    }
                    // Acquire scope locks for this node
                    for (const file of nodeScope) {
                        this.activeScopeLocks.add(file);
                    }
                    const dispatchId = `disp-${nodeId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                    // Register node_dispatched in graph
                    appendGraphTransition(runtime, {
                        eventType: "node_dispatched",
                        nodeId,
                        dispatchId,
                        authorityId: this.schedulerId,
                    });
                    // Launch dispatch promise
                    const taskPromise = this.executeTaskNode(runtime, node, dispatchId);
                    activeDispatches.set(nodeId, taskPromise);
                }
                // If tasks are active, await the first one to finish
                if (activeDispatches.size > 0) {
                    const finishedNodeId = await Promise.race(Array.from(activeDispatches.entries()).map(async ([nodeId, promise]) => {
                        await promise;
                        return nodeId;
                    }));
                    const summary = await activeDispatches.get(finishedNodeId);
                    activeDispatches.delete(finishedNodeId);
                    taskSummaries.push(summary);
                    // Release scope locks for completed task
                    const finishedNode = runtime.graph.nodes.find((n) => n.id === summary.nodeId);
                    for (const file of finishedNode?.scope ?? []) {
                        this.activeScopeLocks.delete(file);
                    }
                    // Record completion event in graph
                    const freshRuntime = loadGraphRuntime(this.workspaceRoot);
                    const node = freshRuntime.graph.nodes.find((n) => n.id === summary.nodeId);
                    appendGraphTransition(freshRuntime, {
                        eventType: "node_completed",
                        nodeId: summary.nodeId,
                        dispatchId: summary.dispatchId,
                        outcome: summary.status === "succeeded" ? "success" : "failure",
                        authority: node?.completionAuthority ?? "broker",
                        authorityId: node?.completionAuthorityId ?? this.schedulerId,
                        evidenceHash: summary.evidenceHash,
                    });
                }
            }
        }
        finally {
            // Ensure all scope locks are cleared and purge any leftover orphan worktrees
            this.activeScopeLocks.clear();
            try {
                await this.worktreePool.purgeOrphans();
            }
            catch {
                // Safe skip on shutdown
            }
        }
    }
    async executeTaskNode(runtime, node, dispatchId) {
        const taskStartTime = Date.now();
        // If node is join or human, complete immediately without worktree
        if (node.kind === "join" || node.kind === "human") {
            return {
                nodeId: node.id,
                dispatchId,
                status: "succeeded",
                durationMs: Date.now() - taskStartTime,
                evidenceHash: sha256(`join-${node.id}-${dispatchId}`),
            };
        }
        let worktreePath;
        try {
            // 1. Prepare isolated worktree via WorktreePool
            worktreePath = await this.worktreePool.acquire(node.id, "HEAD");
            // 2. Build task contract prompt
            const contractPayload = JSON.stringify({
                nodeId: node.id,
                title: node.title,
                scope: node.scope ?? [],
                acceptance: node.acceptance ?? [],
                artifacts: node.artifacts ?? [],
                maxDiff: node.maxDiff,
            });
            // 3. Execute via Driver inside isolated worktree
            const executionResult = await this.driver.invoke({
                contractPrompt: contractPayload,
                persona: node.executor?.persona ?? "oma-executor",
                worktreeDir: worktreePath,
                timeoutMs: 60_000,
            });
            const success = executionResult.status === "success";
            const evidenceHash = sha256(JSON.stringify({
                nodeId: node.id,
                dispatchId,
                exitCode: executionResult.exitCode,
                stdoutHash: executionResult.stdoutHash,
                durationMs: executionResult.durationMs,
            }));
            return {
                nodeId: node.id,
                dispatchId,
                status: success ? "succeeded" : "failed",
                durationMs: Date.now() - taskStartTime,
                worktreePath,
                evidenceHash,
                error: executionResult.error,
            };
        }
        catch (err) {
            return {
                nodeId: node.id,
                dispatchId,
                status: "failed",
                durationMs: Date.now() - taskStartTime,
                worktreePath,
                evidenceHash: sha256(`error-${node.id}-${dispatchId}`),
                error: err instanceof Error ? err.message : String(err),
            };
        }
        finally {
            // Release and clean up worktree
            try {
                await this.worktreePool.release(node.id, true);
            }
            catch {
                // Safe skip on cleanup failure
            }
        }
    }
}
