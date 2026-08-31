import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeGraphStore, loadGraphRuntime } from "../graph/store.js";
import { GraphBroker } from "../graph/broker.js";
import { calculateProposalDigest } from "../graph/proposal.js";
import { ParallelScheduler } from "../orchestration/scheduler.js";
import { resumeMission } from "../orchestration/resume.js";
import { MockAgyDriver } from "../runtime/mock-driver.js";
import { MissionJournal, subjectDigest } from "../ledger/mission-journal.js";
import { sha256 } from "../ledger/canonical.js";
test("OMA Walking Skeleton: Full End-to-End Multi-Agent Lifecycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "oma-e2e-skeleton-"));
    const graphDir = join(root, ".oma", "graph");
    const ledgerDir = join(root, ".oma", "ledger");
    mkdirSync(graphDir, { recursive: true });
    mkdirSync(ledgerDir, { recursive: true });
    // 1. Initial 1-node DAG: task_1
    const initialGraph = {
        schemaVersion: 2,
        graphId: "e2e-mission-graph",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
            {
                id: "task_1",
                title: "Initial Exploration Task",
                kind: "agent",
                activation: "all",
                completionAuthority: "broker",
                completionAuthorityId: "oma-broker",
                executor: {
                    adapter: "antigravity-cli",
                    persona: "oma-explorer",
                },
            },
        ],
        edges: [],
    };
    writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(initialGraph, null, 2), "utf8");
    const runtime = initializeGraphStore(root);
    try {
        // 2. Dynamic Workflow: Runtime expansion via GraphBroker
        const broker = new GraphBroker(root);
        const rawProposal = {
            schemaVersion: 2,
            proposalId: "prop_dynamic_expansion_1",
            missionId: "e2e-mission",
            proposerPersona: "oma-planner",
            parentRevision: 1,
            parentGraphHash: runtime.graphHash,
            rationale: {
                summary: "Expand graph with implementation task and quality gate based on explorer findings",
            },
            delta: {
                nodesToAdd: [
                    {
                        id: "task_2",
                        title: "Implementation Task",
                        kind: "agent",
                        activation: "all",
                        completionAuthority: "broker",
                        completionAuthorityId: "oma-broker",
                        executor: {
                            adapter: "antigravity-cli",
                            persona: "oma-executor",
                        },
                    },
                    {
                        id: "gate_3",
                        title: "Oracle Quality Gate",
                        kind: "join",
                        activation: "all",
                        completionAuthority: "scheduler",
                        completionAuthorityId: "oma-scheduler",
                    },
                ],
                edgesToAdd: [
                    { id: "e1", from: "task_1", to: "task_2", when: "success" },
                    { id: "e2", from: "task_2", to: "gate_3", when: "success" },
                ],
            },
            resourceBudgetsDelta: {
                maxAdditionalTokens: 10000,
                maxAdditionalTimeMs: 30000,
                maxAdditionalNodes: 2,
            },
        };
        const proposalDigest = calculateProposalDigest(rawProposal);
        const proposal = { ...rawProposal, proposalDigest };
        const expansionResult = await broker.applyProposal(proposal);
        assert.equal(expansionResult.success, true);
        if (expansionResult.success) {
            assert.equal(expansionResult.revision, 2);
        }
        // Verify graph is now revision 2 with 3 nodes
        const runtimeRev2 = loadGraphRuntime(root);
        assert.equal(runtimeRev2.graph.revision, 2);
        assert.equal(runtimeRev2.graph.nodes.length, 3);
        // 3. Parallel Scheduler execution with MockAgyDriver
        const mockDriver = new MockAgyDriver();
        const scheduler = new ParallelScheduler({
            workspaceRoot: root,
            driver: mockDriver,
            maxConcurrency: 2,
        });
        const runResult = await scheduler.run();
        assert.equal(runResult.success, true);
        assert.equal(runResult.completedNodes.length, 3);
        assert.deepEqual(runResult.completedNodes.sort(), ["gate_3", "task_1", "task_2"]);
        // 4. 2-Phase Commit Review & Independent Attestation Pipeline
        const journal = new MissionJournal("e2e-mission", "code-change");
        journal.appendRunStarted({
            missionId: "e2e-mission",
            runKey: "run-worker-1",
            expertId: "oma-executor",
        });
        const txId = "tx-e2e-change-101";
        const diffDigest = sha256("diff-content-e2e");
        journal.appendTransactionStaged({
            runKey: "run-worker-1",
            missionId: "e2e-mission",
            leaseId: "lease-101",
            epoch: "1",
            transactionId: txId,
            stagedDiffDigest: diffDigest,
        });
        // Independent reviewer attestation (Reviewer != Author)
        journal.appendRunStarted({
            missionId: "e2e-mission",
            runKey: "run-reviewer-2",
            expertId: "oma-reviewer",
        });
        const reviewSubject = [{ runKey: "run-worker-1", transactionId: txId, stagedDiffDigest: diffDigest, artifactHashes: [] }];
        journal.appendOracleReviewAttested({
            runKey: "run-reviewer-2",
            reviewerRunKey: "run-reviewer-2",
            missionId: "e2e-mission",
            epoch: "1",
            leaseId: "lease-102",
            subject: reviewSubject,
            subjectDigest: subjectDigest(reviewSubject),
            reviewerVerdict: "approved",
        });
        // Promotion is now authorized
        assert.doesNotThrow(() => {
            journal.assertPromotionAllowed({
                runKey: "run-worker-1",
                missionId: "e2e-mission",
                leaseId: "lease-101",
                epoch: "1",
                transactionId: txId,
                stagedDiffDigest: diffDigest,
                diffDigest,
            });
        });
        // 5. Crash Recovery Simulation
        const recovery = resumeMission({ workspaceRoot: root });
        assert.equal(recovery.resumable, true);
        assert.equal(recovery.recoveredNodes.length, 0); // all nodes had already completed
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
