import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeGraphStore, appendGraphTransition, loadGraphRuntime, verifyGraphStore } from "../../graph/store.js";
import { DeterministicResumeEngine } from "../engine.js";

test("DeterministicResumeEngine recovers interrupted zombie tasks and projects readySet", async () => {
  const root = mkdtempSync(join(tmpdir(), "oma-resume-engine-test-"));
  const graphDir = join(root, ".oma", "graph");
  mkdirSync(graphDir, { recursive: true });

  const graph = {
    schemaVersion: 2,
    graphId: "test-crash-graph",
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
    // 1. Simulate task_1 was dispatched but crashed mid-execution
    appendGraphTransition(runtime, {
      eventType: "node_dispatched",
      nodeId: "task_1",
      dispatchId: "disp-task_1-crashed",
      authorityId: "oma-scheduler",
    });

    // 2. Create an orphaned worktree directory
    const wtDir = join(root, ".oma", "worktrees", "task-task_1");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "stale.txt"), "leftover", "utf8");

    // 3. Resume execution
    const resumeResult = await DeterministicResumeEngine.resume({ workspaceRoot: root });

    assert.equal(resumeResult.restoredRevision, 1);
    assert.equal(resumeResult.activeEpoch, 1);
    assert.deepEqual(resumeResult.purgedZombies, ["task_1"]);
    assert.deepEqual(resumeResult.inFlightResumed, ["task_1"]);
    // Because task_1 completed with failure and edge e1 has when: "failure", task_2 is now ready!
    assert.deepEqual(resumeResult.readySet, ["task_2"]);

    // Orphan worktree should be purged
    assert.equal(existsSync(wtDir), false);

    // Verify graph store is valid
    const freshRuntime = loadGraphRuntime(root);
    const verification = verifyGraphStore(freshRuntime);
    assert.equal(verification.valid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DeterministicResumeEngine increments activeEpoch monotonically across multiple crashes", async () => {
  const root = mkdtempSync(join(tmpdir(), "oma-epoch-test-"));
  const graphDir = join(root, ".oma", "graph");
  mkdirSync(graphDir, { recursive: true });

  const graph = {
    schemaVersion: 2,
    graphId: "test-epoch-graph",
    revision: 1,
    schedulerAuthorityId: "oma-scheduler",
    nodes: [
      {
        id: "step_a",
        title: "Step A",
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
        id: "step_b",
        title: "Step B",
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
      { id: "e1", from: "step_a", to: "step_b", when: "always" },
    ],
  };

  writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2), "utf8");
  const runtime = initializeGraphStore(root);

  try {
    // Epoch 1 crash: step_a dispatched and crashed
    appendGraphTransition(runtime, {
      eventType: "node_dispatched",
      nodeId: "step_a",
      dispatchId: "disp-step_a-epoch-1",
      authorityId: "oma-scheduler",
    });

    const res1 = await DeterministicResumeEngine.resume({ workspaceRoot: root });
    assert.equal(res1.activeEpoch, 2);
    assert.deepEqual(res1.purgedZombies, ["step_a"]);

    // Epoch 2 crash: step_b dispatched and crashed
    const runtime2 = loadGraphRuntime(root);
    appendGraphTransition(runtime2, {
      eventType: "node_dispatched",
      nodeId: "step_b",
      dispatchId: "disp-step_b-epoch-2",
      authorityId: "oma-scheduler",
    });

    const res2 = await DeterministicResumeEngine.resume({ workspaceRoot: root });
    assert.equal(res2.activeEpoch, 3);
    assert.deepEqual(res2.purgedZombies, ["step_b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DeterministicResumeEngine preserves succeeded nodes on resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "oma-retain-test-"));
  const graphDir = join(root, ".oma", "graph");
  mkdirSync(graphDir, { recursive: true });

  const graph = {
    schemaVersion: 2,
    graphId: "test-retain-graph",
    revision: 1,
    schedulerAuthorityId: "oma-scheduler",
    nodes: [
      {
        id: "step_success",
        title: "Step Success",
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
        id: "step_next",
        title: "Step Next",
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
      { id: "e1", from: "step_success", to: "step_next", when: "success" },
    ],
  };

  writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2), "utf8");
  const runtime = initializeGraphStore(root);

  try {
    // step_success completed cleanly
    appendGraphTransition(runtime, {
      eventType: "node_dispatched",
      nodeId: "step_success",
      dispatchId: "disp-success",
      authorityId: "oma-scheduler",
    });
    appendGraphTransition(runtime, {
      eventType: "node_completed",
      nodeId: "step_success",
      dispatchId: "disp-success",
      outcome: "success",
      authority: "broker",
      authorityId: "oma-broker",
      evidenceHash: "0".repeat(64),
    });

    // Run resume when no nodes are in-flight
    const res = await DeterministicResumeEngine.resume({ workspaceRoot: root });
    assert.equal(res.restoredRevision, 1);
    assert.equal(res.purgedZombies.length, 0);
    assert.deepEqual(res.readySet, ["step_next"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
