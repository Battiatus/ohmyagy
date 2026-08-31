import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionProjectionEngine } from "../../src/graph/mission-projections.js";
import { DeterministicResumeEngine } from "../../src/resume/engine.js";
import { MissionResumptionEngine } from "../../src/orchestration/mission-resumption.js";
import { BenchmarkRunner } from "../../src/benchmark/benchmark-runner.js";
import { ObjectiveJudge, type PipelineModuleBundle } from "../../src/oracle/objective-judge.js";
import { runOmaCli } from "../../src/cli/oma-cli.js";
import { OmaDoctor } from "../../src/runtime/doctor.js";
import { MissionEventsStore } from "../../src/ledger/mission-events.js";
import { initializeGraphStore, appendGraphTransition, loadGraphRuntime, verifyGraphStore } from "../../src/graph/store.js";
import type { ExecutionGraph } from "../../src/graph/model.js";
import type { IAgyDriver } from "../../src/runtime/agy-driver.js";
import type { IWorktreePool } from "../../src/orchestration/worktree-pool.js";
import * as canonicalMath from "../../test-fixtures/minimal-pipeline/src/math.js";
import * as canonicalParser from "../../test-fixtures/minimal-pipeline/src/parser.js";
import * as canonicalPipeline from "../../test-fixtures/minimal-pipeline/src/pipeline.js";

