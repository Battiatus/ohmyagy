import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateKahnAcyclicity, GraphBroker } from "../../src/graph/broker.js";
import { initializeGraphStore, appendGraphTransition } from "../../src/graph/store.js";
import { DeterministicResumeEngine } from "../../src/resume/engine.js";
import { MissionResumptionEngine } from "../../src/orchestration/mission-resumption.js";
import { MissionEventsStore } from "../../src/ledger/mission-events.js";
import { JournalStore } from "../../src/ledger/journal-store.js";
import { AdversarialReviewEngine } from "../../src/oracle/adversarial-review.js";
import { promoteApprovedTransaction, PromotionError } from "../../src/broker/promotion.js";
import { WorktreePool } from "../../src/orchestration/worktree-pool.js";
import { DynamicConvergenceEngine } from "../../src/orchestration/dynamic-engine.js";
import { ObjectiveJudge } from "../../src/oracle/objective-judge.js";
import * as originalMath from "../../test-fixtures/minimal-pipeline/src/math.js";
import * as originalParser from "../../test-fixtures/minimal-pipeline/src/parser.js";
import * as originalPipeline from "../../test-fixtures/minimal-pipeline/src/pipeline.js";
import * as mutant1Math from "../../test-fixtures/minimal-pipeline/src/mutants/mutant1-math.js";
import * as mutant2Parser from "../../test-fixtures/minimal-pipeline/src/mutants/mutant2-parser.js";
describe("Tier 5: Adversarial Stress & Hardening Suite", () => {
    const baseBundle = {
        math: originalMath,
        parser: originalParser,
        pipeline: originalPipeline,
    };
    describe("Dimension 1: Graph Cycle Injection & Kahn DFS Diagnostic Accuracy", () => {
        it("1.1: detects complex 5-node cycle (N1 -> N2 -> N3 -> N5 -> N5 -> N1) and extracts exact cyclePath", () => {
            const nodes = [
                { id: "N1", title: "Node 1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "b1" },
                { id: "N2", title: "Node 2", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "b1" },
                { id: "N3", title: "Node 3", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "b1" },
                { id: "N4", title: "Node 4", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "b1" },
                { id: "N5", title: "Node 5", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "b1" },
            ];
            const edges = [
                { id: "e1", from: "N1", to: "N2", when: "success" },
                { id: "e2", from: "N2", to: "N3", when: "success" },
                { id: "e3", from: "N3", to: "N4", when: "success" },
                { id: "e4", from: "N4", to: "N5", when: "success" },
                { id: "e5", from: "N5", to: "N1", when: "success" },
            ];
            const result = validateKahnAcyclicity(nodes, edges);
            assert.equal(result.valid, false);
            assert.equal(result.code, "CYCLE_DETECTED");
            assert.ok(result.cyclePath && result.cyclePath.length >= 2);
            assert.equal(result.cyclePath[0], result.cyclePath[result.cyclePath.length - 1]);
            assert.ok(result.error?.includes("cycle detected"));
            assert.ok(result.offendingEdges && result.offendingEdges.length > 0);
        });
        it("1.2: isolates cycle in disconnected subgraph without corrupting disjoint linear components", () => {
            const nodes = [
                { id: "A", title: "A", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "b1" },
                { id: "B", title: "B", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "b1" },
                { id: "C", title: "C", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "b1" },
                { id: "X", title: "X", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "b1" },
                { id: "Y", title: "Y", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "b1" },
                { id: "Z", title: "Z", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "b1" },
            ];
            const edges = [
                { id: "eA_B", from: "A", to: "B", when: "success" },
                { id: "eB_C", from: "B", to: "C", when: "success" },
                { id: "eX_Y", from: "X", to: "Y", when: "success" },
                { id: "eY_Z", from: "Y", to: "Z", when: "success" },
                { id: "eZ_X", from: "Z", to: "X", when: "success" },
            ];
            const result = validateKahnAcyclicity(nodes, edges);
            assert.equal(result.valid, false);
            assert.equal(result.code, "CYCLE_DETECTED");
            assert.ok(result.cyclePath);
            for (const node of result.cyclePath) {
                assert.ok(["X", "Y", "Z"].includes(node));
            }
        });
        it("1.3: rejects direct self-loop injection (S1 -> S1) with SELF_LOOP_FORBIDDEN diagnostic", () => {
            const nodes = [
                { id: "S1", title: "Self Loop Node", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "b1" },
            ];
            const edges = [
                { id: "self_edge", from: "S1", to: "S1", when: "success" },
            ];
            const result = validateKahnAcyclicity(nodes, edges);
            assert.equal(result.valid, false);
            assert.equal(result.code, "SELF_LOOP_FORBIDDEN");
            assert.deepEqual(result.cyclePath, ["S1", "S1"]);
            assert.ok(result.error?.includes("Self-loop strictly forbidden"));
        });
        it("1.4: rejects GraphProposal introducing cycle and preserves on-disk graph revision without modification", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t5-cycle-cas-"));
            try {
                const initialGraph = {
                    schemaVersion: 2,
                    graphId: "graph-cycle-cas",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "step_1", title: "Step 1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker" },
                        { id: "step_2", title: "Step 2", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker" },
                    ],
                    edges: [
                        { id: "e1_2", from: "step_1", to: "step_2", when: "success" },
                    ],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(initialGraph, null, 2));
                const broker = new GraphBroker(tempDir);
                const cycleProposal = {
                    schemaVersion: 1,
                    proposalId: "prop-cycle-attack",
                    missionId: "mission-cycle-test",
                    author: "adversary",
                    expectedRevision: 1,
                    parentRevision: 1,
                    rationale: { summary: "Inject back-edge to create cycle" },
                    operations: [
                        {
                            type: "add_edge",
                            edge: { id: "e2_1_cycle", from: "step_2", to: "step_1", when: "success" },
                        },
                    ],
                };
                const result = await broker.applyProposal(cycleProposal);
                assert.equal(result.success, false);
                assert.ok(["CYCLE_DETECTED", "CAS_CONFLICT", "TERMINAL_NODE_MUTATION"].includes(result.code));
                const diskGraph = JSON.parse(readFileSync(join(graphDir, "execution-graph.json"), "utf8"));
                assert.equal(diskGraph.revision, 1);
                assert.equal(diskGraph.edges.length, 1);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("1.5: detects back-edge in large 60-node DAG instantaneously with O(V+E) performance", () => {
            const nodeCount = 60;
            const nodes = [];
            const edges = [];
            for (let i = 1; i <= nodeCount; i++) {
                nodes.push({
                    id: `N_${i}`,
                    title: `Node ${i}`,
                    kind: "agent",
                    activation: "all",
                    completionAuthority: "broker",
                    completionAuthorityId: "b1",
                });
            }
            for (let i = 1; i < nodeCount; i++) {
                edges.push({
                    id: `e_${i}_${i + 1}`,
                    from: `N_${i}`,
                    to: `N_${i + 1}`,
                    when: "success",
                });
            }
            edges.push({
                id: "e_back_55_15",
                from: "N_55",
                to: "N_15",
                when: "success",
            });
            const startTime = performance.now();
            const result = validateKahnAcyclicity(nodes, edges);
            const elapsed = performance.now() - startTime;
            assert.equal(result.valid, false);
            assert.equal(result.code, "CYCLE_DETECTED");
            assert.ok(elapsed < 50, `Cycle detection took ${elapsed}ms, expected < 50ms for 60 nodes`);
            assert.ok(result.cyclePath && result.cyclePath.includes("N_15") && result.cyclePath.includes("N_55"));
        });
    });
    // ==================================================================
    // Dimension 2: Crash Recovery Mid-Flight & Corrupted Event Log Detection
    // ==================================================================
    describe("Dimension 2: Crash Recovery Mid-Flight & Corrupted Event Log Detection", () => {
        it("2.1: recovers mid-flight crashed task, purges zombie worktree, and bumps epoch monotonically", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t5-crash-rec-"));
            try {
                const initialGraph = {
                    schemaVersion: 2,
                    graphId: "graph-crash-sim",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "task_prep", title: "Prep", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker" },
                        { id: "task_heavy", title: "Heavy Compute", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker" },
                    ],
                    edges: [
                        { id: "e1", from: "task_prep", to: "task_heavy", when: "success" },
                    ],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(initialGraph, null, 2));
                const runtime = initializeGraphStore(tempDir);
                appendGraphTransition(runtime, {
                    eventType: "node_dispatched",
                    nodeId: "task_prep",
                    dispatchId: "disp-prep",
                    authorityId: "oma-scheduler",
                });
                appendGraphTransition(runtime, {
                    eventType: "node_completed",
                    nodeId: "task_prep",
                    dispatchId: "disp-prep",
                    outcome: "success",
                    authorityId: "oma-broker",
                });
                appendGraphTransition(runtime, {
                    eventType: "node_dispatched",
                    nodeId: "task_heavy",
                    dispatchId: "disp-heavy-zombie",
                    authorityId: "oma-scheduler",
                });
                const zombieWorktree = join(tempDir, ".oma", "worktrees", "wt-task-heavy-zombie");
                mkdirSync(join(tempDir, ".oma", "worktrees"), { recursive: true });
                mkdirSync(zombieWorktree, { recursive: true });
                writeFileSync(join(zombieWorktree, "dirty.tmp"), "uncommitted crash state");
                const resumption = DeterministicResumeEngine.resume({
                    workspaceRoot: tempDir,
                });
                assert.equal(resumption.interruptedTasksRecovered.length, 1);
                assert.equal(resumption.interruptedTasksRecovered[0], "task_heavy");
                assert.equal(resumption.activeEpoch, 2, "Active epoch must advance from 1 to 2");
                assert.ok(resumption.projectedReadySet.includes("task_heavy"));
                assert.ok(!resumption.projectedReadySet.includes("task_prep"));
                assert.equal(existsSync(zombieWorktree), false);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("2.2: detects tampered event payload in events.jsonl and rejects resumption with integrity failure", () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t5-tampered-log-"));
            try {
                const eventsDir = join(tempDir, ".oma", "missions", "mission-tamper-1");
                mkdirSync(eventsDir, { recursive: true });
                const eventsPath = join(eventsDir, "events.jsonl");
                const store = new JournalStore(eventsPath);
                store.appendEvent({ eventType: "mission_started", missionId: "mission-tamper-1", timestamp: new Date().toISOString() });
                store.appendEvent({ eventType: "run_finished", runId: "run-01", status: "failed", timestamp: new Date().toISOString() });
                const validCheck = store.verifyIntegrity();
                assert.equal(validCheck.valid, true);
                const content = readFileSync(eventsPath, "utf8");
                const tamperedContent = content.replace('"status":"failed"', '"status":"succeeded"');
                writeFileSync(eventsPath, tamperedContent, "utf8");
                const tamperedStore = new JournalStore(eventsPath);
                const integrity = tamperedStore.verifyIntegrity();
                assert.equal(integrity.valid, false);
                assert.ok(integrity.error?.includes("Hash mismatch") || integrity.error?.includes("mismatch"));
                const chainCheck = MissionEventsStore.verifyEventChain(eventsPath);
                assert.equal(chainCheck.valid, false);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("2.3: detects broken previousEventHash pointer in cryptographic hash chain", () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t5-broken-pointer-"));
            try {
                const eventsDir = join(tempDir, ".oma", "missions", "mission-broken-ptr");
                mkdirSync(eventsDir, { recursive: true });
                const eventsPath = join(eventsDir, "events.jsonl");
                const store = new JournalStore(eventsPath);
                store.appendEvent({ eventType: "mission_started", missionId: "mission-broken-ptr", timestamp: new Date().toISOString() });
                store.appendEvent({ eventType: "run_started", runId: "run-01", timestamp: new Date().toISOString() });
                store.appendEvent({ eventType: "run_finished", runId: "run-01", status: "passed", timestamp: new Date().toISOString() });
                const lines = readFileSync(eventsPath, "utf8").trim().split("\n");
                const event2 = JSON.parse(lines[1]);
                event2.previousEventHash = "0000000000000000000000000000000000000000000000000000000000000000";
                lines[1] = JSON.stringify(event2);
                writeFileSync(eventsPath, lines.join("\n") + "\n", "utf8");
                assert.throws(() => new JournalStore(eventsPath), (err) => {
                    assert.ok(err instanceof Error);
                    assert.ok(err.message.includes("integrity") || err.message.includes("mismatch"));
                    return true;
                });
                const check = MissionEventsStore.verifyEventChain(eventsPath);
                assert.equal(check.valid, false);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("2.4: flags truncated / corrupted JSON line in events.jsonl gracefully", () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t5-truncated-log-"));
            try {
                const eventsDir = join(tempDir, ".oma", "missions", "mission-truncated");
                mkdirSync(eventsDir, { recursive: true });
                const eventsPath = join(eventsDir, "events.jsonl");
                const store = new JournalStore(eventsPath);
                store.appendEvent({ eventType: "mission_started", missionId: "mission-truncated", timestamp: new Date().toISOString() });
                appendFileSync(eventsPath, '{"eventType":"run_started","timestamp":"2026-08-31T\n', "utf8");
                assert.throws(() => new JournalStore(eventsPath), (err) => {
                    assert.ok(err instanceof Error);
                    assert.ok(err.message.includes("JSON") || err.message.includes("Corrupt") || err.message.includes("Unterminated"));
                    return true;
                });
                const check = MissionEventsStore.verifyEventChain(eventsPath);
                assert.equal(check.valid, false);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("2.5: ensures strict idempotency f(f(f(x))) = f(x) across multiple consecutive resume executions", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t5-idempotence-"));
            try {
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-idempotent-test",
                    baseBundle,
                    limits: { maxRounds: 1, maxConsecutiveNoProgressRounds: 1 },
                    initialWorkItemsSupplier: () => [
                        {
                            scopeId: "src/math.ts",
                            title: "Implement Math",
                            filesModified: ["src/math.ts"],
                            modulePatch: { math: originalMath },
                            rawDiffContent: "diff --git a/src/math.ts b/src/math.ts\n+math",
                        },
                    ],
                });
                assert.equal(report.status, "succeeded");
                const res1 = await MissionResumptionEngine.resume({ workspaceRoot: tempDir, missionId: "mission-idempotent-test" });
                const res2 = await MissionResumptionEngine.resume({ workspaceRoot: tempDir, missionId: "mission-idempotent-test" });
                const res3 = await MissionResumptionEngine.resume({ workspaceRoot: tempDir, missionId: "mission-idempotent-test" });
                assert.equal(res1.status, "succeeded");
                assert.equal(res2.status, "succeeded");
                assert.equal(res3.status, "succeeded");
                assert.equal(res1.totalEventsCount, res2.totalEventsCount);
                assert.equal(res2.totalEventsCount, res3.totalEventsCount);
                assert.equal(res1.finalCommitSha, res3.finalCommitSha);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // ==================================================================
    // Dimension 3: Author == Reviewer Bypass Attempts & Malicious Promotion Rejection
    // ==================================================================
    describe("Dimension 3: Author == Reviewer Bypass Attempts & Malicious Promotion Rejection", () => {
        it("3.1: rejects consensus when reviewer count is less than 2 independent reviews", () => {
            const subject = {
                workItemId: "work-auth-1",
                stagedDiffDigest: "digest-abc-123",
                filesModified: ["src/auth.ts"],
                modulePatch: {},
            };
            const singleReview = AdversarialReviewEngine.evaluateReview("run-rev-1", "reviewer-alpha", subject, () => ({ approved: true, observations: ["Looks good"] }));
            const consensus = AdversarialReviewEngine.computeConsensus(subject.workItemId, [singleReview]);
            assert.equal(consensus.consensus, "rejected", "Single review must never satisfy dual review consensus");
        });
        it("3.2: rejects consensus when duplicate reviews come from same reviewerRunId (split persona attack)", () => {
            const subject = {
                workItemId: "work-split-persona",
                stagedDiffDigest: "digest-split-456",
                filesModified: ["src/auth.ts"],
                modulePatch: {},
            };
            const rev1 = AdversarialReviewEngine.evaluateReview("run-rev-same-id", "reviewer-alpha", subject, () => ({ approved: true, observations: ["Approved 1"] }));
            const rev2 = AdversarialReviewEngine.evaluateReview("run-rev-same-id", "reviewer-beta", subject, () => ({ approved: true, observations: ["Approved 2"] }));
            const consensus = AdversarialReviewEngine.computeConsensus(subject.workItemId, [rev1, rev2]);
            assert.equal(consensus.consensus, "rejected", "Duplicate reviewerRunId must be rejected");
        });
        it("3.3: rejects consensus when any peer review dissents (1 Approved, 1 Rejected)", () => {
            const subject = {
                workItemId: "work-dissent",
                stagedDiffDigest: "digest-dissent-789",
                filesModified: ["src/auth.ts"],
                modulePatch: {},
            };
            const rev1 = AdversarialReviewEngine.evaluateReview("run-rev-1", "reviewer-alpha", subject, () => ({ approved: true, observations: ["Clean code"] }));
            const rev2 = AdversarialReviewEngine.evaluateReview("run-rev-2", "reviewer-beta", subject, () => ({ approved: false, observations: ["Security flaw detected"] }));
            const consensus = AdversarialReviewEngine.computeConsensus(subject.workItemId, [rev1, rev2]);
            assert.equal(consensus.consensus, "rejected", "Dissenting review must block promotion");
        });
        it("3.4: rejects promoteApprovedTransaction when unapproved / forged approval token is passed", () => {
            const forgedApproval = {
                transactionId: "fake-tx-123",
                verdictHash: "fake-verdict-hash",
                staged: {
                    worktreePath: "C:\\fake",
                    containerPath: "C:\\fake",
                },
            };
            assert.throws(() => promoteApprovedTransaction(forgedApproval), (err) => {
                assert.ok(err instanceof PromotionError);
                assert.equal(err.code, "not_approved");
                return true;
            });
        });
        it("3.5: accepts consensus and produces deterministic consensusHash when 2 distinct independent reviews approve", () => {
            const subject = {
                workItemId: "work-valid-consensus",
                stagedDiffDigest: "digest-clean-111",
                filesModified: ["src/valid.ts"],
                modulePatch: {},
            };
            const rev1 = AdversarialReviewEngine.evaluateReview("run-rev-alpha-01", "reviewer-alpha", subject, () => ({ approved: true, observations: ["Valid patch"] }));
            const rev2 = AdversarialReviewEngine.evaluateReview("run-rev-beta-01", "reviewer-beta", subject, () => ({ approved: true, observations: ["Verified and sound"] }));
            const consensus = AdversarialReviewEngine.computeConsensus(subject.workItemId, [rev1, rev2]);
            assert.equal(consensus.consensus, "approved");
            assert.ok(consensus.consensusHash && consensus.consensusHash.length === 64);
        });
    });
    // ==================================================================
    // Dimension 4: Windows Worktree Lock Contention & Concurrency Stress
    // ==================================================================
    describe("Dimension 4: Windows Worktree Lock Contention & Concurrency Stress", () => {
        it("4.1: executes 8 concurrent WorktreePool acquire & release operations without path collisions", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t5-worktree-pool-"));
            try {
                const pool = new WorktreePool({ workspaceRoot: tempDir });
                const concurrency = 8;
                const tasks = Array.from({ length: concurrency }, async (_, i) => {
                    const workItemId = `work-concurrent-${i}`;
                    const path = await pool.acquire(workItemId);
                    assert.ok(existsSync(path), `Worktree path for ${workItemId} must exist`);
                    assert.equal(pool.getWorktreePath(workItemId), path);
                    writeFileSync(join(path, `output-${i}.txt`), `Worker ${i} content`);
                    await new Promise((r) => setTimeout(r, 10));
                    await pool.release(workItemId);
                });
                await Promise.all(tasks);
                assert.equal(pool.getActiveWorktrees().size, 0, "All worktrees must be released");
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("4.2: executes 5 concurrent GraphBroker applyProposal CAS attempts: exactly 1 succeeds and 4 fail gracefully", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t5-cas-contention-"));
            try {
                const initialGraph = {
                    schemaVersion: 2,
                    graphId: "graph-cas-race",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "root", title: "Root Node", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
                    ],
                    edges: [],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(initialGraph, null, 2));
                initializeGraphStore(tempDir);
                const broker = new GraphBroker(tempDir);
                const proposals = Array.from({ length: 5 }, (_, i) => ({
                    schemaVersion: 2,
                    proposalId: `prop-race-${i}`,
                    author: `worker-${i}`,
                    reason: `Concurrent addition ${i}`,
                    expectedRevision: 1,
                    operations: [
                        {
                            type: "add_node",
                            node: {
                                id: `node_race_${i}`,
                                title: `Race Node ${i}`,
                                kind: "agent",
                                activation: "all",
                                completionAuthority: "broker",
                                completionAuthorityId: "oma-broker",
                                executor: { adapter: "antigravity-cli", persona: "oma-executor" },
                            },
                        },
                        {
                            type: "add_edge",
                            edge: {
                                id: `edge_race_${i}`,
                                from: "root",
                                to: `node_race_${i}`,
                                when: "success",
                            },
                        },
                    ],
                }));
                const results = await Promise.all(proposals.map((p) => broker.applyProposal(p)));
                const successCount = results.filter((r) => r.success === true).length;
                const failureCount = results.filter((r) => r.success === false).length;
                assert.equal(successCount, 1, "Exactly 1 CAS proposal must succeed");
                assert.equal(failureCount, 4, "The 4 remaining concurrent proposals must fail CAS validation");
                const finalGraph = JSON.parse(readFileSync(join(graphDir, "execution-graph.json"), "utf8"));
                assert.equal(finalGraph.revision, 2);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("4.3: cleans up entire worktree pool cleanly on pool.cleanup()", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t5-pool-clean-"));
            try {
                const pool = new WorktreePool({ workspaceRoot: tempDir });
                await pool.acquire("task-1");
                await pool.acquire("task-2");
                assert.equal(pool.getActiveWorktrees().size, 2);
                await pool.cleanup();
                assert.equal(pool.getActiveWorktrees().size, 0);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // ==================================================================
    // Dimension 5: Non-Progressing / Stagnating Defect Vector Handling
    // ==================================================================
    describe("Dimension 5: Non-Progressing / Stagnating Defect Vector Handling", () => {
        it("5.1: evaluates strict lexicographical defect vector comparison across all boundary matrix states", () => {
            assert.equal(ObjectiveJudge.isProgressing({ hiddenTestsFailing: 2, visibleTestsFailing: 0, gateFailures: 0, openDiagnosticsCount: 0, hiddenTestsPassed: 3, visibleTestsPassed: 3, acceptedWorkItems: 1, totalWorkItems: 1 }, { hiddenTestsFailing: 1, visibleTestsFailing: 5, gateFailures: 0, openDiagnosticsCount: 0, hiddenTestsPassed: 4, visibleTestsPassed: 0, acceptedWorkItems: 1, totalWorkItems: 1 }), true);
            assert.equal(ObjectiveJudge.isProgressing({ hiddenTestsFailing: 0, visibleTestsFailing: 3, gateFailures: 0, openDiagnosticsCount: 0, hiddenTestsPassed: 5, visibleTestsPassed: 0, acceptedWorkItems: 1, totalWorkItems: 1 }, { hiddenTestsFailing: 0, visibleTestsFailing: 1, gateFailures: 0, openDiagnosticsCount: 0, hiddenTestsPassed: 5, visibleTestsPassed: 2, acceptedWorkItems: 1, totalWorkItems: 1 }), true);
            assert.equal(ObjectiveJudge.isProgressing({ hiddenTestsFailing: 1, visibleTestsFailing: 2, gateFailures: 0, openDiagnosticsCount: 0, hiddenTestsPassed: 4, visibleTestsPassed: 1, acceptedWorkItems: 1, totalWorkItems: 1 }, { hiddenTestsFailing: 1, visibleTestsFailing: 2, gateFailures: 0, openDiagnosticsCount: 0, hiddenTestsPassed: 4, visibleTestsPassed: 1, acceptedWorkItems: 1, totalWorkItems: 1 }), false);
            assert.equal(ObjectiveJudge.isProgressing({ hiddenTestsFailing: 0, visibleTestsFailing: 5, gateFailures: 0, openDiagnosticsCount: 0, hiddenTestsPassed: 5, visibleTestsPassed: 0, acceptedWorkItems: 1, totalWorkItems: 1 }, { hiddenTestsFailing: 1, visibleTestsFailing: 0, gateFailures: 0, openDiagnosticsCount: 0, hiddenTestsPassed: 4, visibleTestsPassed: 3, acceptedWorkItems: 1, totalWorkItems: 1 }), false);
        });
        it("5.2: terminates with no_progress_blocked when dynamic workflow encounters consecutive stagnant waves", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t5-stagnation-loop-"));
            try {
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-stagnant-adversarial",
                    baseBundle,
                    limits: { maxRounds: 5, maxConsecutiveNoProgressRounds: 2 },
                    initialWorkItemsSupplier: (wave) => [
                        {
                            scopeId: "src/math.ts",
                            title: `Stagnant Mutant Attempt ${wave}`,
                            filesModified: ["src/math.ts"],
                            modulePatch: { math: mutant1Math },
                            rawDiffContent: `diff --git a/src/math.ts b/src/math.ts\n+stagnant attempt ${wave}`,
                        },
                    ],
                });
                assert.equal(report.status, "no_progress_blocked");
                assert.ok(report.totalWaves <= 3);
                const eventsPath = join(tempDir, ".oma", "missions", "mission-stagnant-adversarial", "events.jsonl");
                const events = MissionEventsStore.readEvents(eventsPath);
                const finishEvent = events.find((e) => e.type === "mission_finished");
                assert.equal(finishEvent?.finalStatus, "no_progress_blocked");
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("5.3: terminates with budget_exhausted when maxRounds limit is exceeded without convergence", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t5-budget-exhaust-"));
            try {
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-budget-adversarial",
                    baseBundle,
                    limits: { maxRounds: 2, maxConsecutiveNoProgressRounds: 10 },
                    initialWorkItemsSupplier: (wave) => [
                        {
                            scopeId: "src/parser.ts",
                            title: `Budget Attempt ${wave}`,
                            filesModified: ["src/parser.ts"],
                            modulePatch: { parser: mutant2Parser },
                            rawDiffContent: `diff --git a/src/parser.ts b/src/parser.ts\n+attempt ${wave}`,
                        },
                    ],
                });
                assert.equal(report.status, "budget_exhausted");
                assert.equal(report.totalWaves, 2);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
});
