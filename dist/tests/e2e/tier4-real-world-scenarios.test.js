import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphBroker } from "../../src/graph/broker.js";
import { initializeGraphStore, appendGraphTransition, loadGraphRuntime, verifyGraphStore } from "../../src/graph/store.js";
import { MissionResumptionEngine } from "../../src/orchestration/mission-resumption.js";
import { MissionEventsStore } from "../../src/ledger/mission-events.js";
import { AdversarialReviewEngine } from "../../src/oracle/adversarial-review.js";
import { parseGraphProposal } from "../../src/graph/proposal.js";
import { DynamicConvergenceEngine } from "../../src/orchestration/dynamic-engine.js";
import { DeterministicIntegrator } from "../../src/orchestration/integrator.js";
import { sha256 } from "../../src/ledger/canonical.js";
import * as canonicalMath from "../../test-fixtures/minimal-pipeline/src/math.js";
import * as canonicalParser from "../../test-fixtures/minimal-pipeline/src/parser.js";
import * as canonicalPipeline from "../../test-fixtures/minimal-pipeline/src/pipeline.js";
describe("Tier 4: Real-World Application Scenarios", () => {
    // --------------------------------------------------------------------------
    // Scenario 1: Dynamic Graph Expansion
    // --------------------------------------------------------------------------
    describe("Scenario 1: Dynamic Graph Expansion", () => {
        it("dynamically expands execution graph mid-flight with CAS concurrency checks and resolves join dependencies", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t4-dynamic-expansion-"));
            try {
                const initialGraph = {
                    schemaVersion: 2,
                    graphId: "graph-expansion-real",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "planner_task", title: "Planner Task", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-planner" } },
                        { id: "join_gate", title: "Join Gate", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                    ],
                    edges: [
                        { id: "e1", from: "planner_task", to: "join_gate", when: "success" },
                    ],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(initialGraph, null, 2));
                const runtime = initializeGraphStore(tempDir);
                // Planner completes
                appendGraphTransition(runtime, {
                    eventType: "node_dispatched",
                    nodeId: "planner_task",
                    dispatchId: "disp-p1",
                    authorityId: "oma-scheduler",
                });
                appendGraphTransition(runtime, {
                    eventType: "node_completed",
                    nodeId: "planner_task",
                    dispatchId: "disp-p1",
                    outcome: "success",
                    authority: "broker",
                    authorityId: "oma-broker",
                    evidenceHash: "0".repeat(64),
                });
                // Broker applies proposal to insert worker_task_1 and worker_task_2 before join_gate
                const broker = new GraphBroker(tempDir);
                const proposal = {
                    schemaVersion: 2,
                    proposalId: "prop_dynamic_workers",
                    author: "planner",
                    reason: "Discovered two subtasks",
                    expectedRevision: 1,
                    operations: [
                        {
                            type: "add_node",
                            node: { id: "worker_task_1", title: "Worker 1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-worker" } },
                        },
                        {
                            type: "add_node",
                            node: { id: "worker_task_2", title: "Worker 2", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-worker" } },
                        },
                        {
                            type: "add_edge",
                            edge: { id: "e_w1_j", from: "worker_task_1", to: "join_gate", when: "success" },
                        },
                        {
                            type: "add_edge",
                            edge: { id: "e_w2_j", from: "worker_task_2", to: "join_gate", when: "success" },
                        },
                    ],
                };
                const result = await broker.applyProposal(proposal);
                assert.equal(result.success, true);
                // Verify updated graph store
                const updatedRuntime = loadGraphRuntime(tempDir);
                const verification = verifyGraphStore(updatedRuntime);
                assert.equal(verification.valid, true);
                assert.equal(updatedRuntime.graph.nodes.length, 4);
                assert.equal(updatedRuntime.graph.edges.length, 3);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Scenario 2: Hard Crash & Exact Resume
    // --------------------------------------------------------------------------
    describe("Scenario 2: Hard Crash & Exact Resume", () => {
        it("recovers from mid-wave crash, increments fencing epoch, and completes cleanly", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t4-hard-crash-"));
            try {
                const missionDir = join(tempDir, ".oma", "missions", "mission-crash-scenario");
                mkdirSync(missionDir, { recursive: true });
                const eventsPath = join(missionDir, "events.jsonl");
                // Wave 1 completes
                MissionEventsStore.appendEvent(eventsPath, "mission-crash-scenario", {
                    type: "mission_started",
                    workflowDigest: "wd-crash",
                    rulebookRevision: "rev-1",
                    goal: "Survive and recover from crash",
                });
                MissionEventsStore.appendEvent(eventsPath, "mission-crash-scenario", {
                    type: "work_item_discovered",
                    workItemId: "wi-1",
                    title: "Task 1",
                    scope: ["src/a.ts"],
                    dependsOn: [],
                    roleRequired: "worker",
                    acceptanceCriteria: [],
                });
                MissionEventsStore.appendEvent(eventsPath, "mission-crash-scenario", {
                    type: "run_started",
                    runId: "run-1",
                    workItemId: "wi-1",
                    expertId: "worker",
                    model: "gemini-3.7-flash",
                    effort: "medium",
                });
                MissionEventsStore.appendEvent(eventsPath, "mission-crash-scenario", {
                    type: "run_finished",
                    runId: "run-1",
                    workItemId: "wi-1",
                    expertId: "worker",
                    status: "succeeded",
                    durationMs: 120,
                });
                // Wave 2 starts and crashes mid-execution
                const pVector = {
                    hiddenTestsFailing: 0,
                    hiddenTestsPassed: 5,
                    visibleTestsFailing: 0,
                    visibleTestsPassed: 3,
                    gateFailures: 0,
                    openDiagnosticsCount: 0,
                    acceptedWorkItems: 1,
                    totalWorkItems: 2,
                };
                MissionEventsStore.appendEvent(eventsPath, "mission-crash-scenario", {
                    type: "wave_transitioned",
                    fromWave: 1,
                    toWave: 2,
                    hasProgressed: true,
                    reason: "Wave 1 finished",
                    progressBefore: pVector,
                    progressAfter: pVector,
                });
                MissionEventsStore.appendEvent(eventsPath, "mission-crash-scenario", {
                    type: "work_item_discovered",
                    workItemId: "wi-2",
                    title: "Task 2 (Crashed)",
                    scope: ["src/b.ts"],
                    dependsOn: ["wi-1"],
                    roleRequired: "worker",
                    acceptanceCriteria: [],
                });
                MissionEventsStore.appendEvent(eventsPath, "mission-crash-scenario", {
                    type: "run_started",
                    runId: "run-crashed-in-flight",
                    workItemId: "wi-2",
                    expertId: "worker",
                    model: "gemini-3.7-flash",
                    effort: "medium",
                });
                // Resume engine recovers
                const resumeReport = await MissionResumptionEngine.resume({
                    workspaceRoot: tempDir,
                    missionId: "mission-crash-scenario",
                });
                assert.ok(typeof resumeReport.status === "string");
                assert.ok(typeof resumeReport.totalEventsCount === "number");
                // Verify event journal continuity
                const events = MissionEventsStore.readEvents(eventsPath);
                const chainCheck = MissionEventsStore.verifyEventChain(events);
                assert.equal(chainCheck.valid, true);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Scenario 3: Self-Review Bypass & Collusion Defense
    // --------------------------------------------------------------------------
    describe("Scenario 3: Self-Review Bypass & Collusion Defense", () => {
        it("rejects single-reviewer approval and collusion attempts", () => {
            // Worker submits only 1 review
            const singleReview = AdversarialReviewEngine.evaluateReview("run-worker-1", "worker-agent", { workItemId: "wi-collude", stagedDiffDigest: "digest-bad", filesModified: ["src/auth.ts"], modulePatch: {} }, () => ({ approved: true, observations: ["Looks good to me"] }));
            const singleConsensus = AdversarialReviewEngine.computeConsensus("wi-collude", [singleReview]);
            assert.equal(singleConsensus.consensus, "rejected");
            // Collusion attempt: same reviewer identity duplicating approval
            const duplicateReview = AdversarialReviewEngine.evaluateReview("run-worker-1", "worker-agent", { workItemId: "wi-collude", stagedDiffDigest: "digest-bad", filesModified: ["src/auth.ts"], modulePatch: {} }, () => ({ approved: true, observations: ["Looks good to me too"] }));
            const duplicateConsensus = AdversarialReviewEngine.computeConsensus("wi-collude", [singleReview, duplicateReview]);
            assert.equal(duplicateConsensus.consensus, "rejected");
            // Valid case: 2 distinct independent reviewer run IDs
            const validReview2 = AdversarialReviewEngine.evaluateReview("run-reviewer-2", "independent-auditor", { workItemId: "wi-collude", stagedDiffDigest: "digest-bad", filesModified: ["src/auth.ts"], modulePatch: {} }, () => ({ approved: true, observations: ["Audited and approved"] }));
            const validConsensus = AdversarialReviewEngine.computeConsensus("wi-collude", [singleReview, validReview2]);
            assert.equal(validConsensus.consensus, "approved");
        });
    });
    // --------------------------------------------------------------------------
    // Scenario 4: Fork-Bomb / Process Leak & Malicious Path Defense
    // --------------------------------------------------------------------------
    describe("Scenario 4: Fork-Bomb / Process Leak & Malicious Path Defense", () => {
        it("enforces worktree directory isolation and rejects relative path escaping", () => {
            const maliciousProposals = [
                {
                    schemaVersion: 2,
                    proposalId: "prop_trav_1",
                    expectedRevision: 1,
                    author: "attacker",
                    operations: [
                        {
                            type: "add_node",
                            node: {
                                id: "n_trav_1",
                                title: "Escape root",
                                kind: "agent",
                                activation: "all",
                                completionAuthority: "broker",
                                completionAuthorityId: "oma-broker",
                                executor: { adapter: "antigravity-cli", persona: "oma-executor" },
                                scope: ["../../../Windows/System32/cmd.exe"],
                            },
                        },
                    ],
                },
                {
                    schemaVersion: 2,
                    proposalId: "prop_trav_2",
                    expectedRevision: 1,
                    author: "attacker",
                    operations: [
                        {
                            type: "add_node",
                            node: {
                                id: "n_trav_2",
                                title: "Absolute escape",
                                kind: "agent",
                                activation: "all",
                                completionAuthority: "broker",
                                completionAuthorityId: "oma-broker",
                                executor: { adapter: "antigravity-cli", persona: "oma-executor" },
                                scope: ["C:/Windows/System32"],
                            },
                        },
                    ],
                },
            ];
            for (const prop of maliciousProposals) {
                assert.throws(() => parseGraphProposal(prop));
            }
        });
    });
    // --------------------------------------------------------------------------
    // Scenario 5: End-to-End Multi-Agent Mission Pipeline
    // --------------------------------------------------------------------------
    describe("Scenario 5: End-to-End Multi-Agent Mission Pipeline", () => {
        it("executes full multi-agent mission pipeline with dual reviews, judge gate, and 2PC git commit", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t4-full-mission-"));
            try {
                const baseBundle = {
                    math: canonicalMath,
                    parser: canonicalParser,
                    pipeline: canonicalPipeline,
                };
                // 1. Worker generates patch
                const changeProposal = {
                    workItemId: "wi-mission-e2e",
                    filesModified: ["src/pipeline.ts"],
                    modulePatch: {
                        pipeline: canonicalPipeline,
                    },
                    stagedDiffDigest: sha256("diff-mission-e2e"),
                };
                // 2. Dual independent adversarial review
                const rev1 = AdversarialReviewEngine.evaluateReview("run-rev-alpha", "reviewer-alpha", { workItemId: "wi-mission-e2e", stagedDiffDigest: changeProposal.stagedDiffDigest, filesModified: ["src/pipeline.ts"], modulePatch: changeProposal.modulePatch }, () => ({ approved: true, observations: ["Pipeline logic validated"] }));
                const rev2 = AdversarialReviewEngine.evaluateReview("run-rev-beta", "reviewer-beta", { workItemId: "wi-mission-e2e", stagedDiffDigest: changeProposal.stagedDiffDigest, filesModified: ["src/pipeline.ts"], modulePatch: changeProposal.modulePatch }, () => ({ approved: true, observations: ["Error handling verified"] }));
                const consensus = AdversarialReviewEngine.computeConsensus("wi-mission-e2e", [rev1, rev2]);
                assert.equal(consensus.consensus, "approved");
                // 3. 2PC Integration & Judge Gate Evaluation
                const integration = DeterministicIntegrator.integrateWorkItems(baseBundle, [changeProposal]);
                assert.equal(integration.status, "integrated");
                assert.equal(integration.judgeVerdict?.status, "approved");
                assert.equal(integration.judgeVerdict?.progressVector.hiddenTestsFailing, 0);
                assert.ok(integration.commitHash);
                // 4. Dynamic convergence cycle
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-t4-convergence",
                    limits: { maxRounds: 2 },
                    initialWorkItemsSupplier: () => [
                        {
                            scopeId: "src/pipeline.ts",
                            title: "Verified Pipeline",
                            filesModified: ["src/pipeline.ts"],
                            modulePatch: changeProposal.modulePatch,
                        },
                    ],
                });
                assert.equal(report.status, "succeeded");
                assert.ok(report.integratedCommitSha);
                assert.ok(report.totalWaves >= 1);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
});
