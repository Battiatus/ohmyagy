import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { initializeGraphStore, appendGraphTransition } from "../../graph/store.js";
import { ParallelScheduler } from "../scheduler.js";
import { resumeMission } from "../resume.js";
import { MockAgyDriver } from "../../runtime/mock-driver.js";

test("ParallelScheduler executes fan-out fan-in graph concurrently and records state", async () => {
  const root = mkdtempSync(join(tmpdir(), "oma-sched-test-"));
  const graphDir = join(root, ".oma", "graph");
  mkdirSync(graphDir, { recursive: true });

  const graph = {
    schemaVersion: 2,
    graphId: "test-fan-graph",
    revision: 1,
    schedulerAuthorityId: "oma-scheduler",
    nodes: [
      {
        id: "task_a",
        title: "Task A",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
        scope: ["src/math.ts"],
        executor: {
          adapter: "antigravity-cli",
          persona: "oma-executor",
        },
      },
      {
        id: "task_b",
        title: "Task B",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
        scope: ["src/parser.ts"],
        executor: {
          adapter: "antigravity-cli",
          persona: "oma-executor",
        },
      },
      {
        id: "join_node",
        title: "Join",
        kind: "join",
        activation: "all",
        completionAuthority: "scheduler",
        completionAuthorityId: "oma-scheduler",
      },
    ],
    edges: [
      { id: "e1", from: "task_a", to: "join_node", when: "success" },
      { id: "e2", from: "task_b", to: "join_node", when: "success" },
    ],
  };

  writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2), "utf8");
  initializeGraphStore(root);

  try {
    const mockDriver = new MockAgyDriver();
    const scheduler = new ParallelScheduler({
      workspaceRoot: root,
      driver: mockDriver,
      maxConcurrency: 2,
    });

    const result = await scheduler.run();

    assert.equal(result.success, true);
    assert.equal(result.completedNodes.length, 3);
    assert.deepEqual(result.completedNodes.sort(), ["join_node", "task_a", "task_b"]);
    // Confirm worktrees are cleaned up
    assert.equal(existsSync(join(root, ".oma", "worktrees", "task-task_a")), false);
    assert.equal(existsSync(join(root, ".oma", "worktrees", "task-task_b")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ParallelScheduler enforces file scope exclusivity on overlapping scopes", async () => {
  const root = mkdtempSync(join(tmpdir(), "oma-scope-lock-test-"));
  const graphDir = join(root, ".oma", "graph");
  mkdirSync(graphDir, { recursive: true });

  // Two independent tasks both ready at start, but modifying the same file "src/shared.ts"
  const graph = {
    schemaVersion: 2,
    graphId: "test-scope-conflict-graph",
    revision: 1,
    schedulerAuthorityId: "oma-scheduler",
    nodes: [
      {
        id: "task_conflict_1",
        title: "Conflict Task 1",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
        scope: ["src/shared.ts"],
        executor: {
          adapter: "antigravity-cli",
          persona: "oma-executor",
        },
      },
      {
        id: "task_conflict_2",
        title: "Conflict Task 2",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
        scope: ["src/shared.ts"],
        executor: {
          adapter: "antigravity-cli",
          persona: "oma-executor",
        },
      },
    ],
    edges: [],
  };

  writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2), "utf8");
  initializeGraphStore(root);

  try {
    let runningCount = 0;
    let maxObservedConcurrentRunning = 0;

    // Custom mock driver tracking concurrency
    const concurrencyTrackingDriver = {
      async invoke() {
        runningCount++;
        maxObservedConcurrentRunning = Math.max(maxObservedConcurrentRunning, runningCount);
        await new Promise((resolve) => setTimeout(resolve, 50));
        runningCount--;
        return {
          status: "success" as const,
          exitCode: 0,
          rawStdout: "done",
          rawStderr: "",
          stdoutHash: "0".repeat(64),
          durationMs: 50,
        };
      },
    };

    const scheduler = new ParallelScheduler({
      workspaceRoot: root,
      driver: concurrencyTrackingDriver as any,
      maxConcurrency: 4, // Concurrency allowed up to 4, but scope locks should force serial execution
    });

    const result = await scheduler.run();

    assert.equal(result.success, true);
    assert.equal(result.completedNodes.length, 2);
    // Because they shared "src/shared.ts", they must NEVER have run concurrently!
    assert.equal(maxObservedConcurrentRunning, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resumeMission recovers interrupted running tasks without replaying succeeded nodes", () => {
  const root = mkdtempSync(join(tmpdir(), "oma-resume-test-"));
  const graphDir = join(root, ".oma", "graph");
  mkdirSync(graphDir, { recursive: true });

  const graph = {
    schemaVersion: 2,
    graphId: "test-resume-graph",
    revision: 1,
    schedulerAuthorityId: "oma-scheduler",
    nodes: [
      {
        id: "task_1",
        title: "Task 1",
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
        id: "task_2",
        title: "Task 2",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
        executor: {
          adapter: "antigravity-cli",
          persona: "oma-executor",
        },
      },
    ],
    edges: [
      { id: "e1", from: "task_1", to: "task_2", when: "failure" },
    ],
  };

  writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2), "utf8");
  const runtime = initializeGraphStore(root);

  try {
    // Simulate task_1 was dispatched but crashed before completing
    appendGraphTransition(runtime, {
      eventType: "node_dispatched",
      nodeId: "task_1",
      dispatchId: "disp-crashed",
      authorityId: "oma-scheduler",
    });

    // Run resume
    const report = resumeMission({ workspaceRoot: root });

    assert.equal(report.graphId, "test-resume-graph");
    assert.deepEqual(report.recoveredNodes, ["task_1"]);
    assert.deepEqual(report.currentReadySet, ["task_2"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
