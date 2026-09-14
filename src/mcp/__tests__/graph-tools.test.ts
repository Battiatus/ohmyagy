import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "bun:test";
import { handleRequest, type BrokerConfig } from "../broker-server.js";
import { MissionJournal } from "../../ledger/mission-journal.js";
import { loadGraphRuntime, verifyGraphStore } from "../../graph/store.js";
import { calculateProposalDigest, type GraphProposal } from "../../graph/proposal.js";
import { projectGraph } from "../../graph/kernel.js";
import type { GraphEdge, GraphNode } from "../../graph/model.js";
import { recordSuccessfulRun } from "../../mission/__tests__/support/attributed-run.js";

let root: string;
let config: BrokerConfig;
let journal: MissionJournal;
let stagedRecords: Map<string, never>;

function removeTree(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") {
        throw err;
      }
      Bun.sleepSync(20);
    }
  }
}

/** Drive a JSON-RPC call through the broker's request handler. */
function rpc(
  method: string,
  params?: Record<string, unknown>,
): Record<string, unknown> {
  const response = handleRequest(
    config,
    journal,
    stagedRecords as Map<string, never>,
    { jsonrpc: "2.0", id: 1, method, params },
  );
  return response.result as Record<string, unknown>;
}

/** Call a tool and return its structured result. */
function callTool(
  name: string,
  args: Record<string, unknown>,
): { structured: Record<string, unknown>; isError: boolean } {
  const result = rpc("tools/call", { name, arguments: args });
  return {
    structured: result.structuredContent as Record<string, unknown>,
    isError: Boolean(result.isError),
  };
}

function makeAgentNode(id: string, title = id): GraphNode {
  return {
    id,
    title,
    kind: "agent",
    activation: "all",
    completionAuthority: "broker",
    completionAuthorityId: "oma-broker",
    executor: { adapter: "antigravity", persona: "oma-executor" },
  };
}

function makeEdge(id: string, from: string, to: string, when: "success" | "failure" | "always" = "success"): GraphEdge {
  return { id, from, to, when };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oma-graph-tools-"));
  config = {
    workspaceRoot: root,
    gates: [],
  };
  journal = new MissionJournal("graph-tools-mission", "code-change", {
    journalStorePath: join(root, "events.jsonl"),
  });
  stagedRecords = new Map();
});

afterEach(() => {
  removeTree(root);
});

test("tools/list advertises the six graph tools with schemas", () => {
  const result = rpc("tools/list");
  const tools = result.tools as Array<{ name: string; inputSchema: unknown }>;
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("graph_init"));
  assert.ok(names.includes("graph_propose"));
  assert.ok(names.includes("graph_apply"));
  assert.ok(names.includes("graph_ready_nodes"));
  assert.ok(names.includes("graph_mark_node"));
  assert.ok(names.includes("graph_inspect"));

  const initTool = tools.find((t) => t.name === "graph_init");
  assert.ok(initTool);
  assert.equal(typeof initTool.inputSchema, "object");
});

test("graph_init initializes an execution graph and creates store files", () => {
  const { structured, isError } = callTool("graph_init", {
    missionId: "mission-alpha",
    goal: "Build session native orchestration",
  });
  assert.equal(isError, false);
  assert.equal(structured.status, "initialized");
  assert.equal(structured.missionId, "mission-alpha");
  assert.equal(structured.graphId, "graph-mission-alpha");
  assert.equal(structured.revision, 1);

  const defFile = join(root, ".oma", "graph", "execution-graph.json");
  const eventsFile = join(root, ".oma", "graph", "events.jsonl");
  const headFile = join(root, ".oma", "graph", "head.json");

  assert.ok(existsSync(defFile), "execution-graph.json should exist");
  assert.ok(existsSync(eventsFile), "events.jsonl should exist");
  assert.ok(existsSync(headFile), "head.json should exist");

  const runtime = loadGraphRuntime(root);
  const verification = verifyGraphStore(runtime);
  assert.equal(verification.valid, true);
});