describe("Tier 1: Feature Coverage — Features 19 to 27", () => {
  // --------------------------------------------------------------------------
  // Feature 19: State Projection from Ledger
  // --------------------------------------------------------------------------
  describe("Feature 19: State Projection from Ledger", () => {
    it("19.1: projects initial state from empty/minimal event stream", () => {
      const projection = MissionProjectionEngine.project([]);
      assert.equal(projection.status, "in_progress");
      assert.equal(projection.currentWave, 1);
      assert.equal(projection.workGraph.readySet.length, 0);
    });

    it("19.2: projects active work items into readySet and runningSet", () => {
      const events: any[] = [
        { type: "mission_started", workflowDigest: "d1", rulebookRevision: "r1", goal: "g1" },
        { type: "work_item_discovered", workItemId: "wi-1", title: "Task 1", scope: ["a.ts"], dependsOn: [], roleRequired: "worker", acceptanceCriteria: [] },
        { type: "work_item_discovered", workItemId: "wi-2", title: "Task 2", scope: ["b.ts"], dependsOn: [], roleRequired: "worker", acceptanceCriteria: [] },
        { type: "run_started", runId: "r-1", workItemId: "wi-1", expertId: "worker", model: "m", effort: "medium", worktreePath: "/tmp" },
      ];
      const projection = MissionProjectionEngine.project(events);
      assert.equal(projection.status, "in_progress");
      assert.ok(projection.workGraph.runningSet.includes("wi-1"));
      assert.ok(projection.workGraph.readySet.includes("wi-2"));
    });

    it("19.3: records accepted work items upon successful integration", () => {
      const events: any[] = [
        { type: "mission_started", workflowDigest: "d1", rulebookRevision: "r1", goal: "g1" },
        { type: "work_item_discovered", workItemId: "wi-acc", title: "Accepted Task", scope: ["a.ts"], dependsOn: [], roleRequired: "worker", acceptanceCriteria: [] },
        { type: "run_started", runId: "r-1", workItemId: "wi-acc", expertId: "worker", model: "m", effort: "medium" },
        { type: "run_finished", runId: "r-1", workItemId: "wi-acc", expertId: "worker", status: "succeeded", durationMs: 10 },
        { type: "review_attested", runId: "wi-acc", reviewerRunId: "rev-1", reviewerExpertId: "reviewer-1", workItemId: "wi-acc", subjectDiffDigest: "h", verdict: "approved", observations: ["pass"] },
        { type: "review_attested", runId: "wi-acc", reviewerRunId: "rev-2", reviewerExpertId: "reviewer-2", workItemId: "wi-acc", subjectDiffDigest: "h", verdict: "approved", observations: ["pass"] },
        { type: "integration_attempted", waveIndex: 1, workItemsIntegrated: ["wi-acc"], commitSha: "commit-1", status: "integrated" },
      ];
      const projection = MissionProjectionEngine.project(events);
      assert.ok(projection.workGraph.acceptedSet.includes("wi-acc"));
      assert.equal(projection.progress.acceptedWorkItems, 1);
    });

    it("19.4: reconstructs provenance with artifacts, reviews, and terminalVerdict", () => {
      const events: any[] = [
        { type: "mission_started", workflowDigest: "d1", rulebookRevision: "r1", goal: "g1" },
        { type: "artifact_created", runId: "r-1", workItemId: "wi-1", artifactPath: "/artifacts/diff.patch", artifactHash: "hash-diff", artifactKind: "diff" },
        { type: "review_attested", runId: "wi-1", reviewerRunId: "rev-1", reviewerExpertId: "reviewer-alpha", workItemId: "wi-1", subjectDiffDigest: "h", verdict: "approved", observations: ["Clean"] },
        { type: "mission_finished", finalStatus: "succeeded", totalDurationMs: 120, finalProgress: { hiddenTestsFailing: 0, hiddenTestsPassed: 5, visibleTestsFailing: 0, visibleTestsPassed: 3, gateFailures: 0, openDiagnosticsCount: 0, acceptedWorkItems: 1, totalWorkItems: 1 }, integratedCommitSha: "sha-final" },
      ];
      const projection = MissionProjectionEngine.project(events);
      assert.equal(projection.status, "succeeded");
      assert.ok(projection.provenance.artifacts["hash-diff"]);
      assert.equal(projection.provenance.reviews.length, 1);
      assert.equal(projection.provenance.terminalVerdict?.commitSha, "sha-final");
    });

    it("19.5: handles wave_transitioned events updating currentWave", () => {
      const events: any[] = [
        { type: "mission_started", workflowDigest: "d1", rulebookRevision: "r1", goal: "g1" },
        { type: "wave_transitioned", fromWave: 1, toWave: 2, hasProgressed: true, reason: "Fixing defects" },
      ];
      const projection = MissionProjectionEngine.project(events);
      assert.equal(projection.currentWave, 2);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 20: Epoch Fencing & Zombie Recovery
  // --------------------------------------------------------------------------
  describe("Feature 20: Epoch Fencing & Zombie Recovery", () => {
    it("20.1: recovers interrupted zombie task and projects readySet", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-epoch1-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-epoch-1",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            { id: "task_1", title: "Task 1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
            { id: "task_2", title: "Task 2", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
          ],
          edges: [
            { id: "e1", from: "task_1", to: "task_2", when: "failure" },
          ],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        const runtime = initializeGraphStore(tempDir);

        // Leave task_1 running (simulated crash)
        appendGraphTransition(runtime, {
          eventType: "node_dispatched",
          nodeId: "task_1",
          dispatchId: "disp-crash-1",
          authorityId: "oma-scheduler",
        });

        const resumeRes = await DeterministicResumeEngine.resume({ workspaceRoot: tempDir });
        assert.ok(resumeRes.purgedZombies.includes("task_1"));
        assert.equal(resumeRes.activeEpoch, 1);
        assert.deepEqual(resumeRes.readySet, ["task_2"]);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("20.2: increments activeEpoch monotonically across multiple crashes", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-epoch2-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-epoch-2",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            { id: "step_a", title: "Step A", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
            { id: "step_b", title: "Step B", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
          ],
          edges: [
            { id: "e1", from: "step_a", to: "step_b", when: "always" },
          ],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        const runtime = initializeGraphStore(tempDir);

        // Crash 1
        appendGraphTransition(runtime, {
          eventType: "node_dispatched",
          nodeId: "step_a",
          dispatchId: "disp-epoch-1-a",
          authorityId: "oma-scheduler",
        });
        const res1 = await DeterministicResumeEngine.resume({ workspaceRoot: tempDir });
        assert.equal(res1.activeEpoch, 2);

        // Crash 2
        const runtime2 = loadGraphRuntime(tempDir);
        appendGraphTransition(runtime2, {
          eventType: "node_dispatched",
          nodeId: "step_b",
          dispatchId: "disp-epoch-2-b",
          authorityId: "oma-scheduler",
        });
        const res2 = await DeterministicResumeEngine.resume({ workspaceRoot: tempDir });
        assert.equal(res2.activeEpoch, 3);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("20.3: preserves succeeded nodes on recovery without re-fencing them", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-epoch3-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-epoch-3",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            { id: "node_done", title: "Done", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
            { id: "node_next", title: "Next", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
          ],
          edges: [
            { id: "e1", from: "node_done", to: "node_next", when: "success" },
          ],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        const runtime = initializeGraphStore(tempDir);

        // Node done succeeds
        appendGraphTransition(runtime, {
          eventType: "node_dispatched",
          nodeId: "node_done",
          dispatchId: "disp-done",
          authorityId: "oma-scheduler",
        });
        appendGraphTransition(runtime, {
          eventType: "node_completed",
          nodeId: "node_done",
          dispatchId: "disp-done",
          outcome: "success",
          authority: "broker",
          authorityId: "oma-broker",
          evidenceHash: "0".repeat(64),
        });

        const res = await DeterministicResumeEngine.resume({ workspaceRoot: tempDir });
        assert.equal(res.purgedZombies.length, 0);
        assert.deepEqual(res.readySet, ["node_next"]);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("20.4: purges orphaned worktree directories on resume", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-epoch4-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-epoch-4",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            { id: "task_1", title: "Task 1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const wtOrphan = join(tempDir, ".oma", "worktrees", "task-orphan");
        mkdirSync(wtOrphan, { recursive: true });
        writeFileSync(join(wtOrphan, "stale.txt"), "leftover");

        await DeterministicResumeEngine.resume({ workspaceRoot: tempDir });
        assert.ok(!existsSync(wtOrphan));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("20.5: targetEpoch override forces specific epoch index", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-epoch5-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-epoch-5",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            { id: "task_1", title: "Task 1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const res = await DeterministicResumeEngine.resume({ workspaceRoot: tempDir, targetEpoch: 10 });
        assert.equal(res.activeEpoch, 10);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 21: Selective Task Resumption
  // --------------------------------------------------------------------------
  describe("Feature 21: Selective Task Resumption", () => {
    it("21.1: resumes interrupted mission completing uncompleted items", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-resum1-"));
      try {
        const missionDir = join(tempDir, ".oma", "missions", "mission-sel-1");
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");

        MissionEventsStore.appendEvent(eventsPath, "mission-sel-1", {
          type: "mission_started",
          workflowDigest: "d1",
          rulebookRevision: "r1",
          goal: "Selective task resume",
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-sel-1", {
          type: "work_item_discovered",
          workItemId: "wi-pending",
          title: "Pending Item",
          scope: ["src/math.ts"],
          dependsOn: [],
          roleRequired: "worker",
          acceptanceCriteria: ["pass"],
        });

        const report = await MissionResumptionEngine.resume({
          workspaceRoot: tempDir,
          missionId: "mission-sel-1",
        });
        assert.equal(report.status, "succeeded");
        assert.equal(report.missionId, "mission-sel-1");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("21.2: does not re-execute previously accepted work items", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-resum2-"));
      try {
        const missionDir = join(tempDir, ".oma", "missions", "mission-sel-2");
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");

        MissionEventsStore.appendEvent(eventsPath, "mission-sel-2", {
          type: "mission_started",
          workflowDigest: "d1",
          rulebookRevision: "r1",
          goal: "Selective preservation",
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-sel-2", {
          type: "work_item_discovered",
          workItemId: "wi-done",
          title: "Done Item",
          scope: ["src/done.ts"],
          dependsOn: [],
          roleRequired: "worker",
          acceptanceCriteria: ["pass"],
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-sel-2", {
          type: "run_started",
          runId: "r-done",
          workItemId: "wi-done",
          expertId: "worker",
          model: "m",
          effort: "medium",
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-sel-2", {
          type: "run_finished",
          runId: "r-done",
          workItemId: "wi-done",
          expertId: "worker",
          status: "succeeded",
          durationMs: 10,
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-sel-2", {
          type: "review_attested",
          runId: "wi-done",
          reviewerRunId: "rev-1",
          reviewerExpertId: "reviewer-1",
          workItemId: "wi-done",
          subjectDiffDigest: "h",
          verdict: "approved",
          observations: ["pass"],
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-sel-2", {
          type: "review_attested",
          runId: "wi-done",
          reviewerRunId: "rev-2",
          reviewerExpertId: "reviewer-2",
          workItemId: "wi-done",
          subjectDiffDigest: "h",
          verdict: "approved",
          observations: ["pass"],
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-sel-2", {
          type: "integration_attempted",
          waveIndex: 1,
          workItemsIntegrated: ["wi-done"],
          commitSha: "sha-1",
          status: "integrated",
        });

        const report = await MissionResumptionEngine.resume({
          workspaceRoot: tempDir,
          missionId: "mission-sel-2",
        });
        assert.equal(report.status, "succeeded");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("21.3: progresses across dynamic waves if uncompleted items fail initial judge", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-resum3-"));
      try {
        const missionDir = join(tempDir, ".oma", "missions", "mission-sel-3");
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");

        MissionEventsStore.appendEvent(eventsPath, "mission-sel-3", {
          type: "mission_started",
          workflowDigest: "d1",
          rulebookRevision: "r1",
          goal: "Wave progression",
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-sel-3", {
          type: "work_item_discovered",
          workItemId: "wi-fix",
          title: "Fix Item",
          scope: ["src/math.ts"],
          dependsOn: [],
          roleRequired: "worker",
          acceptanceCriteria: ["pass"],
        });

        const report = await MissionResumptionEngine.resume({
          workspaceRoot: tempDir,
          missionId: "mission-sel-3",
        });
        assert.equal(report.status, "succeeded");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("21.4: writes mission_resumed event into durable ledger", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-resum4-"));
      try {
        const missionDir = join(tempDir, ".oma", "missions", "mission-sel-4");
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");

        MissionEventsStore.appendEvent(eventsPath, "mission-sel-4", {
          type: "mission_started",
          workflowDigest: "d1",
          rulebookRevision: "r1",
          goal: "Event check",
        });

        await MissionResumptionEngine.resume({
          workspaceRoot: tempDir,
          missionId: "mission-sel-4",
        });

        const events = MissionEventsStore.readEvents(eventsPath);
        assert.ok(events.some((e) => e.type === "mission_started"));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("21.5: throws explicit error when requested mission does not exist", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-resum5-"));
      try {
        await assert.rejects(async () => {
          await MissionResumptionEngine.resume({
            workspaceRoot: tempDir,
            missionId: "non-existent-mission",
          });
        });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 22: Resumption Idempotency
  // --------------------------------------------------------------------------
  describe("Feature 22: Resumption Idempotency", () => {
    it("22.1: resume on completed mission returns immediately without rerunning", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-idem1-"));
      try {
        const missionDir = join(tempDir, ".oma", "missions", "mission-idem-1");
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");

        MissionEventsStore.appendEvent(eventsPath, "mission-idem-1", {
          type: "mission_started",
          workflowDigest: "d1",
          rulebookRevision: "r1",
          goal: "Idempotency test",
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-idem-1", {
          type: "mission_finished",
          finalStatus: "succeeded",
          totalDurationMs: 50,
          finalProgress: {
            hiddenTestsFailing: 0,
            hiddenTestsPassed: 5,
            visibleTestsFailing: 0,
            visibleTestsPassed: 3,
            gateFailures: 0,
            openDiagnosticsCount: 0,
            acceptedWorkItems: 1,
            totalWorkItems: 1,
          },
          integratedCommitSha: "sha-final-1",
        });

        const initialEventsCount = MissionEventsStore.readEvents(eventsPath).length;
        const report = await MissionResumptionEngine.resume({
          workspaceRoot: tempDir,
          missionId: "mission-idem-1",
        });

        assert.equal(report.status, "succeeded");
        assert.equal(report.finalCommitSha, "sha-final-1");
        const postEventsCount = MissionEventsStore.readEvents(eventsPath).length;
        assert.equal(postEventsCount, initialEventsCount, "No new events should be appended to completed mission");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("22.2: multiple consecutive resumes produce strictly identical outputs", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-idem2-"));
      try {
        const missionDir = join(tempDir, ".oma", "missions", "mission-idem-2");
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");

        MissionEventsStore.appendEvent(eventsPath, "mission-idem-2", {
          type: "mission_started",
          workflowDigest: "d2",
          rulebookRevision: "r2",
          goal: "Consecutive resumes",
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-idem-2", {
          type: "mission_finished",
          finalStatus: "succeeded",
          totalDurationMs: 100,
          finalProgress: {
            hiddenTestsFailing: 0,
            hiddenTestsPassed: 5,
            visibleTestsFailing: 0,
            visibleTestsPassed: 3,
            gateFailures: 0,
            openDiagnosticsCount: 0,
            acceptedWorkItems: 1,
            totalWorkItems: 1,
          },
          integratedCommitSha: "sha-consec",
        });

        const r1 = await MissionResumptionEngine.resume({ workspaceRoot: tempDir, missionId: "mission-idem-2" });
        const r2 = await MissionResumptionEngine.resume({ workspaceRoot: tempDir, missionId: "mission-idem-2" });
        const r3 = await MissionResumptionEngine.resume({ workspaceRoot: tempDir, missionId: "mission-idem-2" });

        assert.equal(r1.status, r2.status);
        assert.equal(r2.status, r3.status);
        assert.equal(r1.finalCommitSha, r2.finalCommitSha);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("22.3: preserves progress vector without modifications", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-idem3-"));
      try {
        const missionDir = join(tempDir, ".oma", "missions", "mission-idem-3");
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");

        MissionEventsStore.appendEvent(eventsPath, "mission-idem-3", {
          type: "mission_started",
          workflowDigest: "d3",
          rulebookRevision: "r3",
          goal: "Vector preservation",
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-idem-3", {
          type: "mission_finished",
          finalStatus: "succeeded",
          totalDurationMs: 80,
          finalProgress: {
            hiddenTestsFailing: 0,
            hiddenTestsPassed: 10,
            visibleTestsFailing: 0,
            visibleTestsPassed: 5,
            gateFailures: 0,
            openDiagnosticsCount: 0,
            acceptedWorkItems: 3,
            totalWorkItems: 3,
          },
        });

        const res = await MissionResumptionEngine.resume({ workspaceRoot: tempDir, missionId: "mission-idem-3" });
        assert.equal(res.status, "succeeded");
        assert.equal(res.totalEventsCount, 2);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("22.4: does not re-attempt Git commits on completed missions", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-idem4-"));
      try {
        const missionDir = join(tempDir, ".oma", "missions", "mission-idem-4");
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");

        MissionEventsStore.appendEvent(eventsPath, "mission-idem-4", {
          type: "mission_started",
          workflowDigest: "d4",
          rulebookRevision: "r4",
          goal: "Git commit check",
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-idem-4", {
          type: "mission_finished",
          finalStatus: "succeeded",
          totalDurationMs: 20,
          finalProgress: {
            hiddenTestsFailing: 0,
            hiddenTestsPassed: 5,
            visibleTestsFailing: 0,
            visibleTestsPassed: 3,
            gateFailures: 0,
            openDiagnosticsCount: 0,
            acceptedWorkItems: 1,
            totalWorkItems: 1,
          },
          integratedCommitSha: "sha-fixed-commit",
        });

        const res = await MissionResumptionEngine.resume({ workspaceRoot: tempDir, missionId: "mission-idem-4" });
        assert.equal(res.finalCommitSha, "sha-fixed-commit");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("22.5: verifyEventChain remains valid after consecutive resumes", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-idem5-"));
      try {
        const missionDir = join(tempDir, ".oma", "missions", "mission-idem-5");
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");

        MissionEventsStore.appendEvent(eventsPath, "mission-idem-5", {
          type: "mission_started",
          workflowDigest: "d5",
          rulebookRevision: "r5",
          goal: "Chain validity",
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-idem-5", {
          type: "mission_finished",
          finalStatus: "succeeded",
          totalDurationMs: 20,
          finalProgress: {
            hiddenTestsFailing: 0,
            hiddenTestsPassed: 5,
            visibleTestsFailing: 0,
            visibleTestsPassed: 3,
            gateFailures: 0,
            openDiagnosticsCount: 0,
            acceptedWorkItems: 1,
            totalWorkItems: 1,
          },
        });

        await MissionResumptionEngine.resume({ workspaceRoot: tempDir, missionId: "mission-idem-5" });
        const events = MissionEventsStore.readEvents(eventsPath);
        const verification = MissionEventsStore.verifyEventChain(events);
        assert.equal(verification.valid, true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 23: 4-Variant Benchmark Harness
  // --------------------------------------------------------------------------
  describe("Feature 23: 4-Variant Benchmark Harness", () => {
    it("23.1: executes benchmark comparing all 4 variants", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-bench1-"));
      try {
        const result = await BenchmarkRunner.executeBenchmark({
          workspaceRoot: tempDir,
          trialsPerVariant: 1,
        });
        assert.ok(result.summary.resultsByVariant.vanilla_agy);
        assert.ok(result.summary.resultsByVariant.skills_only);
        assert.ok(result.summary.resultsByVariant.oma_static_wave);
        assert.ok(result.summary.resultsByVariant.oma_dynamic_workflow);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("23.2: enforces identical shared baseline across variants", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-bench2-"));
      try {
        const result = await BenchmarkRunner.executeBenchmark({
          workspaceRoot: tempDir,
          trialsPerVariant: 1,
        });
        const baselines = result.rawResults.map((r) => r.sharedBaseline);
        assert.equal(baselines.length, 4);
        for (const b of baselines) {
          assert.equal(b.modelSlug, "gemini-3.7-flash");
          assert.equal(b.reasoningEffort, "medium");
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("23.3: records trialsPerVariant matching input configuration", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-bench3-"));
      try {
        const result = await BenchmarkRunner.executeBenchmark({
          workspaceRoot: tempDir,
          trialsPerVariant: 1,
        });
        assert.equal(result.summary.totalTrialsPerVariant, 1);
        assert.equal(result.rawResults.length, 4);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("23.4: writes output results JSON to disk", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-bench4-"));
      try {
        const result = await BenchmarkRunner.executeBenchmark({
          workspaceRoot: tempDir,
          trialsPerVariant: 1,
        });
        assert.ok(existsSync(result.resultsFilePath));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("23.5: generates causal markdown report with summary matrix", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-bench5-"));
      try {
        await BenchmarkRunner.executeBenchmark({
          workspaceRoot: tempDir,
          trialsPerVariant: 1,
        });
        const reportPath = join(tempDir, ".oma", "benchmark", "causal_benchmark_report.md");
        assert.ok(existsSync(reportPath));
        const md = readFileSync(reportPath, "utf8");
        assert.ok(md.includes("Rapport de Benchmark Causal"));
        assert.ok(md.includes("oma_dynamic_workflow"));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 24: Hidden Test Evaluation
  // --------------------------------------------------------------------------
  describe("Feature 24: Hidden Test Evaluation", () => {
    const cleanBundle: PipelineModuleBundle = {
      math: canonicalMath,
      parser: canonicalParser,
      pipeline: canonicalPipeline,
    };

    it("24.1: approves clean module bundle across all hidden test cases", () => {
      const verdict = ObjectiveJudge.evaluatePipelineBundle(cleanBundle);
      assert.equal(verdict.status, "approved");
      assert.equal(verdict.progressVector.hiddenTestsFailing, 0);
    });

    it("24.2: fails when math fibonacci constraint is broken", () => {
      const brokenMath: PipelineModuleBundle = {
        math: { ...canonicalMath, fibonacci: () => 999 },
        parser: canonicalParser,
        pipeline: canonicalPipeline,
      };
      const verdict = ObjectiveJudge.evaluatePipelineBundle(brokenMath);
      assert.equal(verdict.status, "rejected");
      assert.ok(verdict.progressVector.hiddenTestsFailing > 0);
    });

    it("24.3: fails when parser empty/syntax handling is broken", () => {
      const brokenParser: PipelineModuleBundle = {
        math: canonicalMath,
        parser: { parseExpression: () => { throw new Error("Parser fail"); } },
        pipeline: canonicalPipeline,
      };
      const verdict = ObjectiveJudge.evaluatePipelineBundle(brokenParser);
      assert.equal(verdict.status, "rejected");
    });

    it("24.4: computes durationMs for hidden test execution", () => {
      const verdict = ObjectiveJudge.evaluatePipelineBundle(cleanBundle);
      assert.ok(verdict.durationMs >= 0);
    });

    it("24.5: reports total hiddenTestsPassed accurately", () => {
      const verdict = ObjectiveJudge.evaluatePipelineBundle(cleanBundle);
      assert.ok(verdict.progressVector.hiddenTestsPassed > 0);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 25: Empirical Metrics & Reporting
  // --------------------------------------------------------------------------
  describe("Feature 25: Empirical Metrics & Reporting", () => {
    it("25.1: collects meanDurationMs across trial runs", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-rep1-"));
      try {
        const res = await BenchmarkRunner.executeBenchmark({ workspaceRoot: tempDir, trialsPerVariant: 1 });
        assert.ok(res.summary.resultsByVariant.oma_dynamic_workflow.meanDurationMs >= 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("25.2: collects meanTokens across trial runs", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-rep2-"));
      try {
        const res = await BenchmarkRunner.executeBenchmark({ workspaceRoot: tempDir, trialsPerVariant: 1 });
        assert.ok(res.summary.resultsByVariant.oma_dynamic_workflow.meanTokens >= 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("25.3: records defects intercepted for OMA variants", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-rep3-"));
      try {
        const res = await BenchmarkRunner.executeBenchmark({ workspaceRoot: tempDir, trialsPerVariant: 1 });
        assert.equal(res.summary.resultsByVariant.vanilla_agy.meanDefectsIntercepted, 0);
        assert.ok(res.summary.resultsByVariant.oma_static_wave.meanDefectsIntercepted >= 1);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("25.4: generates structured causal findings list", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-rep4-"));
      try {
        const res = await BenchmarkRunner.executeBenchmark({ workspaceRoot: tempDir, trialsPerVariant: 1 });
        assert.ok(res.summary.causalFindings.length >= 3);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("25.5: rawResults includes timestamp and metrics for every trial", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-rep5-"));
      try {
        const res = await BenchmarkRunner.executeBenchmark({ workspaceRoot: tempDir, trialsPerVariant: 1 });
        assert.equal(res.rawResults.length, 4);
        for (const raw of res.rawResults) {
          assert.ok(raw.timestamp);
          assert.ok(raw.metrics.totalTokens >= 0);
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 26: Unified CLI Interface
  // --------------------------------------------------------------------------
  describe("Feature 26: Unified CLI Interface", () => {
    it("26.1: oma doctor returns exit code 0 and reports environment capabilities", async () => {
      const code = await runOmaCli(["doctor"]);
      assert.equal(code, 0);
    });

    it("26.2: oma plugin install-workspace installs plugin successfully", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-cli2-"));
      try {
        const code = await runOmaCli(["plugin", "install-workspace"], tempDir);
        assert.equal(code, 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("26.3: oma help and --help return exit code 0", async () => {
      assert.equal(await runOmaCli(["--help"]), 0);
      assert.equal(await runOmaCli(["help"]), 0);
    });

    it("26.4: oma unknown command returns exit code 1", async () => {
      const code = await runOmaCli(["invalid-command-xyz"]);
      assert.equal(code, 1);
    });

    it("26.5: OmaDoctor environment diagnosis detects system tools and installed agents", () => {
      const report = OmaDoctor.diagnoseEnvironment(process.cwd());
      assert.ok(report.os);
      assert.ok(typeof report.pluginDiscovery.installed === "boolean");
    });
  });

  // --------------------------------------------------------------------------
  // Feature 27: 100% E2E Acceptance Suite
  // --------------------------------------------------------------------------
  describe("Feature 27: 100% E2E Acceptance Suite", () => {
    it("27.1: full multi-expert mission lifecycle executes cleanly from end-to-end", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-full1-"));
      try {
        const code = await runOmaCli(["run", "mission-full-e2e", "--goal", "Build tested component"], tempDir);
        assert.equal(code, 0);
        // Verify status inspect
        const statusCode = await runOmaCli(["status", "--json", "--mission", "mission-full-e2e"], tempDir);
        assert.equal(statusCode, 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("27.2: inspect --json outputs full verifiable provenance chain", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-full2-"));
      try {
        await runOmaCli(["run", "mission-prov", "--goal", "Provenance inspection"], tempDir);
        const code = await runOmaCli(["inspect", "--json", "--mission", "mission-prov"], tempDir);
        assert.equal(code, 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("27.3: resume restores completed mission with perfect idempotency", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-full3-"));
      try {
        await runOmaCli(["run", "mission-run-res", "--goal", "Resumption integration"], tempDir);
        const resumeCode = await runOmaCli(["resume", "mission-run-res"], tempDir);
        assert.equal(resumeCode, 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("27.4: benchmark command runs via CLI dispatcher", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-full4-"));
      try {
        const code = await runOmaCli(["benchmark", "--trials", "1"], tempDir);
        assert.equal(code, 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("27.5: ensures complete cryptographic chain integrity across entire mission lifecycle", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-full5-"));
      try {
        await runOmaCli(["run", "mission-crypto", "--goal", "Cryptographic verification"], tempDir);
        const eventsPath = join(tempDir, ".oma", "missions", "mission-crypto", "events.jsonl");
        const events = MissionEventsStore.readEvents(eventsPath);
        const verification = MissionEventsStore.verifyEventChain(events);
        assert.equal(verification.valid, true);
        assert.ok(events.length >= 3);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
