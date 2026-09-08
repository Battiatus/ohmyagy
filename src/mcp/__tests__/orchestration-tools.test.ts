import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, test } from "bun:test";
import { handleRequest, type BrokerConfig } from "../broker-server.js";
import { MissionJournal } from "../../ledger/mission-journal.js";
import {
  ORCHESTRATION_TOOL_DEFINITIONS,
  ORCHESTRATION_TOOL_NAMES,
  executeConvergeStatus,
  executeConvergeStep,
  executeGraphReplan,
} from "../orchestration-tools.js";
import type { GraphNode } from "../../graph/model.js";

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
    executor: { adapter: "agy", persona: "executor" },
    scope: ["src/index.ts"],
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oma-orch-tools-test-"));
  config = {
    workspaceRoot: root,
    gates: [],
    missionId: "test-mission",
  };
  journal = new MissionJournal("test-mission", "code-change", {
    journalStorePath: join(root, ".oma", "ledger", "events.jsonl"),
  });
  stagedRecords = new Map();
});

afterEach(() => {
  removeTree(root);
});

describe("Orchestration MCP Tools (Phase 3: T3.4 - T3.7)", () => {
  it("T3.7: Advertises converge_step, converge_status, and graph_replan in tool definitions", () => {
    assert.equal(ORCHESTRATION_TOOL_DEFINITIONS.length, 3);
    const names = ORCHESTRATION_TOOL_DEFINITIONS.map((d) => d.name).sort();
    assert.deepEqual(names, ["converge_status", "converge_step", "graph_replan"]);
    assert.ok(ORCHESTRATION_TOOL_NAMES.has("converge_step"));
    assert.ok(ORCHESTRATION_TOOL_NAMES.has("converge_status"));
    assert.ok(ORCHESTRATION_TOOL_NAMES.has("graph_replan"));
  });

  it("T3.5: converge_status reports not_initialized before graph_init", () => {
    const status = executeConvergeStatus(root, {});
    assert.equal(status.status, "status");
    assert.equal(status.convergenceStatus, "not_initialized");
    assert.deepEqual(status.readyNodes, []);
  });

  it("T3.4 & T3.5: converge_step and converge_status report ready nodes after graph_init", () => {
    // Initialize graph with one node
    const node1 = makeAgentNode("task-core", "Core Feature Implementation");
    const initRes = callTool("graph_init", {
      missionId: "test-mission",
      nodes: [node1],
      edges: [],
    });
    assert.equal(initRes.isError, false);

    // 1. converge_status should show 1 ready node
    const statusRes = callTool("converge_status", {});
    assert.equal(statusRes.isError, false);
    assert.equal(statusRes.structured.status, "status");
    assert.equal(statusRes.structured.convergenceStatus, "in_progress");
    const readyNodes = statusRes.structured.readyNodes as Array<{ id: string }>;
    assert.equal(readyNodes.length, 1);
    assert.equal(readyNodes[0].id, "task-core");

    // 2. converge_step should evaluate in_progress
    const stepRes = callTool("converge_step", {});
    assert.equal(stepRes.isError, false);
    assert.equal(stepRes.structured.status, "in_progress");
    const stepReady = stepRes.structured.readyNodes as Array<{ id: string }>;
    assert.equal(stepReady.length, 1);
    assert.equal(stepReady[0].id, "task-core");
  });

  it("T3.4: converge_step detects 2-round stagnation and returns no_progress_blocked", () => {
    const node1 = makeAgentNode("task-core");
    callTool("graph_init", {
      missionId: "test-mission",
      nodes: [node1],
      edges: [],
    });

    const stagnantVector = {
      hiddenTestsFailing: 2,
      hiddenTestsPassed: 0,
      visibleTestsFailing: 1,
      visibleTestsPassed: 0,
      gateFailures: 1,
      openDiagnosticsCount: 2,
      acceptedWorkItems: 0,
      totalWorkItems: 1,
    };

    const stepRes = callTool("converge_step", {
      progressHistory: [stagnantVector, stagnantVector, stagnantVector],
      limits: { maxConsecutiveNoProgressRounds: 2 },
    });

    assert.equal(stepRes.isError, false);
    assert.equal(stepRes.structured.status, "no_progress_blocked");
    assert.ok(String(stepRes.structured.diagnosis).includes("Stagnation detected"));
  });

  it("T3.4: converge_step succeeds when isIntegrated is set to true", () => {
    const node1 = makeAgentNode("task-core");
    callTool("graph_init", {
      missionId: "test-mission",
      nodes: [node1],
      edges: [],
    });

    const stepRes = callTool("converge_step", {
      isIntegrated: true,
    });

    assert.equal(stepRes.isError, false);
    assert.equal(stepRes.structured.status, "succeeded");
  });

  it("T3.6: graph_replan inserts diagnostic node for explorer on verifier failure and marks it ready", () => {
    // 1. Initialize graph with single task
    const node1 = makeAgentNode("task-verify", "Run verification suite");
    callTool("graph_init", {
      missionId: "test-mission",
      nodes: [node1],
      edges: [],
    });

    // 2. Mark node1 as dispatched then failed (simulating verifier failure)
    const dispRes = callTool("graph_mark_node", {
      nodeId: "task-verify",
      state: "running",
      dispatchId: "disp-1",
    });
    assert.equal(dispRes.isError, false);

    const failRes = callTool("graph_mark_node", {
      nodeId: "task-verify",
      state: "failed",
      dispatchId: "disp-1",
    });
    assert.equal(failRes.isError, false);

    // 3. Trigger dynamic replanning for root-cause diagnosis via explorer
    const replanRes = callTool("graph_replan", {
      failedNodeId: "task-verify",
      failureReason: "Assertion failed: expected 42 but got 0",
      role: "explorer",
    });

    assert.equal(replanRes.isError, false);
    assert.equal(replanRes.structured.status, "replanned");
    assert.equal(replanRes.structured.role, "explorer");
    assert.ok(typeof replanRes.structured.newNodeId === "string");
    assert.ok((replanRes.structured.newNodeId as string).includes("task-verify-diag"));

    // The diagnostic node must immediately be in ready state because the failure edge is active!
    assert.equal(replanRes.structured.isReady, true);
    const readyNodes = replanRes.structured.readyNodes as string[];
    assert.ok(readyNodes.includes(replanRes.structured.newNodeId as string));

    // 4. Verify that converge_step now sees the diagnostic node as ready
    const stepRes = callTool("converge_step", {});
    assert.equal(stepRes.isError, false);
    assert.equal(stepRes.structured.status, "in_progress");
    const stepReady = stepRes.structured.readyNodes as Array<{ id: string }>;
    assert.ok(stepReady.some((n) => n.id === replanRes.structured.newNodeId));
  });

  it("T3.6: graph_replan inserts repair node for executor when requested", () => {
    const node1 = makeAgentNode("task-fix", "Apply bugfix patch");
    callTool("graph_init", {
      missionId: "test-mission",
      nodes: [node1],
      edges: [],
    });

    callTool("graph_mark_node", {
      nodeId: "task-fix",
      state: "running",
      dispatchId: "disp-fix-1",
    });
    callTool("graph_mark_node", {
      nodeId: "task-fix",
      state: "failed",
      dispatchId: "disp-fix-1",
    });

    const replanRes = callTool("graph_replan", {
      failedNodeId: "task-fix",
      role: "executor",
      failureReason: "Patch syntax error on line 12",
    });

    assert.equal(replanRes.isError, false);
    assert.equal(replanRes.structured.status, "replanned");
    assert.equal(replanRes.structured.role, "executor");
    assert.ok((replanRes.structured.newNodeId as string).includes("task-fix-repair"));
    assert.equal(replanRes.structured.isReady, true);
  });

  it("T3.6: graph_replan rejects unknown failedNodeId", () => {
    const node1 = makeAgentNode("task-1");
    callTool("graph_init", {
      missionId: "test-mission",
      nodes: [node1],
      edges: [],
    });

    assert.throws(() => {
      executeGraphReplan(root, {
        failedNodeId: "non-existent-node",
      });
    }, /Failed node 'non-existent-node' was not found/);
  });

  it("T3.4: converge_step returns status 'failed' with isError false on terminal node failure", () => {
    const node1 = makeAgentNode("task-verify");
    callTool("graph_init", {
      missionId: "test-mission",
      nodes: [node1],
      edges: [],
    });

    callTool("graph_mark_node", {
      nodeId: "task-verify",
      state: "running",
      dispatchId: "disp-1",
    });
    callTool("graph_mark_node", {
      nodeId: "task-verify",
      state: "failed",
      dispatchId: "disp-1",
    });

    const stepRes = callTool("converge_step", {});
    assert.equal(stepRes.isError, false);
    assert.equal(stepRes.structured.status, "failed");
    assert.equal(stepRes.structured.convergenceStatus, "failed");
    assert.ok(String(stepRes.structured.diagnosis).includes("Graph execution failed"));
  });

  it("T3.4: converge_step handles deserialized JSON currentProgress without premature stagnation", () => {
    const node1 = makeAgentNode("task-core");
    callTool("graph_init", {
      missionId: "test-mission",
      nodes: [node1],
      edges: [],
    });

    const v1 = {
      hiddenTestsFailing: 2,
      hiddenTestsPassed: 0,
      visibleTestsFailing: 1,
      visibleTestsPassed: 0,
      gateFailures: 1,
      openDiagnosticsCount: 2,
      acceptedWorkItems: 0,
      totalWorkItems: 1,
    };
    const v2 = { ...v1 }; // 1 round of stagnation

    // Both passed as distinct JSON object instances
    const stepRes = callTool("converge_step", {
      progressHistory: [v1, v2],
      currentProgress: { ...v2 },
      limits: { maxConsecutiveNoProgressRounds: 2 },
    });

    assert.equal(stepRes.isError, false);
    assert.equal(stepRes.structured.status, "in_progress");
    assert.equal(stepRes.structured.consecutiveNoProgressRounds, 1);
  });

  it("T5.4: converge_step ingests graph state into Brain, and brain_query returns memories linked to node_ref", () => {
    const node1 = makeAgentNode("task-node-auth", "Authentication Node");
    callTool("graph_init", {
      missionId: "test-mission",
      nodes: [node1],
      edges: [],
    });

    // Mark node as succeeded
    callTool("graph_mark_node", {
      nodeId: "task-node-auth",
      state: "succeeded",
      dispatchId: "disp-auth-1",
    });

    // Run converge_step which evaluates and ingests into brain
    const stepRes = callTool("converge_step", {
      isIntegrated: true,
    });
    assert.equal(stepRes.isError, false);

    // Query brain using brain_query for the specific node_ref
    const queryRes = callTool("brain_query", {
      query: "task-node-auth",
    });
    assert.equal(queryRes.isError, false);
    const entries = queryRes.structured.entries as Array<{
      title: string;
      content: string;
      tags: string[];
      dimension: string;
    }>;

    assert.ok(entries.length >= 1, "Expected memory entries linked to task-node-auth");
    assert.ok(entries.some((e) => e.tags.includes("task-node-auth") || e.tags.includes("node:task-node-auth")));
    assert.ok(entries.some((e) => e.title.includes("task-node-auth")));
  });
});
