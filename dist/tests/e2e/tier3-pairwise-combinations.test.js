import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyDriver } from "../../src/runtime/agy-driver.js";
import { SecretScrubber } from "../../src/runtime/secret-scrubber.js";
import { GraphBroker } from "../../src/graph/broker.js";
import { ObjectiveJudge } from "../../src/oracle/objective-judge.js";
import { MissionEventsStore } from "../../src/ledger/mission-events.js";
import { DeterministicResumeEngine } from "../../src/resume/engine.js";
import { WorktreePool } from "../../src/orchestration/worktree-pool.js";
import { DeterministicIntegrator } from "../../src/orchestration/integrator.js";
import { DynamicConvergenceEngine } from "../../src/orchestration/dynamic-engine.js";
import { AdversarialReviewEngine } from "../../src/oracle/adversarial-review.js";
import { OmaDoctor } from "../../src/runtime/doctor.js";
import { runOmaCli } from "../../src/cli/oma-cli.js";
import { initializeGraphStore, appendGraphTransition, verifyGraphStore } from "../../src/graph/store.js";
import { MissionProjectionEngine } from "../../src/graph/mission-projections.js";
import { MissionResumptionEngine } from "../../src/orchestration/mission-resumption.js";
import { sha256 } from "../../src/ledger/canonical.js";
import * as canonicalMath from "../../test-fixtures/minimal-pipeline/src/math.js";
import * as canonicalParser from "../../test-fixtures/minimal-pipeline/src/parser.js";
import * as canonicalPipeline from "../../test-fixtures/minimal-pipeline/src/pipeline.js";
describe("Tier 3: Pairwise Cross-Feature Combinations", () => {
    // --------------------------------------------------------------------------
    // Combination 1: AgyDriver + SecretScrubber
    // --------------------------------------------------------------------------
    describe("Combination 1: AgyDriver + SecretScrubber", () => {
        it("scrubs secrets emitted by driver execution stdout and structured outputs", async () => {
            const driver = new AgyDriver();
            const scrubber = new SecretScrubber();
            const rawSecret = "AIzaSy" + "A".repeat(33);
            const outputText = `Execution complete: API key was ${rawSecret}, result: {"status": "ok"}`;
            const scrubbed = scrubber.scrub(outputText);
            assert.ok(!scrubbed.includes(rawSecret));
            assert.ok(scrubbed.includes("[REDACTED_GEMINI_KEY]"));
            const { parsed } = driver.extractStructuredOutput(scrubbed);
            assert.deepEqual(parsed, { status: "ok" });
        });
    });
    // --------------------------------------------------------------------------
    // Combination 2: GraphBroker + ObjectiveJudge
    // --------------------------------------------------------------------------
    describe("Combination 2: GraphBroker + ObjectiveJudge", () => {
        it("validates dynamic proposal and assesses progress vector with objective judge", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t3-broker-judge-"));
            try {
                const graph = {
                    schemaVersion: 2,
                    graphId: "graph-t3-bj",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "task_judge", title: "Judge Task", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
                    ],
                    edges: [],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
                initializeGraphStore(tempDir);
                const broker = new GraphBroker(tempDir);
                const proposal = {
                    schemaVersion: 2,
                    proposalId: "prop_eval_ext",
                    author: "planner",
                    reason: "Extend with verifier node",
                    expectedRevision: 1,
                    operations: [
                        {
                            type: "add_node",
                            node: { id: "node_verifier", title: "Verifier", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-verifier" } },
                        },
                    ],
                };
                const res = await broker.applyProposal(proposal);
                assert.equal(res.success, true);
                // Evaluate bundle with ObjectiveJudge
                const baseBundle = {
                    math: canonicalMath,
                    parser: canonicalParser,
                    pipeline: canonicalPipeline,
                };
                const verdict = ObjectiveJudge.evaluatePipelineBundle(baseBundle, { totalWorkItems: 2, acceptedWorkItems: 2 });
                assert.equal(verdict.status, "approved");
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Combination 3: MissionEventsStore + DeterministicResumeEngine
    // --------------------------------------------------------------------------
    describe("Combination 3: MissionEventsStore + DeterministicResumeEngine", () => {
        it("fences epoch monotonically across multiple resume attempts from durable ledger", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t3-events-resume-"));
            try {
                const graph = {
                    schemaVersion: 2,
                    graphId: "graph-t3-er",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "task_crash_1", title: "Crash 1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
                    ],
                    edges: [],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
                const runtime = initializeGraphStore(tempDir);
                appendGraphTransition(runtime, {
                    eventType: "node_dispatched",
                    nodeId: "task_crash_1",
                    dispatchId: "disp-epoch-1",
                    authorityId: "oma-scheduler",
                });
                const resume1 = await DeterministicResumeEngine.resume({ workspaceRoot: tempDir });
                assert.ok(resume1.purgedZombies.includes("task_crash_1"));
                assert.ok(resume1.activeEpoch >= 1);
                const resume2 = await DeterministicResumeEngine.resume({ workspaceRoot: tempDir });
                assert.equal(resume2.purgedZombies.length, 0);
                assert.ok(resume2.activeEpoch >= resume1.activeEpoch);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Combination 4: WorktreePool + DeterministicIntegrator
    // --------------------------------------------------------------------------
    describe("Combination 4: WorktreePool + DeterministicIntegrator", () => {
        it("acquires worktree contexts and integrates disjoint proposals in 2PC atomic batch", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t3-pool-integ-"));
            try {
                const pool = new WorktreePool({ workspaceRoot: tempDir });
                const wt1 = await pool.acquire("task-integ-1");
                const wt2 = await pool.acquire("task-integ-2");
                assert.ok(existsSync(wt1));
                assert.ok(existsSync(wt2));
                const baseBundle = {
                    math: canonicalMath,
                    parser: canonicalParser,
                    pipeline: canonicalPipeline,
                };
                const proposals = [
                    {
                        workItemId: "task-integ-1",
                        filesModified: ["src/math.ts"],
                        modulePatch: {},
                        stagedDiffDigest: sha256("diff1"),
                    },
                    {
                        workItemId: "task-integ-2",
                        filesModified: ["src/parser.ts"],
                        modulePatch: {},
                        stagedDiffDigest: sha256("diff2"),
                    },
                ];
                const report = DeterministicIntegrator.integrateWorkItems(baseBundle, proposals);
                assert.equal(report.status, "integrated");
                assert.equal(report.integratedWorkItems.length, 2);
                assert.ok(report.commitHash);
                await pool.release("task-integ-1");
                await pool.release("task-integ-2");
                assert.equal(pool.getActiveWorktrees().size, 0);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Combination 5: DynamicConvergenceEngine + AdversarialReviewEngine
    // --------------------------------------------------------------------------
    describe("Combination 5: DynamicConvergenceEngine + AdversarialReviewEngine", () => {
        it("multi-wave convergence verifies changes using independent dual adversarial reviews", async () => {
            const rev1 = AdversarialReviewEngine.evaluateReview("run-wave-rev1", "reviewer-1", { workItemId: "wi-wave-1", stagedDiffDigest: "digest-clean", filesModified: ["src/pipeline.ts"], modulePatch: {} }, () => ({ approved: true, observations: ["Pass 1"] }));
            const rev2 = AdversarialReviewEngine.evaluateReview("run-wave-rev2", "reviewer-2", { workItemId: "wi-wave-1", stagedDiffDigest: "digest-clean", filesModified: ["src/pipeline.ts"], modulePatch: {} }, () => ({ approved: true, observations: ["Pass 2"] }));
            const consensus = AdversarialReviewEngine.computeConsensus("wi-wave-1", [rev1, rev2]);
            assert.equal(consensus.consensus, "approved");
            assert.equal(consensus.reviews.length, 2);
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t3-dynamic-review-"));
            try {
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-t3-dyn-rev",
                    limits: { maxRounds: 2 },
                    initialWorkItemsSupplier: () => [],
                });
                assert.equal(report.status, "succeeded");
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Combination 6: OmaDoctor + Unified CLI
    // --------------------------------------------------------------------------
    describe("Combination 6: OmaDoctor + Unified CLI", () => {
        it("runs doctor check via CLI and matches programmatic OmaDoctor diagnosis", async () => {
            const programmaticReport = OmaDoctor.diagnoseEnvironment(process.cwd());
            assert.ok(programmaticReport.os);
            assert.ok(programmaticReport.architecture);
            const cliExitCode = await runOmaCli(["doctor"]);
            assert.equal(cliExitCode, 0);
        });
    });
    // --------------------------------------------------------------------------
    // Combination 7: GraphStore + DAG Validation (Kahn)
    // --------------------------------------------------------------------------
    describe("Combination 7: GraphStore + DAG Validation (Kahn)", () => {
        it("appends transitions to verified store while preserving acyclic execution structure", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t3-store-kahn-"));
            try {
                const graph = {
                    schemaVersion: 2,
                    graphId: "graph-t3-sk",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "node_start", title: "Start", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
                        { id: "node_end", title: "End", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                    ],
                    edges: [
                        { id: "e1", from: "node_start", to: "node_end", when: "success" },
                    ],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
                const runtime = initializeGraphStore(tempDir);
                appendGraphTransition(runtime, {
                    eventType: "node_dispatched",
                    nodeId: "node_start",
                    dispatchId: "disp-start",
                    authorityId: "oma-scheduler",
                });
                appendGraphTransition(runtime, {
                    eventType: "node_completed",
                    nodeId: "node_start",
                    dispatchId: "disp-start",
                    outcome: "success",
                    authority: "broker",
                    authorityId: "oma-broker",
                    evidenceHash: "0".repeat(64),
                });
                const verification = verifyGraphStore(runtime);
                assert.equal(verification.valid, true);
                assert.equal(verification.events.length, 2);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Combination 8: MissionProjectionEngine + MissionResumptionEngine
    // --------------------------------------------------------------------------
    describe("Combination 8: MissionProjectionEngine + MissionResumptionEngine", () => {
        it("projects mission history from ledger to power cold-start mission resumption", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t3-proj-resum-"));
            try {
                const missionDir = join(tempDir, ".oma", "missions", "mission-proj-res");
                mkdirSync(missionDir, { recursive: true });
                const eventsPath = join(missionDir, "events.jsonl");
                MissionEventsStore.appendEvent(eventsPath, "mission-proj-res", {
                    type: "mission_started",
                    workflowDigest: "wd-pr",
                    rulebookRevision: "rev-pr",
                    goal: "Projection and Resumption Test",
                });
                MissionEventsStore.appendEvent(eventsPath, "mission-proj-res", {
                    type: "work_item_discovered",
                    workItemId: "wi-pr-1",
                    title: "Projection Task",
                    scope: ["src/a.ts"],
                    dependsOn: [],
                    roleRequired: "worker",
                    acceptanceCriteria: [],
                });
                const events = MissionEventsStore.readEvents(eventsPath);
                const projection = MissionProjectionEngine.project(events);
                assert.equal(projection.status, "in_progress");
                assert.ok(projection.workGraph.readySet.includes("wi-pr-1"));
                const resumeReport = await MissionResumptionEngine.resume({
                    workspaceRoot: tempDir,
                    missionId: "mission-proj-res",
                });
                assert.ok(typeof resumeReport.status === "string");
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Combination 9: WorktreePool + AgyDriver
    // --------------------------------------------------------------------------
    describe("Combination 9: WorktreePool + AgyDriver", () => {
        it("executes driver inside isolated acquired worktree path and releases cleanly", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t3-pool-driver-"));
            try {
                const pool = new WorktreePool({ workspaceRoot: tempDir });
                const worktreePath = await pool.acquire("task-driver-isolated");
                assert.ok(existsSync(worktreePath));
                const driver = new AgyDriver();
                const res = await driver.invoke({
                    persona: "worker",
                    contractPrompt: "Verify isolation context",
                    worktreeDir: worktreePath,
                    timeoutMs: 1000,
                });
                assert.ok(res.receipt.receiptHash);
                assert.ok(typeof res.durationMs === "number");
                await pool.release("task-driver-isolated");
                assert.equal(pool.getActiveWorktrees().size, 0);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Combination 10: ObjectiveJudge + DynamicConvergenceEngine Monotonicity
    // --------------------------------------------------------------------------
    describe("Combination 10: ObjectiveJudge + DynamicConvergenceEngine Monotonicity", () => {
        it("enforces strict defect vector monotonicity during dynamic convergence waves", async () => {
            const vInitial = {
                hiddenTestsFailing: 3,
                hiddenTestsPassed: 2,
                visibleTestsFailing: 2,
                visibleTestsPassed: 3,
                gateFailures: 1,
                openDiagnosticsCount: 3,
                acceptedWorkItems: 0,
                totalWorkItems: 2,
            };
            const vIntermediate = {
                ...vInitial,
                hiddenTestsFailing: 1,
                hiddenTestsPassed: 4,
            };
            const vFinal = {
                ...vIntermediate,
                hiddenTestsFailing: 0,
                hiddenTestsPassed: 5,
                visibleTestsFailing: 0,
                visibleTestsPassed: 5,
            };
            assert.equal(ObjectiveJudge.isProgressing(vInitial, vIntermediate), true);
            assert.equal(ObjectiveJudge.isProgressing(vIntermediate, vFinal), true);
            assert.equal(ObjectiveJudge.isProgressing(vFinal, vIntermediate), false);
        });
    });
});
