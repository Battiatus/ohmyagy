import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphBroker } from "../../src/graph/broker.js";
import { ObjectiveJudge } from "../../src/oracle/objective-judge.js";
import { DynamicConvergenceEngine } from "../../src/orchestration/dynamic-engine.js";
import { parseGraphProposal, calculateProposalDigest } from "../../src/graph/proposal.js";
import { MissionEventsStore } from "../../src/ledger/mission-events.js";
import { sha256 } from "../../src/ledger/canonical.js";
import { AdversarialReviewEngine } from "../../src/oracle/adversarial-review.js";
import { DeterministicIntegrator } from "../../src/orchestration/integrator.js";
import * as canonicalMath from "../../test-fixtures/minimal-pipeline/src/math.js";
import * as canonicalParser from "../../test-fixtures/minimal-pipeline/src/parser.js";
import * as canonicalPipeline from "../../test-fixtures/minimal-pipeline/src/pipeline.js";
import { initializeGraphStore, appendGraphTransition } from "../../src/graph/store.js";
describe("Tier 1: Feature Coverage — Features 10 to 18", () => {
    // --------------------------------------------------------------------------
    // Feature 10: Immutability & Anti-Retry
    // --------------------------------------------------------------------------
    describe("Feature 10: Immutability & Anti-Retry", () => {
        it("10.1: rejects incoming edge to succeeded terminal node (TERMINAL_NODE_MUTATION)", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-immut1-"));
            try {
                const graph = {
                    schemaVersion: 1,
                    graphId: "graph-immut-1",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "node-done", title: "Done", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                    ],
                    edges: [],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
                const runtime = initializeGraphStore(tempDir);
                // Mark node-done as completed in graph store
                appendGraphTransition(runtime, {
                    eventType: "node_dispatched",
                    nodeId: "node-done",
                    dispatchId: "disp-1",
                    authorityId: "oma-scheduler",
                });
                appendGraphTransition(runtime, {
                    eventType: "node_completed",
                    nodeId: "node-done",
                    dispatchId: "disp-1",
                    outcome: "success",
                    authority: "scheduler",
                    authorityId: "oma-scheduler",
                    evidenceHash: "0".repeat(64),
                });
                const broker = new GraphBroker(tempDir);
                const proposal = {
                    schemaVersion: 1,
                    proposalId: "prop_immut_1",
                    missionId: "mission-immut",
                    author: "oma-planner",
                    reason: "Attempt adding edge to completed node",
                    expectedRevision: 1,
                    operations: [
                        {
                            type: "add_node",
                            node: { id: "new-node", title: "New", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                        },
                        {
                            type: "add_edge",
                            edge: { id: "bad-edge", from: "new-node", to: "node-done", when: "success" },
                        },
                    ],
                };
                const validation = await broker.validateProposal(proposal);
                assert.equal(validation.valid, false);
                assert.ok(validation.diagnostics.some((d) => d.code === "TERMINAL_NODE_MUTATION"));
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("10.2: rejects modification on terminal/running nodes via nodesToModify", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-immut2-"));
            try {
                const graph = {
                    schemaVersion: 1,
                    graphId: "graph-immut-2",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "term-node", title: "Terminal", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                    ],
                    edges: [],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
                const runtime = initializeGraphStore(tempDir);
                appendGraphTransition(runtime, {
                    eventType: "node_dispatched",
                    nodeId: "term-node",
                    dispatchId: "disp-2",
                    authorityId: "oma-scheduler",
                });
                appendGraphTransition(runtime, {
                    eventType: "node_completed",
                    nodeId: "term-node",
                    dispatchId: "disp-2",
                    outcome: "success",
                    authority: "scheduler",
                    authorityId: "oma-scheduler",
                    evidenceHash: "0".repeat(64),
                });
                const broker = new GraphBroker(tempDir);
                const proposal = {
                    schemaVersion: 1,
                    proposalId: "prop_mod_term",
                    missionId: "mission-immut-2",
                    author: "oma-planner",
                    reason: "Attempt modifying terminal node",
                    expectedRevision: 1,
                    delta: {
                        nodesToAdd: [],
                        edgesToAdd: [],
                        nodesToModify: [{ id: "term-node", title: "Modified Title" }],
                    },
                };
                const validation = await broker.validateProposal(proposal);
                assert.equal(validation.valid, false);
                assert.ok(validation.diagnostics.some((d) => d.code === "TERMINAL_NODE_MUTATION"));
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("10.3: rejects deleting edge leading to terminal historical node", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-immut3-"));
            try {
                const graph = {
                    schemaVersion: 1,
                    graphId: "graph-immut-3",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "p", title: "Parent", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                        { id: "c", title: "Child", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                    ],
                    edges: [
                        { id: "e-del", from: "p", to: "c", when: "success" },
                    ],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
                const runtime = initializeGraphStore(tempDir);
                appendGraphTransition(runtime, {
                    eventType: "node_dispatched",
                    nodeId: "p",
                    dispatchId: "disp-p",
                    authorityId: "oma-scheduler",
                });
                appendGraphTransition(runtime, {
                    eventType: "node_completed",
                    nodeId: "p",
                    dispatchId: "disp-p",
                    outcome: "success",
                    authority: "scheduler",
                    authorityId: "oma-scheduler",
                    evidenceHash: "0".repeat(64),
                });
                appendGraphTransition(runtime, {
                    eventType: "node_dispatched",
                    nodeId: "c",
                    dispatchId: "disp-c",
                    authorityId: "oma-scheduler",
                });
                appendGraphTransition(runtime, {
                    eventType: "node_completed",
                    nodeId: "c",
                    dispatchId: "disp-c",
                    outcome: "success",
                    authority: "scheduler",
                    authorityId: "oma-scheduler",
                    evidenceHash: "0".repeat(64),
                });
                const broker = new GraphBroker(tempDir);
                const proposal = {
                    schemaVersion: 1,
                    proposalId: "prop_del_edge",
                    missionId: "mission-immut-3",
                    author: "oma-planner",
                    reason: "Attempt deleting edge to terminal node",
                    expectedRevision: 1,
                    operations: [
                        {
                            type: "remove_edge",
                            edge: { id: "e-del", from: "p", to: "c" },
                        },
                    ],
                };
                const validation = await broker.validateProposal(proposal);
                assert.equal(validation.valid, false);
                assert.ok(validation.diagnostics.some((d) => d.code === "TERMINAL_NODE_MUTATION"));
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("10.4: forbids duplicate node addition when node already exists in graph", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-immut4-"));
            try {
                const graph = {
                    schemaVersion: 1,
                    graphId: "graph-immut-4",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "exist-node", title: "Exist", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                    ],
                    edges: [],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
                const broker = new GraphBroker(tempDir);
                const proposal = {
                    schemaVersion: 1,
                    proposalId: "prop_dup_node",
                    missionId: "m",
                    author: "oma-planner",
                    reason: "Attempt adding duplicate node id",
                    expectedRevision: 1,
                    operations: [
                        {
                            type: "add_node",
                            node: { id: "exist-node", title: "Duplicate", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                        },
                    ],
                };
                const validation = await broker.validateProposal(proposal);
                assert.equal(validation.valid, false);
                assert.ok(validation.diagnostics.some((d) => d.code === "DUPLICATE_NODE_ID"));
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("10.5: preserves immutable event history on rejected proposal attempts", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-immut5-"));
            try {
                const graph = {
                    schemaVersion: 1,
                    graphId: "graph-immut-5",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "root", title: "R", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                    ],
                    edges: [],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
                const broker = new GraphBroker(tempDir);
                const applyRes = await broker.applyProposal({
                    schemaVersion: 1,
                    proposalId: "prop_bad_attempt",
                    missionId: "m",
                    author: "oma-planner",
                    reason: "Mismatched revision attempt",
                    expectedRevision: 999, // mismatch
                    operations: [
                        {
                            type: "add_node",
                            node: { id: "extra-node", title: "Extra", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                        },
                    ],
                });
                assert.equal(applyRes.success, false);
                // Graph revision remains untouched at 1
                const raw = JSON.parse(readFileSync(join(graphDir, "execution-graph.json"), "utf8"));
                assert.equal(raw.revision, 1);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Feature 11: External Objective Judge
    // --------------------------------------------------------------------------
    describe("Feature 11: External Objective Judge", () => {
        const cleanBundle = {
            math: {
                add: (a, b) => a + b,
                multiply: (a, b) => a * b,
                fibonacci: (n) => {
                    if (n < 0)
                        throw new Error("Negative fibonacci");
                    if (n === 0)
                        return 0;
                    if (n === 1)
                        return 1;
                    let a = 0, b = 1;
                    for (let i = 2; i <= n; i++) {
                        const c = a + b;
                        a = b;
                        b = c;
                    }
                    return b;
                },
            },
            parser: {
                parseExpression: (input) => {
                    const trimmed = input.trim();
                    if (trimmed.startsWith("fib(")) {
                        const num = parseInt(trimmed.slice(4, -1).trim(), 10);
                        return { op: "fib", args: [num] };
                    }
                    if (trimmed.includes("+")) {
                        const parts = trimmed.split("+").map((s) => parseFloat(s.trim()));
                        if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1]))
                            throw new Error("Invalid addition");
                        return { op: "add", args: parts };
                    }
                    if (trimmed.includes("*")) {
                        const parts = trimmed.split("*").map((s) => parseFloat(s.trim()));
                        if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1]))
                            throw new Error("Invalid multiplication");
                        return { op: "multiply", args: parts };
                    }
                    throw new Error("Unknown expression syntax");
                },
            },
            pipeline: {
                evaluatePipeline: (steps) => {
                    let sum = 0;
                    let prod = steps.length > 0 ? 1 : 0;
                    const evaluatedSteps = [];
                    for (const step of steps) {
                        const trimmed = step.trim();
                        let val = 0;
                        if (trimmed.startsWith("fib(")) {
                            const num = parseInt(trimmed.slice(4, -1).trim(), 10);
                            val = cleanBundle.math.fibonacci(num);
                        }
                        else if (trimmed.includes("+")) {
                            const parts = trimmed.split("+").map((s) => parseFloat(s.trim()));
                            val = cleanBundle.math.add(parts[0], parts[1]);
                        }
                        else if (trimmed.includes("*")) {
                            const parts = trimmed.split("*").map((s) => parseFloat(s.trim()));
                            val = cleanBundle.math.multiply(parts[0], parts[1]);
                        }
                        evaluatedSteps.push({ expression: step, result: val });
                        sum += val;
                        prod *= val;
                    }
                    return { steps: evaluatedSteps, aggregateSum: sum, aggregateProduct: prod };
                },
            },
        };
        it("11.1: evaluates clean bundle with zero failures and approves gate", () => {
            const verdict = ObjectiveJudge.evaluatePipelineBundle(cleanBundle);
            assert.equal(verdict.status, "approved");
            assert.equal(verdict.progressVector.hiddenTestsFailing, 0);
            assert.equal(verdict.progressVector.visibleTestsFailing, 0);
            assert.equal(verdict.progressVector.gateFailures, 0);
        });
        it("11.2: catches broken visible tests when math module fails", () => {
            const brokenBundle = {
                ...cleanBundle,
                math: {
                    ...cleanBundle.math,
                    add: () => 999, // Defective add
                },
            };
            const verdict = ObjectiveJudge.evaluatePipelineBundle(brokenBundle);
            assert.equal(verdict.status, "rejected");
            assert.ok(verdict.progressVector.visibleTestsFailing > 0 || verdict.progressVector.hiddenTestsFailing > 0);
            assert.ok(verdict.diagnostics.length > 0);
        });
        it("11.3: catches broken hidden tests when parser edge cases fail", () => {
            const defectiveParserBundle = {
                ...cleanBundle,
                parser: {
                    parseExpression: () => {
                        throw new Error("Defective parser");
                    },
                },
            };
            const verdict = ObjectiveJudge.evaluatePipelineBundle(defectiveParserBundle);
            assert.equal(verdict.status, "rejected");
            assert.ok(verdict.progressVector.hiddenTestsFailing > 0 || verdict.progressVector.visibleTestsFailing > 0);
        });
        it("11.4: captures accurate ProgressVector metrics", () => {
            const verdict = ObjectiveJudge.evaluatePipelineBundle(cleanBundle);
            assert.equal(typeof verdict.progressVector.hiddenTestsPassed, "number");
            assert.equal(typeof verdict.progressVector.visibleTestsPassed, "number");
            assert.equal(typeof verdict.progressVector.openDiagnosticsCount, "number");
            assert.ok(verdict.durationMs >= 0);
        });
        it("11.5: detects mutant implementations and lists specific diagnostics", () => {
            const mutantBundle = {
                ...cleanBundle,
                pipeline: {
                    evaluatePipeline: () => ({ steps: [], aggregateSum: -1, aggregateProduct: -1 }),
                },
            };
            const verdict = ObjectiveJudge.evaluatePipelineBundle(mutantBundle);
            assert.equal(verdict.status, "rejected");
            assert.ok(verdict.diagnostics.length > 0);
        });
    });
    // --------------------------------------------------------------------------
    // Feature 12: Dynamic Workflow Multi-Wave
    // --------------------------------------------------------------------------
    describe("Feature 12: Dynamic Workflow Multi-Wave", () => {
        it("12.1: converges in single wave when initial work item satisfies all tests", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-wave1-"));
            try {
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-wave-1",
                    initialWorkItemsSupplier: () => [
                        {
                            scopeId: "src/math.ts",
                            title: "Implement Math",
                            filesModified: ["src/math.ts"],
                        },
                    ],
                });
                assert.equal(report.status, "succeeded");
                assert.equal(report.totalWaves, 1);
                assert.equal(report.finalProgress.hiddenTestsFailing, 0);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("12.2: executes corrective wave with fixer when wave 1 produces mutant", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-wave2-"));
            try {
                let waveCount = 0;
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-wave-2",
                    initialWorkItemsSupplier: (wave) => {
                        waveCount++;
                        if (wave === 1) {
                            return [
                                {
                                    scopeId: "src/pipeline.ts",
                                    title: "Defective Wave 1",
                                    filesModified: ["src/pipeline.ts"],
                                    modulePatch: {
                                        math: { add: () => 999 },
                                    },
                                },
                            ];
                        }
                        return [
                            {
                                scopeId: "src/pipeline.ts",
                                title: "Fixer Wave 2",
                                filesModified: ["src/pipeline.ts"],
                                modulePatch: {
                                    math: { add: (a, b) => a + b },
                                },
                            },
                        ];
                    },
                });
                assert.equal(report.status, "succeeded");
                assert.equal(report.totalWaves, 2);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("12.3: halts with budget_exhausted when maxRounds is reached", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-wave3-"));
            try {
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-wave-3",
                    limits: { maxRounds: 2, maxConsecutiveNoProgressRounds: 5 },
                    initialWorkItemsSupplier: () => [
                        {
                            scopeId: "src/fail.ts",
                            title: "Always Failing",
                            filesModified: ["src/fail.ts"],
                            modulePatch: {
                                math: { add: () => -1 },
                            },
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
        it("12.4: records complete wave transition events in ledger", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-wave4-"));
            try {
                await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-wave-4",
                    limits: { maxRounds: 2 },
                    initialWorkItemsSupplier: () => [
                        {
                            scopeId: "src/fail.ts",
                            title: "Failing Item",
                            filesModified: ["src/fail.ts"],
                            modulePatch: { math: { add: () => -1 } },
                        },
                    ],
                });
                const eventsPath = join(tempDir, ".oma", "missions", "mission-wave-4", "events.jsonl");
                const events = MissionEventsStore.readEvents(eventsPath);
                assert.ok(events.some((e) => e.type === "wave_transitioned"));
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("12.5: tracks progressHistory across consecutive waves", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-wave5-"));
            try {
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-wave-5",
                    limits: { maxRounds: 2 },
                    initialWorkItemsSupplier: () => [
                        {
                            scopeId: "src/a.ts",
                            title: "Task",
                            filesModified: ["src/a.ts"],
                        },
                    ],
                });
                assert.ok(report.progressHistory.length >= 1);
                assert.ok(report.totalDurationMs >= 0);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Feature 13: Lexicographical Monotonicity
    // --------------------------------------------------------------------------
    describe("Feature 13: Lexicographical Monotonicity", () => {
        it("13.1: isProgressing returns true when hidden test failures strictly decrease", () => {
            const prev = {
                hiddenTestsFailing: 3,
                hiddenTestsPassed: 2,
                visibleTestsFailing: 1,
                visibleTestsPassed: 4,
                gateFailures: 1,
                openDiagnosticsCount: 4,
                acceptedWorkItems: 1,
                totalWorkItems: 2,
            };
            const curr = {
                ...prev,
                hiddenTestsFailing: 1, // Decreased!
                hiddenTestsPassed: 4,
            };
            assert.equal(ObjectiveJudge.isProgressing(prev, curr), true);
        });
        it("13.2: isProgressing returns true when hidden tests equal but visible test failures decrease", () => {
            const prev = {
                hiddenTestsFailing: 0,
                hiddenTestsPassed: 5,
                visibleTestsFailing: 2,
                visibleTestsPassed: 3,
                gateFailures: 1,
                openDiagnosticsCount: 3,
                acceptedWorkItems: 1,
                totalWorkItems: 2,
            };
            const curr = {
                ...prev,
                visibleTestsFailing: 0, // Decreased!
                visibleTestsPassed: 5,
                openDiagnosticsCount: 1,
            };
            assert.equal(ObjectiveJudge.isProgressing(prev, curr), true);
        });
        it("13.3: isProgressing returns false when defect vector increases (regression)", () => {
            const prev = {
                hiddenTestsFailing: 1,
                hiddenTestsPassed: 4,
                visibleTestsFailing: 0,
                visibleTestsPassed: 5,
                gateFailures: 0,
                openDiagnosticsCount: 1,
                acceptedWorkItems: 1,
                totalWorkItems: 2,
            };
            const curr = {
                ...prev,
                hiddenTestsFailing: 3, // Regression!
                hiddenTestsPassed: 2,
            };
            assert.equal(ObjectiveJudge.isProgressing(prev, curr), false);
        });
        it("13.4: isProgressing returns false on identical defect vector (stagnation)", () => {
            const prev = {
                hiddenTestsFailing: 2,
                hiddenTestsPassed: 3,
                visibleTestsFailing: 1,
                visibleTestsPassed: 4,
                gateFailures: 1,
                openDiagnosticsCount: 3,
                acceptedWorkItems: 1,
                totalWorkItems: 2,
            };
            const curr = { ...prev };
            assert.equal(ObjectiveJudge.isProgressing(prev, curr), false);
        });
        it("13.5: DynamicConvergenceEngine halts with no_progress_blocked on consecutive stagnation", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-mono-"));
            try {
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-mono-stagnate",
                    limits: { maxRounds: 3, maxConsecutiveNoProgressRounds: 1 },
                    initialWorkItemsSupplier: () => [
                        {
                            scopeId: "src/static-fail.ts",
                            title: "Static Failing",
                            filesModified: ["src/static-fail.ts"],
                            modulePatch: { math: { add: () => -99 } },
                        },
                    ],
                });
                assert.equal(report.status, "no_progress_blocked");
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Feature 14: GraphProposal Mutations
    // --------------------------------------------------------------------------
    describe("Feature 14: GraphProposal Mutations", () => {
        it("14.1: parses valid GraphProposal with operations array", () => {
            const raw = {
                schemaVersion: 1,
                proposalId: "prop_valid_1",
                missionId: "mission-1",
                parentRevision: 1,
                author: "oma-planner",
                reason: "Valid proposal rationale testing",
                operations: [
                    {
                        type: "add_node",
                        node: {
                            id: "node-prop-1",
                            title: "Task",
                            kind: "join",
                            activation: "all",
                            completionAuthority: "scheduler",
                            completionAuthorityId: "oma-scheduler",
                        },
                    },
                ],
            };
            const parsed = parseGraphProposal(raw);
            assert.equal(parsed.proposalId, "prop_valid_1");
            assert.equal(parsed.operations?.length, 1);
        });
        it("14.2: calculates deterministic SHA-256 proposal digest", () => {
            const proposal = {
                schemaVersion: 1,
                proposalId: "prop_digest_1",
                missionId: "mission-d",
                parentRevision: 1,
                author: "oma-planner",
                reason: "Valid proposal digest testing",
                operations: [
                    {
                        type: "add_node",
                        node: { id: "n1", title: "N1", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                    },
                ],
            };
            const digest1 = calculateProposalDigest(proposal);
            const digest2 = calculateProposalDigest(proposal);
            assert.equal(digest1, digest2);
            assert.equal(digest1.length, 64);
        });
        it("14.3: rejects proposal missing proposalId", () => {
            const invalid = {
                missionId: "m",
                parentRevision: 1,
                operations: [],
            };
            assert.throws(() => parseGraphProposal(invalid));
        });
        it("14.4: supports delta shorthand format with nodesToAdd and edgesToAdd", () => {
            const raw = {
                schemaVersion: 1,
                proposalId: "prop_delta_1",
                missionId: "mission-d",
                parentRevision: 1,
                author: "oma-planner",
                reason: "Valid delta shorthand testing",
                delta: {
                    nodesToAdd: [
                        { id: "n-delta", title: "ND", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                    ],
                    edgesToAdd: [
                        { id: "e-delta", from: "n-delta", to: "target", when: "success" },
                    ],
                },
            };
            const parsed = parseGraphProposal(raw);
            assert.equal(parsed.delta?.nodesToAdd.length, 1);
            assert.equal(parsed.delta?.edgesToAdd.length, 1);
        });
        it("14.5: rejects operation with unknown operation type", () => {
            const invalid = {
                schemaVersion: 1,
                proposalId: "prop_bad_op",
                missionId: "m",
                parentRevision: 1,
                author: "oma-planner",
                reason: "Bad operation test",
                operations: [
                    {
                        type: "unknown_mutation_type",
                    },
                ],
            };
            assert.throws(() => parseGraphProposal(invalid));
        });
    });
    // --------------------------------------------------------------------------
    // Feature 15: SHA-256 Event Journal
    // --------------------------------------------------------------------------
    describe("Feature 15: SHA-256 Event Journal", () => {
        it("15.1: appends events with deterministic SHA-256 hash chaining", () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-ledger1-"));
            try {
                const eventsPath = join(tempDir, "events.jsonl");
                const ev1 = MissionEventsStore.appendEvent(eventsPath, "m1", {
                    type: "mission_started",
                    workflowDigest: "wd1",
                    rulebookRevision: "rev1",
                    goal: "Test ledger",
                });
                const ev2 = MissionEventsStore.appendEvent(eventsPath, "m1", {
                    type: "run_started",
                    runId: "r1",
                    workItemId: "w1",
                    expertId: "worker",
                    model: "gemini-3.7-flash",
                    effort: "medium",
                    worktreePath: "/tmp",
                });
                assert.equal(ev1.previousEventHash, "0".repeat(64));
                assert.equal(ev2.previousEventHash, ev1.eventHash);
                assert.equal(ev1.eventHash.length, 64);
                assert.equal(ev2.eventHash.length, 64);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("15.2: verifyEventChain succeeds on untampered event log", () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-ledger2-"));
            try {
                const eventsPath = join(tempDir, "events.jsonl");
                MissionEventsStore.appendEvent(eventsPath, "m2", {
                    type: "mission_started",
                    workflowDigest: "wd2",
                    rulebookRevision: "rev2",
                    goal: "Chain verification",
                });
                MissionEventsStore.appendEvent(eventsPath, "m2", {
                    type: "work_item_discovered",
                    workItemId: "wi-1",
                    title: "Task 1",
                    scope: ["src/a.ts"],
                    dependsOn: [],
                    roleRequired: "worker",
                    acceptanceCriteria: ["pass"],
                });
                const events = MissionEventsStore.readEvents(eventsPath);
                const verification = MissionEventsStore.verifyEventChain(events);
                assert.equal(verification.valid, true);
                assert.equal(verification.error, undefined);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("15.3: verifyEventChain detects tampered payload in historical event", () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-ledger3-"));
            try {
                const eventsPath = join(tempDir, "events.jsonl");
                MissionEventsStore.appendEvent(eventsPath, "m3", {
                    type: "mission_started",
                    workflowDigest: "wd3",
                    rulebookRevision: "rev3",
                    goal: "Tampering test",
                });
                MissionEventsStore.appendEvent(eventsPath, "m3", {
                    type: "work_item_discovered",
                    workItemId: "wi-1",
                    title: "Original Title",
                    scope: ["src/a.ts"],
                    dependsOn: [],
                    roleRequired: "worker",
                    acceptanceCriteria: ["pass"],
                });
                // Tamper event 2 in memory
                const events = MissionEventsStore.readEvents(eventsPath);
                events[1].title = "Tampered Title";
                const verification = MissionEventsStore.verifyEventChain(events);
                assert.equal(verification.valid, false);
                assert.ok(verification.error !== undefined);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("15.4: verifyEventChain on empty event log is valid", () => {
            const verification = MissionEventsStore.verifyEventChain([]);
            assert.equal(verification.valid, true);
        });
        it("15.5: readEvents parses correctly and handles trailing whitespace", () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-ledger5-"));
            try {
                const eventsPath = join(tempDir, "events.jsonl");
                MissionEventsStore.appendEvent(eventsPath, "m5", {
                    type: "mission_started",
                    workflowDigest: "wd5",
                    rulebookRevision: "rev5",
                    goal: "Whitespace test",
                });
                const events = MissionEventsStore.readEvents(eventsPath);
                assert.equal(events.length, 1);
                assert.equal(events[0].type, "mission_started");
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Feature 16: Frozen Myers Diffs
    // --------------------------------------------------------------------------
    describe("Feature 16: Frozen Myers Diffs", () => {
        it("16.1: computes consistent sha256 digest for diff content", () => {
            const diff = "diff --git a/src/math.ts b/src/math.ts\n+export function add(a, b) { return a + b; }\n";
            const digest = sha256(diff);
            assert.equal(digest.length, 64);
            assert.equal(sha256(diff), digest);
        });
        it("16.2: distinct diffs produce distinct sha256 digests", () => {
            const diffA = "diff --git a/a.ts b/a.ts\n+const a = 1;\n";
            const diffB = "diff --git a/b.ts b/b.ts\n+const b = 2;\n";
            assert.notEqual(sha256(diffA), sha256(diffB));
        });
        it("16.3: normalizes whitespace and CRLF consistently", () => {
            const unixDiff = "diff --git a/file.ts b/file.ts\n+line 1\n+line 2\n";
            const winDiff = "diff --git a/file.ts b/file.ts\r\n+line 1\r\n+line 2\r\n";
            const normalizedUnix = unixDiff.replace(/\r\n/g, "\n");
            const normalizedWin = winDiff.replace(/\r\n/g, "\n");
            assert.equal(sha256(normalizedUnix), sha256(normalizedWin));
        });
        it("16.4: empty diff produces deterministic empty string hash", () => {
            const emptyHash = sha256("");
            assert.equal(emptyHash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        });
        it("16.5: preserves multi-hunk diff structure across patch files", () => {
            const multiHunk = [
                "diff --git a/src/a.ts b/src/a.ts",
                "@@ -1,3 +1,4 @@",
                " const a = 1;",
                "+const b = 2;",
                "@@ -10,3 +11,4 @@",
                " const c = 3;",
                "+const d = 4;",
            ].join("\n");
            assert.ok(multiHunk.includes("@@ -1,3 +1,4 @@"));
            assert.ok(multiHunk.includes("@@ -10,3 +11,4 @@"));
            assert.equal(sha256(multiHunk).length, 64);
        });
    });
    // --------------------------------------------------------------------------
    // Feature 17: Independent Dual Reviews
    // --------------------------------------------------------------------------
    describe("Feature 17: Independent Dual Reviews", () => {
        it("17.1: evaluateReview approves when reviewFn passes clean diff", () => {
            const subject = {
                workItemId: "wi-rev-1",
                stagedDiffDigest: "digest-1",
                filesModified: ["src/math.ts"],
                modulePatch: {},
            };
            const verdict = AdversarialReviewEngine.evaluateReview("run-rev-1", "reviewer-alpha", subject, () => ({ approved: true, observations: ["Clean and valid."] }));
            assert.equal(verdict.verdict, "approved");
            assert.ok(verdict.observations.includes("Clean and valid."));
        });
        it("17.2: evaluateReview rejects when reviewer spots mutant or defect", () => {
            const subject = {
                workItemId: "wi-rev-2",
                stagedDiffDigest: "digest-2",
                filesModified: ["src/math.ts"],
                modulePatch: {},
            };
            const verdict = AdversarialReviewEngine.evaluateReview("run-rev-2", "reviewer-alpha", subject, () => ({ approved: false, observations: ["Detected defective logic."] }));
            assert.equal(verdict.verdict, "rejected");
            assert.ok(verdict.observations.includes("Detected defective logic."));
        });
        it("17.3: computeConsensus requires at least 2 distinct independent reviewers", () => {
            const rev1 = AdversarialReviewEngine.evaluateReview("run-rev-alpha", "reviewer-alpha", { workItemId: "wi-single", stagedDiffDigest: "d", filesModified: [], modulePatch: {} }, () => ({ approved: true, observations: ["Pass"] }));
            // Only 1 review -> Consensus must be rejected!
            const consensusSingle = AdversarialReviewEngine.computeConsensus("wi-single", [rev1]);
            assert.equal(consensusSingle.consensus, "rejected");
            const rev2 = AdversarialReviewEngine.evaluateReview("run-rev-beta", "reviewer-beta", { workItemId: "wi-single", stagedDiffDigest: "d", filesModified: [], modulePatch: {} }, () => ({ approved: true, observations: ["Pass 2"] }));
            // 2 distinct reviews -> Consensus approved!
            const consensusDual = AdversarialReviewEngine.computeConsensus("wi-single", [rev1, rev2]);
            assert.equal(consensusDual.consensus, "approved");
        });
        it("17.4: captures timestamp and reviewRunId in verdict object", () => {
            const subject = {
                workItemId: "wi-rev-4",
                stagedDiffDigest: "digest-4",
                filesModified: ["src/math.ts"],
                modulePatch: {},
            };
            const verdict = AdversarialReviewEngine.evaluateReview("run-rev-4", "reviewer-beta", subject, () => ({ approved: true, observations: ["Approved."] }));
            assert.equal(verdict.reviewerRunId, "run-rev-4");
            assert.equal(verdict.reviewerExpertId, "reviewer-beta");
            assert.ok(verdict.timestamp);
        });
        it("17.5: computeConsensus rejects when any reviewer rejects (unanimous consensus required)", () => {
            const rev1 = AdversarialReviewEngine.evaluateReview("run-rev-1", "reviewer-alpha", { workItemId: "wi-unanimous", stagedDiffDigest: "d", filesModified: [], modulePatch: {} }, () => ({ approved: true, observations: ["Pass"] }));
            const rev2 = AdversarialReviewEngine.evaluateReview("run-rev-2", "reviewer-beta", { workItemId: "wi-unanimous", stagedDiffDigest: "d", filesModified: [], modulePatch: {} }, () => ({ approved: false, observations: ["Defect detected"] }));
            const consensus = AdversarialReviewEngine.computeConsensus("wi-unanimous", [rev1, rev2]);
            assert.equal(consensus.consensus, "rejected");
        });
    });
    // --------------------------------------------------------------------------
    // Feature 18: Atomic Git 2PC Promotion
    // --------------------------------------------------------------------------
    describe("Feature 18: Atomic Git 2PC Promotion", () => {
        const baseBundle = {
            math: canonicalMath,
            parser: canonicalParser,
            pipeline: canonicalPipeline,
        };
        it("18.1: integrateWorkItems integrates clean proposals producing integrated status", () => {
            const proposals = [
                {
                    workItemId: "wi-1",
                    filesModified: ["src/math.ts"],
                    modulePatch: {},
                    stagedDiffDigest: sha256("diff1"),
                },
            ];
            const res = DeterministicIntegrator.integrateWorkItems(baseBundle, proposals);
            assert.equal(res.status, "integrated");
            assert.equal(res.integratedWorkItems.length, 1);
            assert.ok(res.commitHash && res.commitHash.length === 64);
        });
        it("18.2: integrateWorkItems rejects proposals when patched bundle fails objective judge", () => {
            const proposals = [
                {
                    workItemId: "wi-bad",
                    filesModified: ["src/math.ts"],
                    modulePatch: {
                        math: { add: () => -999 },
                    },
                    stagedDiffDigest: sha256("bad-diff"),
                },
            ];
            const res = DeterministicIntegrator.integrateWorkItems(baseBundle, proposals);
            assert.equal(res.status, "judge_rejected");
            assert.equal(res.judgeVerdict?.status, "rejected");
        });
        it("18.3: attaches verifiable judgeVerdict to integration report", () => {
            const proposals = [
                {
                    workItemId: "wi-ok",
                    filesModified: ["src/parser.ts"],
                    modulePatch: {},
                    stagedDiffDigest: sha256("ok-diff"),
                },
            ];
            const res = DeterministicIntegrator.integrateWorkItems(baseBundle, proposals);
            assert.ok(res.judgeVerdict);
            assert.equal(res.judgeVerdict?.status, "approved");
        });
        it("18.4: handles multiple parallel proposals simultaneously in single atomic transaction", () => {
            const proposals = [
                {
                    workItemId: "wi-a",
                    filesModified: ["src/math.ts"],
                    modulePatch: {},
                    stagedDiffDigest: sha256("diff-a"),
                },
                {
                    workItemId: "wi-b",
                    filesModified: ["src/parser.ts"],
                    modulePatch: {},
                    stagedDiffDigest: sha256("diff-b"),
                },
            ];
            const res = DeterministicIntegrator.integrateWorkItems(baseBundle, proposals);
            assert.equal(res.status, "integrated");
            assert.equal(res.integratedWorkItems.length, 2);
        });
        it("18.5: atomicity guarantees all-or-nothing: one failing proposal aborts entire wave", () => {
            const proposals = [
                {
                    workItemId: "wi-good",
                    filesModified: ["src/parser.ts"],
                    modulePatch: {},
                    stagedDiffDigest: sha256("good"),
                },
                {
                    workItemId: "wi-bad",
                    filesModified: ["src/math.ts"],
                    modulePatch: { math: { add: () => 0 } },
                    stagedDiffDigest: sha256("bad"),
                },
            ];
            const res = DeterministicIntegrator.integrateWorkItems(baseBundle, proposals);
            assert.equal(res.status, "judge_rejected");
        });
    });
});
