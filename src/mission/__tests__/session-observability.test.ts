import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "bun:test";
import { handleRequest, type BrokerConfig } from "../../mcp/broker-server.js";
import { MissionJournal } from "../../ledger/mission-journal.js";
import { MissionEventsStore } from "../../ledger/mission-events.js";
import {
  eventsPathFor,
  findActiveMissionId,
  listMissions,
  loadMissionProjection,
  summarizeMission,
  missionsDir,
} from "../read-model.js";
import { executeGraphInit, executeGraphMarkNode } from "../../mcp/graph-tools.js";
import { executeConvergeStep, executeGraphReplan } from "../../mcp/orchestration-tools.js";
import { runOmaCli } from "../../cli/oma-cli.js";
import { recordInterview } from "../interview-gate.js";
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

function rpc(method: string, params?: Record<string, unknown>): Record<string, unknown> {
  const response = handleRequest(
    config,
    journal,
    stagedRecords,
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

function makeTestNode(id: string, title = id): GraphNode {
  return {
    id,
    title,
    kind: "agent",
    activation: "all",
    completionAuthority: "broker",
    completionAuthorityId: "oma-broker",
    executor: { adapter: "agy", persona: "executor" },
    scope: [`src/${id}.ts`],
  };
}

function makeTestEdge(
  id: string,
  from: string,
  to: string,
  when: "success" | "failure" | "always" = "success",
): GraphEdge {
  return { id, from, to, when };
}

describe("Unified Mission Observability (Phase 6: T6.1 - T6.3)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oma-session-obs-test-"));
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

  /**
   * A mission cannot be driven before the user answered and confirmed, so these tests
   * record the interview a real mission would have. The gate's own refusals are asserted
   * in src/mission/__tests__/interview-gate.test.ts.
   */
  function authorise(missionId: string): void {
    recordInterview({
      workspaceRoot: root,
      missionId,
      questions: ["What is the deliverable?"],
      answers: ["A verified report."],
      confirmed: true,
    });
  }

  it("T6.1 & T6.2: session lifecycle emits standard mission events and formats identically in listMissions and summarizeMission", () => {
    const missionId = "session-mission-alpha";
    authorise(missionId);
    const nodeA = makeTestNode("task-a", "Task Alpha");
    const nodeB = makeTestNode("task-b", "Task Beta");

    // 1. graph_init should emit mission_started and work_item_discovered for nodes
    const initRes = executeGraphInit(root, {
      missionId,
      nodes: [nodeA, nodeB],
      edges: [makeTestEdge("edge-a-b", "task-a", "task-b")],
      goal: "Implement Alpha and Beta features",
    });
    assert.equal(initRes.status, "initialized");

    const eventsPath = eventsPathFor(root, missionId);
    assert.ok(existsSync(eventsPath), "events.jsonl must exist for session mission");

    let events = MissionEventsStore.readEvents(eventsPath);
    const eventTypes = events.map((e) => e.type);
    assert.ok(eventTypes.includes("mission_started"), "mission_started must be emitted");
    assert.ok(eventTypes.includes("work_item_discovered"), "work_item_discovered must be emitted");

    // 2. listMissions and summarizeMission see in_progress session run
    const missions = listMissions(root);
    assert.equal(missions.length, 1);
    assert.equal(missions[0].missionId, missionId);
    assert.equal(missions[0].status, "in_progress");

    let projection = loadMissionProjection(root, missionId);
    let summary = summarizeMission(missionId, projection);
    assert.equal(summary.missionId, missionId);
    assert.equal(summary.missionStatus, "in_progress");
    assert.deepEqual(summary.ready, ["task-a"]);
    assert.deepEqual(summary.running, []);
    assert.equal(summary.currentWave, 1);

    // 3. Mark task-a as running -> run_started emitted
    executeGraphMarkNode(root, {
      missionId,
      nodeId: "task-a",
      state: "running",
      dispatchId: "dispatch-task-a",
    });

    events = MissionEventsStore.readEvents(eventsPath);
    assert.ok(events.some((e) => e.type === "run_started" && (e as any).workItemId === "task-a"));

    projection = loadMissionProjection(root, missionId);
    summary = summarizeMission(missionId, projection);
    assert.deepEqual(summary.running, ["task-a"]);

    // 4. Mark task-a as succeeded -> run_finished & integration_attempted emitted, unlocking task-b
    executeGraphMarkNode(root, {
      missionId,
      nodeId: "task-a",
      state: "succeeded",
      dispatchId: "dispatch-task-a",
      outcome: "success",
      durationMs: 120,
    });

    events = MissionEventsStore.readEvents(eventsPath);
    assert.ok(
      events.some(
        (e) =>
          e.type === "run_finished" &&
          (e as any).workItemId === "task-a" &&
          (e as any).status === "succeeded",
      ),
    );
    assert.ok(
      events.some(
        (e) =>
          e.type === "integration_attempted" &&
          (e as any).status === "integrated" &&
          (e as any).workItemsIntegrated?.includes("task-a"),
      ),
    );

    projection = loadMissionProjection(root, missionId);
    summary = summarizeMission(missionId, projection);
    assert.deepEqual(summary.accepted, ["task-a"]);
    assert.deepEqual(summary.running, []);
    assert.deepEqual(summary.ready, ["task-b"]);

    // 5. converge_step (intermediate) -> round_started and gate_evaluated emitted
    const stepRes = executeConvergeStep(root, {
      missionId,
      currentRound: 1,
      currentProgress: {
        hiddenTestsFailing: 0,
        hiddenTestsPassed: 2,
        visibleTestsFailing: 0,
        visibleTestsPassed: 2,
        gateFailures: 0,
        openDiagnosticsCount: 0,
        acceptedWorkItems: 1,
        totalWorkItems: 2,
      },
    });
    assert.equal(stepRes.status, "in_progress");

    events = MissionEventsStore.readEvents(eventsPath);
    assert.ok(events.some((e) => e.type === "round_started" && (e as any).roundIndex === 1));
    assert.ok(events.some((e) => e.type === "gate_evaluated" && (e as any).status === "passed"));

    // 6. Complete the last work item, THEN run the terminal converge_step.
    // Declaring success while `task-b` was still ready is precisely the false
    // success the contract now forbids: a terminal verdict must describe a
    // mission that is actually finished, not one that is still pending work.
    executeGraphMarkNode(root, { nodeId: "task-b", state: "succeeded" });

    // 7. Terminal converge_step -> terminal_verdict_rendered and mission_finished emitted
    const termRes = executeConvergeStep(root, {
      missionId,
      currentRound: 2,
      isIntegrated: true,
      currentProgress: {
        hiddenTestsFailing: 0,
        hiddenTestsPassed: 4,
        visibleTestsFailing: 0,
        visibleTestsPassed: 4,
        gateFailures: 0,
        openDiagnosticsCount: 0,
        acceptedWorkItems: 2,
        totalWorkItems: 2,
      },
    });
    assert.equal(termRes.status, "succeeded");

    events = MissionEventsStore.readEvents(eventsPath);
    assert.ok(events.some((e) => e.type === "terminal_verdict_rendered" && (e as any).status === "succeeded"));
    assert.ok(events.some((e) => e.type === "mission_finished" && (e as any).finalStatus === "succeeded"));

    // Verify projection & summary format terminal run
    projection = loadMissionProjection(root, missionId);
    summary = summarizeMission(missionId, projection);
    assert.equal(summary.missionStatus, "succeeded");
    assert.equal(summary.phase, "TERMINAL");
    assert.ok(summary.terminalVerdict);
    assert.equal(summary.terminalVerdict?.status, "succeeded");

    const updatedMissions = listMissions(root);
    assert.equal(updatedMissions.length, 1);
    assert.equal(updatedMissions[0].status, "succeeded");
  });

  it("T6.3: findActiveMissionId reliably discovers active session run and returns undefined when complete", () => {
    // Before graph init: no active mission
    assert.equal(findActiveMissionId(root), undefined);

    const missionId = "session-active-test-42";
    authorise(missionId);
    executeGraphInit(root, {
      missionId,
      nodes: [makeTestNode("node-1"), makeTestNode("node-2")],
      edges: [makeTestEdge("edge-1-2", "node-1", "node-2")],
    });

    // After graph init: finds the active session mission
    const discovered = findActiveMissionId(root);
    assert.equal(discovered, missionId);

    // During node running: still active
    executeGraphMarkNode(root, {
      missionId,
      nodeId: "node-1",
      state: "running",
      dispatchId: "dispatch-node-1",
    });
    assert.equal(findActiveMissionId(root), missionId);

    // Succeeded node 1 and intermediate converge step: still active because node-2 is pending
    executeGraphMarkNode(root, {
      missionId,
      nodeId: "node-1",
      state: "succeeded",
      dispatchId: "dispatch-node-1",
    });
    const step1 = executeConvergeStep(root, { missionId, currentRound: 1 });
    assert.equal(step1.status, "in_progress");
    assert.equal(findActiveMissionId(root), missionId);

    // Now execute node-2 to terminal completion
    executeGraphMarkNode(root, {
      missionId,
      nodeId: "node-2",
      state: "succeeded",
      dispatchId: "dispatch-node-2",
    });
    const step2 = executeConvergeStep(root, { missionId, currentRound: 2, isIntegrated: true });
    assert.equal(step2.status, "succeeded");
    assert.equal(findActiveMissionId(root), undefined);
  });

  it("T6.3: session discovery prioritizes active session and avoids returning deleted phantom missions", () => {
    const sessionMissionId = "session-priority-test";
    const graphDir = join(root, ".oma", "graph");
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, "session-mission-id"), sessionMissionId, "utf8");

    // 1. If .oma/missions doesn't exist or was deleted, findActiveMissionId safely returns undefined (no crash / no ghost)
    assert.equal(findActiveMissionId(root), undefined);

    // 2. Add an older detached mission that is in_progress in .oma/missions
    const olderMissionId = "older-detached-mission";
    const olderEventsPath = eventsPathFor(root, olderMissionId);
    MissionEventsStore.appendEvent(olderEventsPath, olderMissionId, {
      type: "mission_started",
      workflowDigest: "test-digest",
      rulebookRevision: "v1",
      goal: "Old mission",
      totalBudgets: { maxRounds: 5, maxTimeMs: 300_000 },
    });

    // Before session mission events are created, older mission is discovered
    assert.equal(findActiveMissionId(root), olderMissionId);

    // 3. Now initialize the workspace session mission
    executeGraphInit(root, {
      missionId: sessionMissionId,
      nodes: [makeTestNode("task-root")],
      edges: [],
    });

    // Active session mission takes priority over the older detached mission
    assert.equal(findActiveMissionId(root), sessionMissionId);

    // 4. If session mission directory is manually removed from disk, safely falls back without throwing
    removeTree(join(root, ".oma", "missions", sessionMissionId));
    assert.equal(findActiveMissionId(root), olderMissionId);
  });

  it("T6.1 & T6.2: MCP broker mission_status and list_missions seamlessly query session-native execution", () => {
    const missionId = "mcp-session-test";
    authorise(missionId);
    const initRes = callTool("graph_init", {
      missionId,
      nodes: [makeTestNode("mcp-task-1", "MCP Task 1")],
      edges: [],
    });
    assert.equal(initRes.isError, false);

    // 1. mission_status without missionId argument discovers active session
    const statusNoArgRes = callTool("mission_status", {});
    assert.equal(statusNoArgRes.isError, false);
    assert.equal(statusNoArgRes.structured.status, "reported");
    assert.equal(statusNoArgRes.structured.missionId, missionId);
    assert.equal(statusNoArgRes.structured.missionStatus, "in_progress");
    assert.deepEqual(statusNoArgRes.structured.ready, ["mcp-task-1"]);

    // 2. list_missions returns the active session
    const listRes = callTool("list_missions", {});
    assert.equal(listRes.isError, false);
    const missions = listRes.structured.missions as Array<{ missionId: string; status: string }>;
    assert.ok(missions.some((m) => m.missionId === missionId && m.status === "in_progress"));

    // 3. Mark node succeeded and converge to completion
    const markRes = callTool("graph_mark_node", {
      missionId,
      nodeId: "mcp-task-1",
      state: "succeeded",
    });
    assert.equal(markRes.isError, false);

    const convergeRes = callTool("converge_step", {
      missionId,
      isIntegrated: true,
      currentRound: 1,
    });
    assert.equal(convergeRes.isError, false);
    assert.equal(convergeRes.structured.status, "succeeded");

    // 4. mission_status with explicit missionId reports terminal verdict
    const termStatusRes = callTool("mission_status", { missionId });
    assert.equal(termStatusRes.isError, false);
    assert.equal(termStatusRes.structured.missionStatus, "succeeded");
    assert.equal(termStatusRes.structured.phase, "TERMINAL");
  });

  it("T6.2: stagnation (no_progress_blocked) emits terminal events and transitions status to blocked", () => {
    const missionId = "stagnation-session-test";
    authorise(missionId);
    executeGraphInit(root, {
      missionId,
      nodes: [makeTestNode("stagnant-node")],
      edges: [],
    });

    const stagnantProgress = {
      hiddenTestsFailing: 2,
      hiddenTestsPassed: 0,
      visibleTestsFailing: 1,
      visibleTestsPassed: 0,
      gateFailures: 1,
      openDiagnosticsCount: 0,
      acceptedWorkItems: 0,
      totalWorkItems: 1,
    };

    // Round 1 (baseline)
    const res1 = executeConvergeStep(root, {
      missionId,
      currentRound: 1,
      currentProgress: stagnantProgress,
    });
    assert.equal(res1.status, "in_progress");

    // Round 2 (1 round of stagnation)
    const res2 = executeConvergeStep(root, {
      missionId,
      currentRound: 2,
      currentProgress: stagnantProgress,
    });
    assert.equal(res2.status, "in_progress");

    // Round 3 (2 consecutive rounds of stagnation) -> triggers no_progress_blocked
    const res3 = executeConvergeStep(root, {
      missionId,
      currentRound: 3,
      currentProgress: stagnantProgress,
    });
    assert.equal(res3.status, "no_progress_blocked");

    const eventsPath = eventsPathFor(root, missionId);
    const events = MissionEventsStore.readEvents(eventsPath);
    assert.ok(events.some((e) => e.type === "terminal_verdict_rendered" && (e as any).status === "failed"));
    assert.ok(events.some((e) => e.type === "mission_finished" && (e as any).finalStatus === "no_progress_blocked"));

    const projection = loadMissionProjection(root, missionId);
    assert.equal(projection.status, "blocked");

    const summary = summarizeMission(missionId, projection);
    assert.equal(summary.missionStatus, "blocked");
    assert.equal(summary.phase, "TERMINAL");

    // findActiveMissionId returns undefined because the mission is terminal blocked
    assert.equal(findActiveMissionId(root), undefined);
  });

  it("T6.2: graph_replan emits work_item_discovered in the canonical mission journal", () => {
    const missionId = "replan-session-test";
    authorise(missionId);
    const failedNode = makeTestNode("failing-node", "Failing Node");
    executeGraphInit(root, {
      missionId,
      nodes: [failedNode],
      edges: [],
    });

    // Mark as running then failed
    executeGraphMarkNode(root, {
      missionId,
      nodeId: "failing-node",
      state: "running",
    });
    executeGraphMarkNode(root, {
      missionId,
      nodeId: "failing-node",
      state: "failed",
    });

    // Replan: dynamic insertion of diagnostic node
    const replanRes = executeGraphReplan(root, {
      missionId,
      failedNodeId: "failing-node",
      failureReason: "Assertion failed on unit test",
      role: "explorer",
    });
    assert.equal(replanRes.status, "replanned");

    const eventsPath = eventsPathFor(root, missionId);
    const events = MissionEventsStore.readEvents(eventsPath);
    const discovered = events.filter((e) => e.type === "work_item_discovered");
    assert.ok(discovered.some((e) => (e as any).workItemId === replanRes.newNodeId));

    const projection = loadMissionProjection(root, missionId);
    assert.ok(projection.workGraph.workItems[replanRes.newNodeId as string]);
  });

  it("T6.3: oma status and oma missions CLI without arguments inspects running session", async () => {
    const missionId = "cli-session-test";
    executeGraphInit(root, {
      missionId,
      nodes: [makeTestNode("cli-node-1")],
      edges: [],
    });

    // 1. oma status without --mission discovers active session
    const statusCode = await runOmaCli(["status"], root);
    assert.equal(statusCode, 0);

    // 2. oma status --json without --mission returns structured JSON
    const jsonStatusCode = await runOmaCli(["status", "--json"], root);
    assert.equal(jsonStatusCode, 0);

    // 3. oma watch --once without --mission discovers active session
    const watchCode = await runOmaCli(["watch", "--once"], root);
    assert.equal(watchCode, 0);
  });
});
