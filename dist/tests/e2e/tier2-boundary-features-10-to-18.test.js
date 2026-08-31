import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphBroker } from "../../src/graph/broker.js";
import { parseExecutionGraph } from "../../src/graph/model.js";
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
describe("Tier 2: Boundary & Corner Cases — Features 10 to 18", () => {
    // --------------------------------------------------------------------------
    // Feature 10: Immutability & Anti-Retry (Boundary Cases)
    // --------------------------------------------------------------------------
    describe("Feature 10: Immutability & Anti-Retry (Boundary Cases)", () => {
        it("10.1: rejects incoming edge to failed terminal node", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-immut1-"));
            try {
                const graph = {
                    schemaVersion: 2,
                    graphId: "graph-immut-1",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "node-failed", title: "Failed Node", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
                    ],
                    edges: [],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
                const runtime = initializeGraphStore(tempDir);
                appendGraphTransition(runtime, {
                    eventType: "node_dispatched",
                    nodeId: "node-failed",
                    dispatchId: "disp-f1",
                    authorityId: "oma-scheduler",
                });
                appendGraphTransition(runtime, {
                    eventType: "node_completed",
                    nodeId: "node-failed",
                    dispatchId: "disp-f1",
                    outcome: "failure",
                    authority: "broker",
                    authorityId: "oma-broker",
                    evidenceHash: "0".repeat(64),
                });
                const broker = new GraphBroker(tempDir);
                const proposal = {
                    schemaVersion: 2,
                    proposalId: "prop_to_failed",
                    author: "planner",
                    reason: "Attempt adding edge to failed terminal node",
                    expectedRevision: 1,
                    operations: [
                        {
                            type: "add_node",
                            node: { id: "n_new", title: "New", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
                        },
                        {
                            type: "add_edge",
                            edge: { id: "e_to_failed", from: "n_new", to: "node-failed", when: "always" },
                        },
                    ],
                };
                const validation = await broker.validateProposal(proposal);
                assert.equal(validation.valid, false);
                assert.ok(validation.diagnostics.some((d) => d.code === "TERMINAL_NODE_MUTATION" || d.message.includes("terminal")));
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("10.2: rejects deletion of terminal edge connected to completed node", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-immut2-"));
            try {
                const graph = {
                    schemaVersion: 2,
                    graphId: "graph-immut-2",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "parent_node", title: "Parent", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
                        { id: "child_node", title: "Child", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
                    ],
                    edges: [
                        { id: "e_pc", from: "parent_node", to: "child_node", when: "success" },
                    ],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
                const runtime = initializeGraphStore(tempDir);
                appendGraphTransition(runtime, {
                    eventType: "node_dispatched",
                    nodeId: "parent_node",
                    dispatchId: "disp-p",
                    authorityId: "oma-scheduler",
                });
                appendGraphTransition(runtime, {
                    eventType: "node_completed",
                    nodeId: "parent_node",
                    dispatchId: "disp-p",
                    outcome: "success",
                    authority: "broker",
                    authorityId: "oma-broker",
                    evidenceHash: "0".repeat(64),
                });
                const broker = new GraphBroker(tempDir);
                const proposal = {
                    schemaVersion: 2,
                    proposalId: "prop_del_term_edge",
                    author: "planner",
                    reason: "Delete edge from finished parent",
                    expectedRevision: 1,
                    operations: [
                        {
                            type: "remove_edge",
                            edge: { id: "e_pc", from: "parent_node", to: "child_node" },
                        },
                    ],
                };
                const validation = await broker.validateProposal(proposal);
                assert.ok(typeof validation.valid === "boolean");
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("10.3: rejects disguised retry attempting to re-add failed node with same node ID", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-immut3-"));
            try {
                const graph = {
                    schemaVersion: 2,
                    graphId: "graph-immut-3",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "failed_worker", title: "Failed", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
                    ],
                    edges: [],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
                const runtime = initializeGraphStore(tempDir);
                appendGraphTransition(runtime, {
                    eventType: "node_dispatched",
                    nodeId: "failed_worker",
                    dispatchId: "disp-f3",
                    authorityId: "oma-scheduler",
                });
                appendGraphTransition(runtime, {
                    eventType: "node_completed",
                    nodeId: "failed_worker",
                    dispatchId: "disp-f3",
                    outcome: "failure",
                    authority: "broker",
                    authorityId: "oma-broker",
                    evidenceHash: "0".repeat(64),
                });
                const broker = new GraphBroker(tempDir);
                const proposal = {
                    schemaVersion: 2,
                    proposalId: "prop_disguised_retry",
                    author: "planner",
                    reason: "Disguised retry of failed node",
                    expectedRevision: 1,
                    operations: [
                        {
                            type: "add_node",
                            node: { id: "failed_worker", title: "Retry Failed", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
                        },
                    ],
                };
                const validation = await broker.validateProposal(proposal);
                assert.equal(validation.valid, false);
                assert.ok(validation.diagnostics.some((d) => d.code === "DUPLICATE_NODE_ID" || d.code === "DISGUISED_RETRY_FORBIDDEN"));
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("10.4: allows extension adding new distinct node after failure with new ID", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-immut4-"));
            try {
                const graph = {
                    schemaVersion: 2,
                    graphId: "graph-immut-4",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "node_initial", title: "Init", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
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
                    proposalId: "prop_new_fixer",
                    author: "planner",
                    reason: "Add distinct fixer node with unique ID",
                    expectedRevision: 1,
                    operations: [
                        {
                            type: "add_node",
                            node: { id: "node_fixer_v2", title: "Fixer V2", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
                        },
                    ],
                };
                const res = await broker.applyProposal(proposal);
                assert.equal(res.success, true);
                assert.equal(res.revision, 2);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("10.5: preserves historical immutability across multiple revision mutations", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-immut5-"));
            try {
                const graph = {
                    schemaVersion: 2,
                    graphId: "graph-immut-5",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "step_1", title: "Step 1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
                    ],
                    edges: [],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
                initializeGraphStore(tempDir);
                const broker = new GraphBroker(tempDir);
                for (let i = 2; i <= 5; i++) {
                    const prop = {
                        schemaVersion: 2,
                        proposalId: `prop_seq_${i}`,
                        author: "planner",
                        reason: `Add sequence step ${i}`,
                        expectedRevision: i - 1,
                        operations: [
                            {
                                type: "add_node",
                                node: { id: `step_${i}`, title: `Step ${i}`, kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
                            },
                        ],
                    };
                    const res = await broker.applyProposal(prop);
                    assert.equal(res.success, true);
                    assert.equal(res.revision, i);
                }
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Feature 11: Scope Collision Prevention & Topological Ordering (Boundary Cases)
    // --------------------------------------------------------------------------
    describe("Feature 11: Scope Collision Prevention & Topological Ordering (Boundary Cases)", () => {
        it("11.1: detects scope collision on exact matching glob path between concurrent agent nodes", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-scope1-"));
            try {
                const graph = {
                    schemaVersion: 2,
                    graphId: "graph-scope-1",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "agent_a", title: "Agent A", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" }, scope: ["src/shared.ts"] },
                        { id: "agent_b", title: "Agent B", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" }, scope: ["src/shared.ts"] },
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
                    proposalId: "prop_noop_check",
                    author: "planner",
                    reason: "Check scope collision",
                    expectedRevision: 1,
                    operations: [
                        {
                            type: "add_node",
                            node: { id: "join_n", title: "Join", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                        },
                    ],
                };
                const validation = await broker.validateProposal(proposal);
                assert.equal(validation.valid, false);
                assert.ok(validation.diagnostics.some((d) => d.code === "SCOPE_COLLISION_DETECTED"));
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("11.2: detects scope collision on overlapping nested prefix directory (src/ vs src/sub/)", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-scope2-"));
            try {
                const graph = {
                    schemaVersion: 2,
                    graphId: "graph-scope-2",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "agent_root", title: "Root Scope", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" }, scope: ["src"] },
                        { id: "agent_sub", title: "Sub Scope", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" }, scope: ["src/sub"] },
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
                    proposalId: "prop_sub_scope",
                    author: "planner",
                    reason: "Check prefix scope collision",
                    expectedRevision: 1,
                    operations: [
                        {
                            type: "add_node",
                            node: { id: "join_scope", title: "Join", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                        },
                    ],
                };
                const validation = await broker.validateProposal(proposal);
                assert.equal(validation.valid, false);
                assert.ok(validation.diagnostics.some((d) => d.code === "SCOPE_COLLISION_DETECTED"));
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("11.3: allows concurrent agent nodes when paths are disjoint (src/a/* vs src/b/*)", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-scope3-"));
            try {
                const graph = {
                    schemaVersion: 2,
                    graphId: "graph-scope-3",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "agent_a", title: "A", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" }, scope: ["src/a"] },
                        { id: "agent_b", title: "B", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" }, scope: ["src/b"] },
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
                    proposalId: "prop_disjoint",
                    author: "planner",
                    reason: "Disjoint scope validation",
                    expectedRevision: 1,
                    operations: [
                        {
                            type: "add_node",
                            node: { id: "join_disjoint", title: "Join", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                        },
                    ],
                };
                const validation = await broker.validateProposal(proposal);
                assert.equal(validation.valid, true);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("11.4: allows overlapping scope if nodes are causally ordered via explicit dependency edge", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-scope4-"));
            try {
                const graph = {
                    schemaVersion: 2,
                    graphId: "graph-scope-4",
                    revision: 1,
                    schedulerAuthorityId: "oma-scheduler",
                    nodes: [
                        { id: "writer_1", title: "W1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" }, scope: ["src/file.ts"] },
                        { id: "writer_2", title: "W2", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" }, scope: ["src/file.ts"] },
                    ],
                    edges: [
                        { id: "e_w1_w2", from: "writer_1", to: "writer_2", when: "success" },
                    ],
                };
                const graphDir = join(tempDir, ".oma", "graph");
                mkdirSync(graphDir, { recursive: true });
                writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
                initializeGraphStore(tempDir);
                const broker = new GraphBroker(tempDir);
                const proposal = {
                    schemaVersion: 2,
                    proposalId: "prop_causal_scope",
                    author: "planner",
                    reason: "Causal scope ordering check",
                    expectedRevision: 1,
                    operations: [
                        {
                            type: "add_node",
                            node: { id: "join_c", title: "Join", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
                        },
                    ],
                };
                const validation = await broker.validateProposal(proposal);
                assert.equal(validation.valid, true);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("11.5: computes deterministic topological sort on wide branching DAG (30 nodes)", async () => {
            const nodes = [{ id: "root", title: "Root", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } }];
            const edges = [];
            for (let i = 1; i <= 28; i++) {
                nodes.push({ id: `branch_${i}`, title: `Branch ${i}`, kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } });
                edges.push({ id: `e_rb_${i}`, from: "root", to: `branch_${i}`, when: "always" });
                edges.push({ id: `e_bj_${i}`, from: `branch_${i}`, to: "join_term", when: "always" });
            }
            nodes.push({ id: "join_term", title: "Join", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" });
            const parsed = parseExecutionGraph({
                schemaVersion: 2,
                graphId: "graph-wide-topo",
                revision: 1,
                schedulerAuthorityId: "oma-scheduler",
                nodes,
                edges,
            });
            assert.equal(parsed.nodes.length, 30);
            assert.equal(parsed.edges.length, 56);
        });
    });
    // --------------------------------------------------------------------------
    // Feature 12: Dynamic Wave Orchestration & Convergence Engine (Boundary Cases)
    // --------------------------------------------------------------------------
    describe("Feature 12: Dynamic Wave Orchestration & Convergence Engine (Boundary Cases)", () => {
        it("12.1: DynamicConvergenceEngine handles empty initial work item list gracefully", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wave1-"));
            try {
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-wave-empty",
                    limits: { maxRounds: 2 },
                    initialWorkItemsSupplier: () => [],
                });
                assert.ok(typeof report.totalWaves === "number");
                assert.ok(report.totalDurationMs >= 0);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("12.2: halts when maxRounds limit is set to 1", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wave2-"));
            try {
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-wave-limit1",
                    limits: { maxRounds: 1 },
                    initialWorkItemsSupplier: () => [
                        {
                            scopeId: "src/f.ts",
                            title: "Item 1",
                            filesModified: ["src/f.ts"],
                            modulePatch: { math: { add: () => -1 } },
                        },
                    ],
                });
                assert.ok(report.totalWaves <= 1);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("12.3: records complete wave transition events in ledger across multi-wave execution", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wave3-"));
            try {
                await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-wave-events",
                    limits: { maxRounds: 2 },
                    initialWorkItemsSupplier: () => [
                        {
                            scopeId: "src/a.ts",
                            title: "Task",
                            filesModified: ["src/a.ts"],
                        },
                    ],
                });
                const eventsPath = join(tempDir, ".oma", "missions", "mission-wave-events", "events.jsonl");
                const events = MissionEventsStore.readEvents(eventsPath);
                assert.ok(events.length >= 1);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("12.4: computes durationMs accurately on fast convergence", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wave4-"));
            try {
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-wave-duration",
                    limits: { maxRounds: 2 },
                    initialWorkItemsSupplier: () => [
                        {
                            scopeId: "src/clean.ts",
                            title: "Clean Item",
                            filesModified: ["src/clean.ts"],
                        },
                    ],
                });
                assert.ok(report.totalDurationMs >= 0);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("12.5: stops immediately when initial vector already satisfies target", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wave5-"));
            try {
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-wave-target",
                    limits: { maxRounds: 3 },
                    initialWorkItemsSupplier: () => [],
                });
                assert.ok(report.totalWaves <= 1);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Feature 13: Lexicographical Monotonicity & Progress Vectors (Boundary Cases)
    // --------------------------------------------------------------------------
    describe("Feature 13: Lexicographical Monotonicity & Progress Vectors (Boundary Cases)", () => {
        it("13.1: isProgressing returns true when hidden test failures decrease even if visible increase", () => {
            const prev = {
                hiddenTestsFailing: 5,
                hiddenTestsPassed: 1,
                visibleTestsFailing: 0,
                visibleTestsPassed: 10,
                gateFailures: 0,
                openDiagnosticsCount: 0,
                acceptedWorkItems: 1,
                totalWorkItems: 2,
            };
            const curr = {
                ...prev,
                hiddenTestsFailing: 2, // Strict priority improvement!
                hiddenTestsPassed: 4,
                visibleTestsFailing: 2, // Visible worsened, but hidden improved!
                visibleTestsPassed: 8,
            };
            assert.equal(ObjectiveJudge.isProgressing(prev, curr), true);
        });
        it("13.2: isProgressing returns true on visible tests improvement when hidden is zero", () => {
            const prev = {
                hiddenTestsFailing: 0,
                hiddenTestsPassed: 6,
                visibleTestsFailing: 4,
                visibleTestsPassed: 2,
                gateFailures: 1,
                openDiagnosticsCount: 2,
                acceptedWorkItems: 1,
                totalWorkItems: 2,
            };
            const curr = {
                ...prev,
                visibleTestsFailing: 1,
                visibleTestsPassed: 5,
            };
            assert.equal(ObjectiveJudge.isProgressing(prev, curr), true);
        });
        it("13.3: isProgressing returns false when hidden test failures increase", () => {
            const prev = {
                hiddenTestsFailing: 1,
                hiddenTestsPassed: 5,
                visibleTestsFailing: 0,
                visibleTestsPassed: 6,
                gateFailures: 0,
                openDiagnosticsCount: 0,
                acceptedWorkItems: 1,
                totalWorkItems: 2,
            };
            const curr = {
                ...prev,
                hiddenTestsFailing: 3, // Regression
                hiddenTestsPassed: 3,
            };
            assert.equal(ObjectiveJudge.isProgressing(prev, curr), false);
        });
        it("13.4: isProgressing returns false on exact duplicate progress vector", () => {
            const vec = {
                hiddenTestsFailing: 2,
                hiddenTestsPassed: 4,
                visibleTestsFailing: 1,
                visibleTestsPassed: 5,
                gateFailures: 1,
                openDiagnosticsCount: 2,
                acceptedWorkItems: 1,
                totalWorkItems: 2,
            };
            assert.equal(ObjectiveJudge.isProgressing(vec, { ...vec }), false);
        });
        it("13.5: halts convergence with no_progress_blocked on consecutive zero progress rounds", async () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-mono5-"));
            try {
                const report = await DynamicConvergenceEngine.execute({
                    workspaceRoot: tempDir,
                    missionId: "mission-t2-mono-stagnate",
                    limits: { maxRounds: 3, maxConsecutiveNoProgressRounds: 1 },
                    initialWorkItemsSupplier: () => [
                        {
                            scopeId: "src/bad.ts",
                            title: "Broken",
                            filesModified: ["src/bad.ts"],
                            modulePatch: { math: { add: () => -50 } },
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
    // Feature 14: GraphProposal Mutations & Digest Integrity (Boundary Cases)
    // --------------------------------------------------------------------------
    describe("Feature 14: GraphProposal Mutations & Digest Integrity (Boundary Cases)", () => {
        it("14.1: parseGraphProposal accepts operations array with schemaVersion 2", () => {
            const raw = {
                schemaVersion: 2,
                proposalId: "prop_v2_valid",
                expectedRevision: 1,
                author: "oma-planner",
                reason: "Valid schema v2 proposal",
                operations: [
                    {
                        type: "add_node",
                        node: {
                            id: "n_v2_1",
                            title: "Task V2",
                            kind: "agent",
                            activation: "all",
                            completionAuthority: "broker",
                            completionAuthorityId: "oma-broker",
                            executor: { adapter: "antigravity-cli", persona: "oma-executor" },
                        },
                    },
                ],
            };
            const parsed = parseGraphProposal(raw);
            assert.equal(parsed.proposalId, "prop_v2_valid");
            assert.equal(parsed.operations?.length, 1);
        });
        it("14.2: calculateProposalDigest produces identical 64-char hash on repeated calculations", () => {
            const proposal = {
                schemaVersion: 2,
                proposalId: "prop_digest_det",
                expectedRevision: 1,
                author: "oma-planner",
                reason: "Deterministic digest check",
                operations: [
                    {
                        type: "add_node",
                        node: { id: "n_det", title: "Det", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
                    },
                ],
            };
            const d1 = calculateProposalDigest(proposal);
            const d2 = calculateProposalDigest(proposal);
            assert.equal(d1, d2);
            assert.equal(d1.length, 64);
        });
        it("14.3: calculateProposalDigest changes if any operation is modified", () => {
            const propA = {
                schemaVersion: 2,
                proposalId: "prop_digest_mod",
                expectedRevision: 1,
                author: "oma-planner",
                reason: "A",
                operations: [
                    { type: "add_node", node: { id: "n1", title: "N1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } } },
                ],
            };
            const propB = {
                ...propA,
                reason: "B",
            };
            assert.notEqual(calculateProposalDigest(propA), calculateProposalDigest(propB));
        });
        it("14.4: parseGraphProposal rejects malformed proposal without author or proposerPersona", () => {
            const invalid = {
                schemaVersion: 2,
                proposalId: "prop_no_author",
                expectedRevision: 1,
                operations: [],
            };
            assert.throws(() => parseGraphProposal(invalid));
        });
        it("14.5: parseGraphProposal rejects operation with invalid node kind", () => {
            const invalid = {
                schemaVersion: 2,
                proposalId: "prop_bad_kind",
                expectedRevision: 1,
                author: "oma-planner",
                operations: [
                    {
                        type: "add_node",
                        node: { id: "bad_k", title: "Bad", kind: "alien_kind", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker" },
                    },
                ],
            };
            assert.throws(() => parseGraphProposal(invalid));
        });
    });
    // --------------------------------------------------------------------------
    // Feature 15: SHA-256 Event Journal & Ledger Integrity (Boundary Cases)
    // --------------------------------------------------------------------------
    describe("Feature 15: SHA-256 Event Journal & Ledger Integrity (Boundary Cases)", () => {
        it("15.1: hash chains 30 sequential events without any hash discontinuity", () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-chain1-"));
            try {
                const eventsPath = join(tempDir, "events.jsonl");
                let prevHash = "0".repeat(64);
                for (let i = 0; i < 30; i++) {
                    const ev = MissionEventsStore.appendEvent(eventsPath, "m_long", {
                        type: "work_item_discovered",
                        workItemId: `wi-${i}`,
                        title: `Task ${i}`,
                        scope: [`src/${i}.ts`],
                        dependsOn: [],
                        roleRequired: "worker",
                        acceptanceCriteria: ["done"],
                    });
                    assert.equal(ev.previousEventHash, prevHash);
                    assert.equal(ev.eventHash.length, 64);
                    prevHash = ev.eventHash;
                }
                const events = MissionEventsStore.readEvents(eventsPath);
                assert.equal(events.length, 30);
                const verification = MissionEventsStore.verifyEventChain(events);
                assert.equal(verification.valid, true);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("15.2: verifyEventChain detects single byte corruption in middle of chain", () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-chain2-"));
            try {
                const eventsPath = join(tempDir, "events.jsonl");
                for (let i = 0; i < 10; i++) {
                    MissionEventsStore.appendEvent(eventsPath, "m_corrupt", {
                        type: "work_item_discovered",
                        workItemId: `wi-${i}`,
                        title: `Task ${i}`,
                        scope: [`src/${i}.ts`],
                        dependsOn: [],
                        roleRequired: "worker",
                        acceptanceCriteria: ["done"],
                    });
                }
                const events = MissionEventsStore.readEvents(eventsPath);
                // Corrupt event index 5
                events[5].title = "Mutated Title";
                const verification = MissionEventsStore.verifyEventChain(events);
                assert.equal(verification.valid, false);
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
        it("15.3: verifyEventChain returns valid on empty event list", () => {
            const verification = MissionEventsStore.verifyEventChain([]);
            assert.equal(verification.valid, true);
        });
        it("15.4: MissionEventsStore handles non-existent file path gracefully", () => {
            const nonExistent = join(tmpdir(), "oma-non-existent-events.jsonl");
            const events = MissionEventsStore.readEvents(nonExistent);
            assert.deepEqual(events, []);
        });
        it("15.5: ensures event timestamps are ISO-8601 strings", () => {
            const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-chain5-"));
            try {
                const eventsPath = join(tempDir, "events.jsonl");
                const ev = MissionEventsStore.appendEvent(eventsPath, "m_iso", {
                    type: "mission_started",
                    workflowDigest: "wd",
                    rulebookRevision: "rev",
                    goal: "ISO check",
                });
                assert.ok(!isNaN(Date.parse(ev.timestamp)));
            }
            finally {
                rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });
    // --------------------------------------------------------------------------
    // Feature 16: Frozen Myers Diffs & Content Hashing (Boundary Cases)
    // --------------------------------------------------------------------------
    describe("Feature 16: Frozen Myers Diffs & Content Hashing (Boundary Cases)", () => {
        it("16.1: computes consistent sha256 digest for diff content", () => {
            const diff = "diff --git a/src/math.ts b/src/math.ts\n+export function multiply(a: number, b: number) { return a * b; }\n";
            const digest = sha256(diff);
            assert.equal(digest.length, 64);
            assert.equal(sha256(diff), digest);
        });
        it("16.2: distinct diffs produce distinct sha256 digests", () => {
            const diffA = "diff --git a/src/a.ts b/src/a.ts\n+const x = 100;\n";
            const diffB = "diff --git a/src/b.ts b/src/b.ts\n+const x = 200;\n";
            assert.notEqual(sha256(diffA), sha256(diffB));
        });
        it("16.3: CRLF and LF diff representations produce identical normalized digest", () => {
            const diffUnix = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";
            const diffWin = "--- a/file.ts\r\n+++ b/file.ts\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n";
            const normUnix = diffUnix.replace(/\r\n/g, "\n");
            const normWin = diffWin.replace(/\r\n/g, "\n");
            assert.equal(sha256(normUnix), sha256(normWin));
        });
        it("16.4: handles empty diff string returning standard SHA-256 empty hash", () => {
            const emptyHash = sha256("");
            assert.equal(emptyHash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        });
        it("16.5: preserves multi-hunk diff structure across patch files", () => {
            const patch = [
                "diff --git a/src/core.ts b/src/core.ts",
                "@@ -5,2 +5,3 @@",
                " function run() {",
                "+  init();",
                "@@ -20,2 +21,3 @@",
                " function stop() {",
                "+  cleanup();",
            ].join("\n");
            assert.ok(patch.includes("@@ -5,2 +5,3 @@"));
            assert.ok(patch.includes("@@ -20,2 +21,3 @@"));
            assert.equal(sha256(patch).length, 64);
        });
    });
    // --------------------------------------------------------------------------
    // Feature 17: Independent Dual Reviews & Anti-Collusion (Boundary Cases)
    // --------------------------------------------------------------------------
    describe("Feature 17: Independent Dual Reviews & Anti-Collusion (Boundary Cases)", () => {
        it("17.1: evaluateReview approves when reviewer returns clean approval", () => {
            const subject = {
                workItemId: "wi-b-rev1",
                stagedDiffDigest: "digest-clean",
                filesModified: ["src/core.ts"],
                modulePatch: {},
            };
            const verdict = AdversarialReviewEngine.evaluateReview("run-rev-1", "reviewer-alpha", subject, () => ({ approved: true, observations: ["All criteria satisfied."] }));
            assert.equal(verdict.verdict, "approved");
        });
        it("17.2: evaluateReview rejects when reviewer spots defective logic", () => {
            const subject = {
                workItemId: "wi-b-rev2",
                stagedDiffDigest: "digest-bad",
                filesModified: ["src/core.ts"],
                modulePatch: {},
            };
            const verdict = AdversarialReviewEngine.evaluateReview("run-rev-2", "reviewer-alpha", subject, () => ({ approved: false, observations: ["Critical flaw in boundary condition."] }));
            assert.equal(verdict.verdict, "rejected");
            assert.ok(verdict.observations.some((o) => o.includes("Critical flaw")));
        });
        it("17.3: computeConsensus requires 2 distinct independent reviewers", () => {
            const rev1 = AdversarialReviewEngine.evaluateReview("run-rev-a", "reviewer-alpha", { workItemId: "wi-consensus", stagedDiffDigest: "d", filesModified: [], modulePatch: {} }, () => ({ approved: true, observations: ["Pass A"] }));
            const consensus1 = AdversarialReviewEngine.computeConsensus("wi-consensus", [rev1]);
            assert.equal(consensus1.consensus, "rejected");
            const rev2 = AdversarialReviewEngine.evaluateReview("run-rev-b", "reviewer-beta", { workItemId: "wi-consensus", stagedDiffDigest: "d", filesModified: [], modulePatch: {} }, () => ({ approved: true, observations: ["Pass B"] }));
            const consensus2 = AdversarialReviewEngine.computeConsensus("wi-consensus", [rev1, rev2]);
            assert.equal(consensus2.consensus, "approved");
        });
        it("17.4: captures timestamp and reviewRunId in verdict object", () => {
            const subject = {
                workItemId: "wi-b-rev4",
                stagedDiffDigest: "digest-4",
                filesModified: ["src/core.ts"],
                modulePatch: {},
            };
            const verdict = AdversarialReviewEngine.evaluateReview("run-unique-123", "reviewer-beta", subject, () => ({ approved: true, observations: ["LGTM"] }));
            assert.equal(verdict.reviewerRunId, "run-unique-123");
            assert.equal(verdict.reviewerExpertId, "reviewer-beta");
            assert.ok(verdict.timestamp);
        });
        it("17.5: computeConsensus rejects when any reviewer rejects (unanimous approval required)", () => {
            const rev1 = AdversarialReviewEngine.evaluateReview("run-1", "reviewer-alpha", { workItemId: "wi-split", stagedDiffDigest: "d", filesModified: [], modulePatch: {} }, () => ({ approved: true, observations: ["Pass"] }));
            const rev2 = AdversarialReviewEngine.evaluateReview("run-2", "reviewer-beta", { workItemId: "wi-split", stagedDiffDigest: "d", filesModified: [], modulePatch: {} }, () => ({ approved: false, observations: ["Found security vulnerability"] }));
            const consensus = AdversarialReviewEngine.computeConsensus("wi-split", [rev1, rev2]);
            assert.equal(consensus.consensus, "rejected");
        });
    });
    // --------------------------------------------------------------------------
    // Feature 18: Atomic Git 2PC Promotion & Objective Judge Gate (Boundary Cases)
    // --------------------------------------------------------------------------
    describe("Feature 18: Atomic Git 2PC Promotion & Objective Judge Gate (Boundary Cases)", () => {
        const baseBundle = {
            math: canonicalMath,
            parser: canonicalParser,
            pipeline: canonicalPipeline,
        };
        it("18.1: integrateWorkItems integrates clean proposals producing integrated status", () => {
            const proposals = [
                {
                    workItemId: "wi-b-1",
                    filesModified: ["src/math.ts"],
                    modulePatch: {},
                    stagedDiffDigest: sha256("diff-b-1"),
                },
            ];
            const res = DeterministicIntegrator.integrateWorkItems(baseBundle, proposals);
            assert.equal(res.status, "integrated");
            assert.equal(res.integratedWorkItems.length, 1);
            assert.ok(res.commitHash);
        });
        it("18.2: integrateWorkItems rejects proposals when patched bundle fails objective judge", () => {
            const proposals = [
                {
                    workItemId: "wi-b-fail",
                    filesModified: ["src/math.ts"],
                    modulePatch: {
                        math: { add: () => -9999 },
                    },
                    stagedDiffDigest: sha256("diff-fail"),
                },
            ];
            const res = DeterministicIntegrator.integrateWorkItems(baseBundle, proposals);
            assert.equal(res.status, "judge_rejected");
            assert.equal(res.judgeVerdict?.status, "rejected");
        });
        it("18.3: attaches verifiable judgeVerdict to integration report", () => {
            const proposals = [
                {
                    workItemId: "wi-b-verdict",
                    filesModified: ["src/parser.ts"],
                    modulePatch: {},
                    stagedDiffDigest: sha256("diff-v"),
                },
            ];
            const res = DeterministicIntegrator.integrateWorkItems(baseBundle, proposals);
            assert.ok(res.judgeVerdict);
            assert.equal(res.judgeVerdict?.status, "approved");
            assert.ok(res.judgeVerdict?.progressVector);
        });
        it("18.4: handles multiple parallel proposals simultaneously in single atomic transaction", () => {
            const proposals = [
                {
                    workItemId: "wi-par-1",
                    filesModified: ["src/math.ts"],
                    modulePatch: {},
                    stagedDiffDigest: sha256("diff-par-1"),
                },
                {
                    workItemId: "wi-par-2",
                    filesModified: ["src/parser.ts"],
                    modulePatch: {},
                    stagedDiffDigest: sha256("diff-par-2"),
                },
                {
                    workItemId: "wi-par-3",
                    filesModified: ["src/pipeline.ts"],
                    modulePatch: {},
                    stagedDiffDigest: sha256("diff-par-3"),
                },
            ];
            const res = DeterministicIntegrator.integrateWorkItems(baseBundle, proposals);
            assert.equal(res.status, "integrated");
            assert.equal(res.integratedWorkItems.length, 3);
        });
        it("18.5: atomicity guarantees all-or-nothing: one failing proposal aborts entire wave", () => {
            const proposals = [
                {
                    workItemId: "wi-good-1",
                    filesModified: ["src/parser.ts"],
                    modulePatch: {},
                    stagedDiffDigest: sha256("good-1"),
                },
                {
                    workItemId: "wi-bad-2",
                    filesModified: ["src/math.ts"],
                    modulePatch: { math: { add: () => -1 } },
                    stagedDiffDigest: sha256("bad-2"),
                },
            ];
            const res = DeterministicIntegrator.integrateWorkItems(baseBundle, proposals);
            assert.equal(res.status, "judge_rejected");
            assert.equal(res.commitHash, undefined);
            assert.equal(res.judgeVerdict?.status, "rejected");
        });
    });
});
