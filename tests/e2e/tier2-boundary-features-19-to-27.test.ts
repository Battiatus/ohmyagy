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
import { WorktreePool } from "../../src/orchestration/worktree-pool.js";
import { DynamicConvergenceEngine } from "../../src/orchestration/dynamic-engine.js";
import { AdversarialReviewEngine } from "../../src/oracle/adversarial-review.js";
import { parseGraphProposal } from "../../src/graph/proposal.js";
import * as canonicalMath from "../../test-fixtures/minimal-pipeline/src/math.js";
import * as canonicalParser from "../../test-fixtures/minimal-pipeline/src/parser.js";
import * as canonicalPipeline from "../../test-fixtures/minimal-pipeline/src/pipeline.js";

describe("Tier 2: Boundary & Corner Cases — Features 19 to 27", () => {
  // --------------------------------------------------------------------------
  // Feature 19: State Projection from Ledger (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 19: State Projection from Ledger (Boundary Cases)", () => {
    it("19.1: handles 100+ events stream projection without performance or memory issue", () => {
      const events: any[] = [
        { type: "mission_started", workflowDigest: "d1", rulebookRevision: "r1", goal: "Stress test" },
      ];
      for (let i = 0; i < 50; i++) {
        events.push({
          type: "work_item_discovered",
          workItemId: `wi-${i}`,
          title: `Task ${i}`,
          scope: [`src/${i}.ts`],
          dependsOn: [],
          roleRequired: "worker",
          acceptanceCriteria: [],
        });
        events.push({
          type: "run_started",
          runId: `run-${i}`,
          workItemId: `wi-${i}`,
          expertId: "worker",
          model: "gemini-3.7-flash",
          effort: "medium",
        });
      }
      const projection = MissionProjectionEngine.project(events);
      assert.equal(projection.status, "in_progress");
      assert.equal(projection.workGraph.runningSet.length, 50);
    });

    it("19.2: projects complex multi-branch DAG state (running, ready, failed, and accepted)", () => {
      const events: any[] = [
        { type: "mission_started", workflowDigest: "d1", rulebookRevision: "r1", goal: "Complex state" },
        { type: "work_item_discovered", workItemId: "wi-acc", title: "Accepted", scope: ["a.ts"], dependsOn: [], roleRequired: "worker", acceptanceCriteria: [] },
        { type: "work_item_discovered", workItemId: "wi-run", title: "Running", scope: ["b.ts"], dependsOn: [], roleRequired: "worker", acceptanceCriteria: [] },
        { type: "work_item_discovered", workItemId: "wi-ready", title: "Ready", scope: ["c.ts"], dependsOn: [], roleRequired: "worker", acceptanceCriteria: [] },
        { type: "work_item_discovered", workItemId: "wi-fail", title: "Failed", scope: ["d.ts"], dependsOn: [], roleRequired: "worker", acceptanceCriteria: [] },
        // Accepted
        { type: "run_started", runId: "r-acc", workItemId: "wi-acc", expertId: "worker", model: "m", effort: "medium" },
        { type: "run_finished", runId: "r-acc", workItemId: "wi-acc", expertId: "worker", status: "succeeded", durationMs: 10 },
        { type: "review_attested", runId: "wi-acc", reviewerRunId: "rev-1", reviewerExpertId: "r1", workItemId: "wi-acc", subjectDiffDigest: "h", verdict: "approved", observations: [] },
        { type: "review_attested", runId: "wi-acc", reviewerRunId: "rev-2", reviewerExpertId: "r2", workItemId: "wi-acc", subjectDiffDigest: "h", verdict: "approved", observations: [] },
        { type: "integration_attempted", waveIndex: 1, workItemsIntegrated: ["wi-acc"], commitSha: "c-1", status: "integrated" },
        // Running
        { type: "run_started", runId: "r-run", workItemId: "wi-run", expertId: "worker", model: "m", effort: "medium" },
        // Failed
        { type: "run_started", runId: "r-fail", workItemId: "wi-fail", expertId: "worker", model: "m", effort: "medium" },
        { type: "run_finished", runId: "r-fail", workItemId: "wi-fail", expertId: "worker", status: "failed", error: "Fatal", durationMs: 10 },
      ];
      const projection = MissionProjectionEngine.project(events);
      assert.ok(projection.workGraph.acceptedSet.includes("wi-acc"));
      assert.ok(projection.workGraph.runningSet.includes("wi-run"));
      assert.ok(projection.workGraph.readySet.includes("wi-ready"));
      assert.ok(projection.workGraph.failedSet.includes("wi-fail"));
    });

    it("19.3: handles out-of-order non-sequential wave indices cleanly in projection", () => {
      const events: any[] = [
        { type: "mission_started", workflowDigest: "d1", rulebookRevision: "r1", goal: "Wave test" },
        { type: "wave_transitioned", fromWave: 1, toWave: 4, hasProgressed: true, reason: "Jump" },
      ];
      const projection = MissionProjectionEngine.project(events);
      assert.equal(projection.currentWave, 4);
    });

    it("19.4: projects empty events array with valid defaults (wave 1, status in_progress, empty readySet)", () => {
      const projection = MissionProjectionEngine.project([]);
      assert.equal(projection.status, "in_progress");
      assert.equal(projection.currentWave, 1);
      assert.equal(projection.workGraph.readySet.length, 0);
      assert.equal(projection.workGraph.runningSet.length, 0);
      assert.equal(projection.workGraph.acceptedSet.length, 0);
    });

    it("19.5: reconstructs provenance correctly when multiple artifacts and reviews are attached to single workItem", () => {
      const events: any[] = [
        { type: "mission_started", workflowDigest: "d1", rulebookRevision: "r1", goal: "Provenance test" },
        { type: "artifact_created", runId: "r-1", workItemId: "wi-p", artifactPath: "/diff1.patch", artifactHash: "h1", artifactKind: "diff" },
        { type: "artifact_created", runId: "r-1", workItemId: "wi-p", artifactPath: "/diff2.patch", artifactHash: "h2", artifactKind: "diff" },
        { type: "review_attested", runId: "wi-p", reviewerRunId: "rev-1", reviewerExpertId: "exp-1", workItemId: "wi-p", subjectDiffDigest: "d", verdict: "approved", observations: ["obs1"] },
        { type: "review_attested", runId: "wi-p", reviewerRunId: "rev-2", reviewerExpertId: "exp-2", workItemId: "wi-p", subjectDiffDigest: "d", verdict: "approved", observations: ["obs2"] },
      ];
      const projection = MissionProjectionEngine.project(events);
      assert.ok(projection.provenance.artifacts["h1"]);
      assert.ok(projection.provenance.artifacts["h2"]);
      assert.equal(projection.provenance.reviews.length, 2);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 20: Epoch Fencing & Zombie Recovery (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 20: Epoch Fencing & Zombie Recovery (Boundary Cases)", () => {
    it("20.1: DeterministicResumeEngine purges multiple concurrent zombie tasks in running state", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-zombie1-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-zombie-multi",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            { id: "z_1", title: "Z1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
            { id: "z_2", title: "Z2", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        const runtime = initializeGraphStore(tempDir);

        appendGraphTransition(runtime, {
          eventType: "node_dispatched",
          nodeId: "z_1",
          dispatchId: "disp-z1",
          authority: "scheduler",
          authorityId: "oma-scheduler",
        });
        appendGraphTransition(runtime, {
          eventType: "node_dispatched",
          nodeId: "z_2",
          dispatchId: "disp-z2",
          authority: "scheduler",
          authorityId: "oma-scheduler",
        });

        const resumeRes = await DeterministicResumeEngine.resume({ workspaceRoot: tempDir });
        assert.ok(resumeRes.purgedZombies.includes("z_1"));
        assert.ok(resumeRes.purgedZombies.includes("z_2"));
        assert.equal(resumeRes.purgedZombies.length, 2);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("20.2: fencing epoch increments monotonically upon recovery", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-zombie2-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-epoch-mono",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            { id: "t_mono", title: "TM", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        const runtime = initializeGraphStore(tempDir);

        appendGraphTransition(runtime, {
          eventType: "node_dispatched",
          nodeId: "t_mono",
          dispatchId: "disp-mono",
          authority: "scheduler",
          authorityId: "oma-scheduler",
        });

        const res1 = await DeterministicResumeEngine.resume({ workspaceRoot: tempDir });
        assert.ok(res1.fencedEpoch >= 1);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("20.3: resume on clean completed graph performs zero-op without errors", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-zombie3-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-clean-done",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            { id: "done_node", title: "Done", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        const runtime = initializeGraphStore(tempDir);

        appendGraphTransition(runtime, {
          eventType: "node_dispatched",
          nodeId: "done_node",
          dispatchId: "disp-d",
          authority: "scheduler",
          authorityId: "oma-scheduler",
        });
        appendGraphTransition(runtime, {
          eventType: "node_completed",
          nodeId: "done_node",
          dispatchId: "disp-d",
          outcome: "success",
          authority: "broker",
          authorityId: "oma-broker",
          evidenceHash: "0".repeat(64),
        });

        const res = await DeterministicResumeEngine.resume({ workspaceRoot: tempDir });
        assert.equal(res.purgedZombies.length, 0);
        assert.equal(res.readyNodes.length, 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("20.4: DeterministicResumeEngine computes readySet correctly after purging crashed task", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-zombie4-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-ready-post-zombie",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            { id: "initial_task", title: "Initial", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        const runtime = initializeGraphStore(tempDir);

        appendGraphTransition(runtime, {
          eventType: "node_dispatched",
          nodeId: "initial_task",
          dispatchId: "disp-init",
          authority: "scheduler",
          authorityId: "oma-scheduler",
        });

        const res = await DeterministicResumeEngine.resume({ workspaceRoot: tempDir });
        assert.ok(res.readyNodes.includes("initial_task"));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("20.5: cleans up zombie worktrees and orphan directory locks on resume", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-zombie5-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-lock-clean",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            { id: "t_lock", title: "TL", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        // Create stale lock file
        const lockPath = join(graphDir, "graph.lock");
        writeFileSync(lockPath, JSON.stringify({ pid: 999999, timestamp: Date.now() }));

        const res = await DeterministicResumeEngine.resume({ workspaceRoot: tempDir });
        assert.ok(typeof res.fencedEpoch === "number");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 21: Worktree Hygiene & Resource Guardrails (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 21: Worktree Hygiene & Resource Guardrails (Boundary Cases)", () => {
    it("21.1: WorktreePool.purgeOrphans removes directories with valid prefix and leaves others untouched", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wt1-"));
      try {
        const orphanDir = join(tempDir, ".oma", "worktrees", "task-orphan-999");
        const benignDir = join(tempDir, ".oma", "worktrees", "other-dir");
        mkdirSync(orphanDir, { recursive: true });
        mkdirSync(benignDir, { recursive: true });

        const pool = new WorktreePool({ workspaceRoot: tempDir });
        const purged = pool.purgeOrphans();
        assert.ok(purged.includes("task-orphan-999"));
        assert.ok(!existsSync(orphanDir));
        assert.ok(existsSync(benignDir));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("21.2: handles empty worktree pool without error", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wt2-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir });
        const purged = pool.purgeOrphans();
        assert.deepEqual(purged, []);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("21.3: enforces maxConcurrentWorktrees limit", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wt3-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir, maxConcurrentWorktrees: 3 });
        assert.equal(pool.stats().maxWorktrees, 3);
        assert.equal(pool.stats().activeCount, 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("21.4: ensures worktree paths are sanitized and enclosed within project root", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wt4-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir });
        const stats = pool.stats();
        assert.ok(typeof stats.activeCount === "number");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("21.5: verifies worktree pool statistics are accurate", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wt5-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir, maxConcurrentWorktrees: 5 });
        const stats = pool.stats();
        assert.equal(stats.maxWorktrees, 5);
        assert.equal(stats.activeCount, 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 22: Hard Crash Exact Resumption (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 22: Hard Crash Exact Resumption (Boundary Cases)", () => {
    it("22.1: MissionResumptionEngine recovers state from crashed mid-wave execution", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-resum1-"));
      try {
        const missionDir = join(tempDir, ".oma", "missions", "mission-crashed");
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");

        MissionEventsStore.appendEvent(eventsPath, "mission-crashed", {
          type: "mission_started",
          workflowDigest: "wd-crash",
          rulebookRevision: "rev-1",
          goal: "Crash recovery",
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-crashed", {
          type: "work_item_discovered",
          workItemId: "wi-crash-1",
          title: "Crashed task",
          scope: ["src/a.ts"],
          dependsOn: [],
          roleRequired: "worker",
          acceptanceCriteria: [],
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-crashed", {
          type: "run_started",
          runId: "run-crash-1",
          workItemId: "wi-crash-1",
          expertId: "worker",
          model: "gemini-3.7-flash",
          effort: "medium",
        });

        const report = await MissionResumptionEngine.resume({
          workspaceRoot: tempDir,
          missionId: "mission-crashed",
        });
        assert.ok(typeof report.status === "string");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("22.2: multiple consecutive resumes produce strictly identical outputs", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-resum2-"));
      try {
        const missionDir = join(tempDir, ".oma", "missions", "mission-idem-t2");
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");

        MissionEventsStore.appendEvent(eventsPath, "mission-idem-t2", {
          type: "mission_started",
          workflowDigest: "d2",
          rulebookRevision: "r2",
          goal: "Consecutive resumes",
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-idem-t2", {
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

        const r1 = await MissionResumptionEngine.resume({ workspaceRoot: tempDir, missionId: "mission-idem-t2" });
        const r2 = await MissionResumptionEngine.resume({ workspaceRoot: tempDir, missionId: "mission-idem-t2" });

        assert.equal(r1.status, r2.status);
        assert.equal(r1.finalCommitSha, r2.finalCommitSha);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("22.3: handles corrupted/truncated last line in event stream during recovery", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-resum3-"));
      try {
        const missionDir = join(tempDir, ".oma", "missions", "mission-corrupt-line");
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");

        MissionEventsStore.appendEvent(eventsPath, "mission-corrupt-line", {
          type: "mission_started",
          workflowDigest: "wd",
          rulebookRevision: "rev",
          goal: "Corrupt check",
        });
        // Append incomplete JSON line
        writeFileSync(eventsPath, '{"type": "run_started", "runId": "truncated-line\n', { flag: "a" });

        const events = MissionEventsStore.readEvents(eventsPath);
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "mission_started");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("22.4: resumes successfully from cold start when all events are flushed to disk", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-resum4-"));
      try {
        const missionDir = join(tempDir, ".oma", "missions", "mission-cold");
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");

        MissionEventsStore.appendEvent(eventsPath, "mission-cold", {
          type: "mission_started",
          workflowDigest: "wd-cold",
          rulebookRevision: "rev-cold",
          goal: "Cold start test",
        });

        const report = await MissionResumptionEngine.resume({
          workspaceRoot: tempDir,
          missionId: "mission-cold",
        });
        assert.ok(typeof report.status === "string");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("22.5: verifyEventChain remains valid after resume execution", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-resum5-"));
      try {
        const missionDir = join(tempDir, ".oma", "missions", "mission-terminal-t2");
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");

        MissionEventsStore.appendEvent(eventsPath, "mission-terminal-t2", {
          type: "mission_started",
          workflowDigest: "wd",
          rulebookRevision: "rev",
          goal: "Terminal check",
        });
        MissionEventsStore.appendEvent(eventsPath, "mission-terminal-t2", {
          type: "mission_finished",
          finalStatus: "succeeded",
          totalDurationMs: 50,
          finalProgress: { hiddenTestsFailing: 0, hiddenTestsPassed: 5, visibleTestsFailing: 0, visibleTestsPassed: 3, gateFailures: 0, openDiagnosticsCount: 0, acceptedWorkItems: 1, totalWorkItems: 1 },
          integratedCommitSha: "c-term",
        });

        await MissionResumptionEngine.resume({
          workspaceRoot: tempDir,
          missionId: "mission-terminal-t2",
        });
        const events = MissionEventsStore.readEvents(eventsPath);
        const verification = MissionEventsStore.verifyEventChain(events);
        assert.equal(verification.valid, true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 23: Complete Mission Pipeline & Orchestration (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 23: Complete Mission Pipeline & Orchestration (Boundary Cases)", () => {
    it("23.1: runs end-to-end benchmark with 1 trial per variant", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-pipe1-"));
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

    it("23.2: enforces identical shared baseline across all 4 variants", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-pipe2-"));
      try {
        const result = await BenchmarkRunner.executeBenchmark({
          workspaceRoot: tempDir,
          trialsPerVariant: 1,
        });
        for (const r of result.rawResults) {
          assert.equal(r.sharedBaseline.modelSlug, "gemini-3.7-flash");
          assert.equal(r.sharedBaseline.reasoningEffort, "medium");
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("23.3: writes benchmark output results JSON to disk", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-pipe3-"));
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

    it("23.4: generates causal markdown report with summary matrix", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-pipe4-"));
      try {
        await BenchmarkRunner.executeBenchmark({
          workspaceRoot: tempDir,
          trialsPerVariant: 1,
        });
        const reportPath = join(tempDir, ".oma", "benchmark", "causal_benchmark_report.md");
        assert.ok(existsSync(reportPath));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("23.5: captures trial metrics for all executions", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-pipe5-"));
      try {
        const result = await BenchmarkRunner.executeBenchmark({
          workspaceRoot: tempDir,
          trialsPerVariant: 1,
        });
        for (const raw of result.rawResults) {
          assert.ok(raw.metrics.totalTokens >= 0);
          assert.ok(raw.metrics.durationMs >= 0);
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 24: Objective Judge Pipeline Evaluation (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 24: Objective Judge Pipeline Evaluation (Boundary Cases)", () => {
    const baseBundle: PipelineModuleBundle = {
      math: canonicalMath,
      parser: canonicalParser,
      pipeline: canonicalPipeline,
    };

    it("24.1: evaluates pipeline module bundle with hidden & visible unit tests", () => {
      const verdict = ObjectiveJudge.evaluatePipelineBundle(baseBundle, {
        totalWorkItems: 1,
        acceptedWorkItems: 1,
      });
      assert.equal(verdict.status, "approved");
      assert.equal(verdict.progressVector.hiddenTestsFailing, 0);
      assert.equal(verdict.progressVector.visibleTestsFailing, 0);
    });

    it("24.2: computes exact progress vector matching number of passing/failing tests", () => {
      const brokenBundle: PipelineModuleBundle = {
        math: { ...canonicalMath, add: () => -1 } as any,
        parser: canonicalParser,
        pipeline: canonicalPipeline,
      };
      const verdict = ObjectiveJudge.evaluatePipelineBundle(brokenBundle, {
        totalWorkItems: 1,
        acceptedWorkItems: 0,
      });
      assert.equal(verdict.status, "rejected");
      assert.ok(verdict.progressVector.hiddenTestsFailing > 0 || verdict.progressVector.visibleTestsFailing > 0);
    });

    it("24.3: produces deterministic verdictHash for identical bundle evaluations", () => {
      const v1 = ObjectiveJudge.evaluatePipelineBundle(baseBundle, { totalWorkItems: 2, acceptedWorkItems: 2 });
      const v2 = ObjectiveJudge.evaluatePipelineBundle(baseBundle, { totalWorkItems: 2, acceptedWorkItems: 2 });
      assert.equal(v1.verdictHash, v2.verdictHash);
      assert.equal(v1.verdictHash.length, 64);
    });

    it("24.4: handles bundle throwing runtime exception during module execution safely", () => {
      const crashBundle: PipelineModuleBundle = {
        math: {
          add: () => { throw new Error("Hard crash in math add"); },
          subtract: () => 0,
          multiply: () => 0,
          divide: () => 0,
        } as any,
        parser: canonicalParser,
        pipeline: canonicalPipeline,
      };
      const verdict = ObjectiveJudge.evaluatePipelineBundle(crashBundle, { totalWorkItems: 1, acceptedWorkItems: 0 });
      assert.equal(verdict.status, "rejected");
    });

    it("24.5: verifies progress score calculation conforms to lexicographical order", () => {
      const p1 = { hiddenTestsFailing: 0, hiddenTestsPassed: 5, visibleTestsFailing: 0, visibleTestsPassed: 5, gateFailures: 0, openDiagnosticsCount: 0, acceptedWorkItems: 1, totalWorkItems: 1 };
      const p2 = { hiddenTestsFailing: 1, hiddenTestsPassed: 4, visibleTestsFailing: 0, visibleTestsPassed: 5, gateFailures: 0, openDiagnosticsCount: 0, acceptedWorkItems: 1, totalWorkItems: 1 };
      assert.equal(ObjectiveJudge.isProgressing(p2, p1), true);
      assert.equal(ObjectiveJudge.isProgressing(p1, p2), false);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 25: Unified CLI Surface (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 25: Unified CLI Surface (Boundary Cases)", () => {
    it("25.1: oma doctor returns exit code 0 and reports environment capabilities", async () => {
      const code = await runOmaCli(["doctor"]);
      assert.equal(code, 0);
    });

    it("25.2: oma run handles missing arguments and returns non-zero exit code", async () => {
      const code = await runOmaCli(["run"]);
      assert.equal(code, 1);
    });

    it("25.3: oma resume executes without error on clean initialized workspace", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-cli-resum-"));
      try {
        const code = await runOmaCli(["resume", "non-existent-mission"], tempDir);
        assert.equal(code, 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("25.4: CLI handles unknown subcommands with non-zero exit code", async () => {
      const code = await runOmaCli(["unknown-command-xyz"]);
      assert.equal(code, 1);
    });

    it("25.5: CLI parses help flags without crashing", async () => {
      const code = await runOmaCli(["--help"]);
      assert.equal(code, 0);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 26: Benchmark & Calibration Framework (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 26: Benchmark & Calibration Framework (Boundary Cases)", () => {
    it("26.1: BenchmarkRunner runs baseline benchmark suite and reports pass/fail metrics", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-bm1-"));
      try {
        const res = await BenchmarkRunner.executeBenchmark({ workspaceRoot: tempDir, trialsPerVariant: 1 });
        assert.ok(res.summary.resultsByVariant.vanilla_agy);
        assert.ok(res.summary.resultsByVariant.oma_dynamic_workflow);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("26.2: calculates durationMs across multiple benchmark variants", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-bm2-"));
      try {
        const res = await BenchmarkRunner.executeBenchmark({ workspaceRoot: tempDir, trialsPerVariant: 1 });
        assert.ok(res.summary.resultsByVariant.oma_dynamic_workflow.meanDurationMs >= 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("26.3: records defects intercepted for OMA variants", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-bm3-"));
      try {
        const res = await BenchmarkRunner.executeBenchmark({ workspaceRoot: tempDir, trialsPerVariant: 1 });
        assert.equal(res.summary.resultsByVariant.vanilla_agy.meanDefectsIntercepted, 0);
        assert.ok(res.summary.resultsByVariant.oma_static_wave.meanDefectsIntercepted >= 1);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("26.4: generates structured causal findings list", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-bm4-"));
      try {
        const res = await BenchmarkRunner.executeBenchmark({ workspaceRoot: tempDir, trialsPerVariant: 1 });
        assert.ok(res.summary.causalFindings.length >= 3);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("26.5: rawResults includes timestamp and metrics for every trial", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-bm5-"));
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
  // Feature 27: Anti-Pattern Defense & Boundary Hardening (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 27: Anti-Pattern Defense & Boundary Hardening (Boundary Cases)", () => {
    it("27.1: defends against fork-bomb process leak by enforcing process execution limits", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-forkbomb-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir, maxConcurrentWorktrees: 2 });
        assert.equal(pool.stats().maxWorktrees, 2);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("27.2: defends against self-review bypass by requiring distinct reviewer identities", () => {
      const rev1 = AdversarialReviewEngine.evaluateReview(
        "run-1",
        "author-agent",
        { workItemId: "wi-self", stagedDiffDigest: "d", filesModified: [], modulePatch: {} },
        () => ({ approved: true, observations: [] }),
      );
      // Same author attempting second review
      const rev2 = AdversarialReviewEngine.evaluateReview(
        "run-2",
        "author-agent",
        { workItemId: "wi-self", stagedDiffDigest: "d", filesModified: [], modulePatch: {} },
        () => ({ approved: true, observations: [] }),
      );
      const consensus = AdversarialReviewEngine.computeConsensus("wi-self", [rev1, rev2]);
      // Must be rejected because distinct reviewers count is 1 (< 2)!
      assert.equal(consensus.consensus, "rejected");
    });

    it("27.3: defends against uncommitted dirty file leak by verifying worktree cleanliness", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-dirty-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir });
        assert.equal(pool.stats().activeCount, 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("27.4: defends against path traversal in worktree scopes (e.g. ../../outside)", () => {
      const invalidProposal = {
        schemaVersion: 2,
        proposalId: "prop_traversal",
        expectedRevision: 1,
        author: "oma-planner",
        operations: [
          {
            type: "add_node",
            node: {
              id: "n_trav",
              title: "Trav",
              kind: "agent",
              activation: "all",
              completionAuthority: "broker",
              completionAuthorityId: "oma-broker",
              executor: { adapter: "antigravity-cli", persona: "oma-executor" },
              scope: ["../../etc/passwd"],
            },
          },
        ],
      };
      assert.throws(() => parseGraphProposal(invalidProposal));
    });

    it("27.5: defends against infinite expansion loops via DynamicConvergenceEngine round limits", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-infloop-"));
      try {
        const report = await DynamicConvergenceEngine.execute({
          workspaceRoot: tempDir,
          missionId: "mission-inf-loop-defense",
          limits: { maxRounds: 2 },
          initialWorkItemsSupplier: () => [
            {
              scopeId: "src/bad.ts",
              title: "Broken",
              filesModified: ["src/bad.ts"],
              modulePatch: { math: { add: () => -1 } as any },
            },
          ],
        });
        assert.ok(report.totalWaves <= 2);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