test("graph_propose validates a valid GraphProposal and rejects a cycle with Kahn diagnostics", () => {
  const nodeA = makeAgentNode("node_A", "Task A");
  const nodeB = makeAgentNode("node_B", "Task B");
  const edgeAB = makeEdge("edge_A_B", "node_A", "node_B");

  const initRes = callTool("graph_init", {
    missionId: "mission-propose",
    nodes: [nodeA, nodeB],
    edges: [edgeAB],
  });
  assert.equal(initRes.isError, false);

  const nodeC = makeAgentNode("node_C", "Task C");
  const edgeBC = makeEdge("edge_B_C", "node_B", "node_C");

  const validProposal: GraphProposal = {
    schemaVersion: 2,
    proposalId: "prop_valid_expansion",
    author: "oma-planner",
    parentRevision: 1,
    delta: {
      nodesToAdd: [nodeC],
      edgesToAdd: [edgeBC],
    },
    rationale: {
      summary: "Add downstream verification node",
    },
  };

  const validRes = callTool("graph_propose", { proposal: validProposal });
  assert.equal(validRes.isError, false);
  assert.equal(validRes.structured.status, "proposed");
  assert.equal(validRes.structured.valid, true);
  assert.equal(validRes.structured.proposalId, "prop_valid_expansion");

  // Cyclic proposal: adds node_C with edge B->C and C->A creating cycle A -> B -> C -> A
  const edgeCA = makeEdge("edge_C_A", "node_C", "node_A");
  const cycleProposal: GraphProposal = {
    schemaVersion: 2,
    proposalId: "prop_cyclic_expansion",
    author: "oma-planner",
    parentRevision: 1,
    delta: {
      nodesToAdd: [nodeC],
      edgesToAdd: [edgeBC, edgeCA],
    },
    rationale: {
      summary: "Introducing cyclic dependency intentionally",
    },
  };

  const cycleRes = callTool("graph_propose", { proposal: cycleProposal });
  assert.equal(cycleRes.isError, true);
  assert.equal(cycleRes.structured.status, "rejected");
  assert.match(String(cycleRes.structured.reason), /cycle/iu);
  assert.ok(cycleRes.structured.cyclePath);
});

test("graph_apply then graph_ready_nodes lists ready root nodes", () => {
  const nodeA = makeAgentNode("node_A", "Task A");
  const nodeB = makeAgentNode("node_B", "Task B");
  const edgeAB = makeEdge("edge_A_B", "node_A", "node_B");

  const initRes = callTool("graph_init", {
    missionId: "mission-apply",
    nodes: [nodeA, nodeB],
    edges: [edgeAB],
  });
  assert.equal(initRes.isError, false);

  const nodeC = makeAgentNode("node_C", "Task C");
  const edgeBC = makeEdge("edge_B_C", "node_B", "node_C");

  const proposal: GraphProposal = {
    schemaVersion: 2,
    proposalId: "prop_apply_nodes",
    author: "oma-planner",
    parentRevision: 1,
    delta: {
      nodesToAdd: [nodeC],
      edgesToAdd: [edgeBC],
    },
    rationale: {
      summary: "Add downstream node C",
    },
  };

  const applyRes = callTool("graph_apply", { proposal });
  assert.equal(applyRes.isError, false);
  assert.equal(applyRes.structured.status, "applied");
  assert.equal(applyRes.structured.revision, 2);

  const readyRes = callTool("graph_ready_nodes", {});
  assert.equal(readyRes.isError, false);
  assert.equal(readyRes.structured.status, "ready_nodes");
  assert.deepEqual(readyRes.structured.readySet, ["node_A"]);
  assert.equal(readyRes.structured.count, 1);
});

