import assert from "node:assert/strict";
import { describe, it, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import * as originalMath from "../../test-fixtures/minimal-pipeline/src/math.js";
import * as originalParser from "../../test-fixtures/minimal-pipeline/src/parser.js";
import * as originalPipeline from "../../test-fixtures/minimal-pipeline/src/pipeline.js";

import { MissionResumptionEngine } from "../orchestration/mission-resumption.js";
import {
  MissionEventsStore,
  generateDeterministicRunId,
  generateDeterministicWorkItemId,
} from "../ledger/mission-events.js";
import { MissionProjectionEngine } from "../graph/mission-projections.js";
import type { PipelineModuleBundle } from "../oracle/objective-judge.js";

describe("Phase 5 — Interruption, Reprise & Suivi (Gate Observable)", () => {
  const baseBundle: PipelineModuleBundle = {
    math: originalMath,
    parser: originalParser,
    pipeline: originalPipeline,
  };

  it("Gate 5.1 & 5.2: Interrupted run is marked terminal interrupted, new attempt spawned, succeeded run retained", async () => {
    const testDir = join(process.cwd(), ".oma", "test-phase5-resume");
    const missionId = "mission-interrupted-resume";
    const missionDir = join(testDir, ".oma", "missions", missionId);
    mkdirSync(missionDir, { recursive: true });
    const eventsPath = join(missionDir, "events.jsonl");

    try {
      const wiMath = generateDeterministicWorkItemId("src/math.ts");
      const wiParser = generateDeterministicWorkItemId("src/parser.ts");

      const runMath1 = generateDeterministicRunId(wiMath, "worker", 1);
      const runParser1 = generateDeterministicRunId(wiParser, "worker", 1);

      // 1. Mission started & work items discovered
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "mission_started",
        workflowDigest: "digest-resumption-v1",
        rulebookRevision: "rev-001",
        goal: "Resumption test",
      });

      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "work_item_discovered",
        workItemId: wiMath,
        title: "Implement Math",
        scope: ["src/math.ts"],
        dependsOn: [],
        roleRequired: "worker",
        acceptanceCriteria: ["add", "multiply"],
      });

      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "work_item_discovered",
        workItemId: wiParser,
        title: "Implement Parser",
        scope: ["src/parser.ts"],
        dependsOn: [],
        roleRequired: "worker",
        acceptanceCriteria: ["parseExpression"],
      });

      // 2. Math completes successfully
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "run_started",
        runId: runMath1,
        workItemId: wiMath,
        expertId: "worker",
        model: "gemini-3.7-flash",
        effort: "medium",
      });

      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "artifact_created",
        runId: runMath1,
        workItemId: wiMath,
        artifactPath: "artifacts/diff-math.patch",
        artifactHash: "m".repeat(64),
        artifactKind: "diff",
      });

      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "run_finished",
        runId: runMath1,
        workItemId: wiMath,
        expertId: "worker",
        status: "succeeded",
        durationMs: 800,
      });

      // 3. Parser was started when process was violently killed (CRASH / KILL SIMULATION)
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "run_started",
        runId: runParser1,
        workItemId: wiParser,
        expertId: "worker",
        model: "gemini-3.7-flash",
        effort: "medium",
      });
      // (No run_finished for runParser1!)

      // 4. Verify pre-resumption state (Parser is 'running')
      const preEvents = MissionEventsStore.readEvents(eventsPath);
      const preProj = MissionProjectionEngine.project(preEvents);
      assert.equal(preProj.workGraph.runs[runParser1].status, "running");

      // 5. Trigger oma resume via MissionResumptionEngine
      const result = await MissionResumptionEngine.resume({
        workspaceRoot: testDir,
        missionId,
        baseBundle,
        workItemsFixes: {
          [wiMath]: { modulePatch: { math: originalMath }, rawDiffContent: "diff math" },
          [wiParser]: { modulePatch: { parser: originalParser }, rawDiffContent: "diff parser" },
        },
      });

      assert.equal(result.status, "succeeded");
      assert.deepEqual(result.interruptedRunsRecovered, [runParser1], "runParser1 must be recovered as interrupted");
      assert.deepEqual(result.retainedSucceededRuns, [runMath1], "runMath1 was succeeded and must be retained");
      assert.ok(result.newAttemptsSpawned.length > 0, "A new attempt must be spawned for parser");
      assert.ok(result.finalCommitSha, "Exactly one final commit must be produced");

      // 6. Verify post-resumption projection integrity
      const postEvents = MissionEventsStore.readEvents(eventsPath);
      const postProj = MissionProjectionEngine.project(postEvents);

      assert.equal(postProj.status, "succeeded");
      assert.equal(postProj.workGraph.runs[runParser1].status, "interrupted", "Zombie run must be terminal interrupted");
      assert.equal(postProj.workGraph.acceptedSet.length, 2, "Both math and parser must be accepted");
      assert.equal(postProj.progress.acceptedWorkItems, 2);
    } finally {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(testDir, { recursive: true, force: true });
          if (!existsSync(testDir)) break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    }
  });
});