test("complete cycle: graph_mark_node advances DAG and reveals new ready nodes", () => {
  const nodeA = makeAgentNode("step_1", "Initial Analysis");
  const nodeB = makeAgentNode("step_2", "Implementation");
  const edge = makeEdge("edge_1_2", "step_1", "step_2");

  const initRes = callTool("graph_init", {
    missionId: "mission-cycle",
    nodes: [nodeA, nodeB],
    edges: [edge],
  });
  assert.equal(initRes.isError, false);

  // Initial ready state
  const initialReady = callTool("graph_ready_nodes", {});
  assert.equal(initialReady.isError, false);
  assert.deepEqual(initialReady.structured.readySet, ["step_1"]);

  // Mark step_1 succeeded — a completion now has to be backed by a finished run.
  recordSuccessfulRun(root, "step_1", "oma-executor", "mission-cycle");
  const mark1 = callTool("graph_mark_node", {
    nodeId: "step_1",
    state: "succeeded",
  });
  assert.equal(mark1.isError, false);
  assert.equal(mark1.structured.status, "node_marked");
  assert.equal(mark1.structured.nodeId, "step_1");
  assert.equal(mark1.structured.state, "succeeded");
  assert.deepEqual(mark1.structured.readySet, ["step_2"]);

  // Ready nodes now contains step_2
  const readyAfter1 = callTool("graph_ready_nodes", {});
  assert.equal(readyAfter1.isError, false);
  assert.deepEqual(readyAfter1.structured.readySet, ["step_2"]);

  // Mark step_2 succeeded
  recordSuccessfulRun(root, "step_2", "oma-executor", "mission-cycle");
  const mark2 = callTool("graph_mark_node", {
    nodeId: "step_2",
    state: "succeeded",
  });
  assert.equal(mark2.isError, false);
  assert.deepEqual(mark2.structured.readySet, []);
});

test("recovery: re-loadGraphRuntime after transitions confirms no completed work is replayed", () => {
  const nodeA = makeAgentNode("task_A", "Task A");
  const nodeB = makeAgentNode("task_B", "Task B");
  const edge = makeEdge("edge_AB", "task_A", "task_B");

  const initRes = callTool("graph_init", {
    missionId: "mission-recovery",
    nodes: [nodeA, nodeB],
    edges: [edge],
  });
  assert.equal(initRes.isError, false);

  recordSuccessfulRun(root, "task_A", "oma-executor", "mission-recovery");
  const markRes = callTool("graph_mark_node", {
    nodeId: "task_A",
    state: "succeeded",
  });
  assert.equal(markRes.isError, false);

  // Re-read directly from disk without memory caching
  const reloadedRuntime = loadGraphRuntime(root);
  const verification = verifyGraphStore(reloadedRuntime);
  assert.equal(verification.valid, true);

  const projection = projectGraph(reloadedRuntime.graph, verification.events);
  const nodeAProjected = projection.nodes.find((n) => n.id === "task_A");
  const nodeBProjected = projection.nodes.find((n) => n.id === "task_B");

  assert.equal(nodeAProjected?.state, "succeeded");
  assert.equal(nodeBProjected?.state, "ready");
  assert.deepEqual(projection.readySet, ["task_B"]);
});

test("graph_inspect returns graph projection and progress metrics", () => {
  const nodeA = makeAgentNode("node_1", "Task 1");
  const nodeB = makeAgentNode("node_2", "Task 2");
  const edge = makeEdge("e1", "node_1", "node_2");

  const initRes = callTool("graph_init", {
    missionId: "mission-inspect",
    nodes: [nodeA, nodeB],
    edges: [edge],
  });
  assert.equal(initRes.isError, false);

  recordSuccessfulRun(root, "node_1", "oma-executor", "mission-inspect");
  const markRes = callTool("graph_mark_node", { nodeId: "node_1", state: "succeeded" });
  assert.equal(markRes.isError, false);

  const { structured, isError } = callTool("graph_inspect", {});
  assert.equal(isError, false);
  assert.equal(structured.status, "inspected");
  assert.equal(structured.valid, true);
  assert.equal(structured.graphStatus, "ready");

  const metrics = structured.metrics as Record<string, number>;
  assert.equal(metrics.totalNodes, 2);
  assert.equal(metrics.succeededNodes, 1);
  assert.equal(metrics.readyNodes, 1);
  assert.equal(metrics.progressPercentage, 50);
});

test("graph_mark_node rejects unknown node and direct blocked state", () => {
  const initRes = callTool("graph_init", { missionId: "mission-err" });
  assert.equal(initRes.isError, false);

  const unknownRes = callTool("graph_mark_node", {
    nodeId: "ghost_node",
    state: "succeeded",
  });
  assert.equal(unknownRes.isError, true);
  assert.equal(unknownRes.structured.status, "rejected");
  assert.match(String(unknownRes.structured.reason), /ghost_node/);

  const blockedRes = callTool("graph_mark_node", {
    nodeId: "bootstrap",
    state: "blocked",
  });
  assert.equal(blockedRes.isError, true);
  assert.equal(blockedRes.structured.status, "rejected");
  assert.match(String(blockedRes.structured.reason), /blocked/);
});
