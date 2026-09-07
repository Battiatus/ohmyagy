import assert from "node:assert/strict";
import { describe, it, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import * as originalMath from "../../test-fixtures/minimal-pipeline/src/math.js";
import * as originalParser from "../../test-fixtures/minimal-pipeline/src/parser.js";
import * as originalPipeline from "../../test-fixtures/minimal-pipeline/src/pipeline.js";

import * as mutant1Math from "../../test-fixtures/minimal-pipeline/src/mutants/mutant1-math.js";
import * as mutant2Parser from "../../test-fixtures/minimal-pipeline/src/mutants/mutant2-parser.js";

import { WaveScheduler, type StaticWorkItemInput } from "../orchestration/wave-scheduler.js";
import { MissionEventsStore } from "../ledger/mission-events.js";
import type { PipelineModuleBundle } from "../oracle/objective-judge.js";
import { MockAgyDriver } from "../runtime/mock-driver.js";

describe("Phase 2 — Une Vague Statique Réelle & Gate Observable", () => {
  const baseBundle: PipelineModuleBundle = {
    math: originalMath,
    parser: originalParser,
    pipeline: originalPipeline,
  };

  it("Gate 2.1 & 2.2: Real parallel execution with time overlap, distinct worktrees & run identities", async () => {
    const testDir = join(process.cwd(), ".oma", "test-phase2-parallel");
    const eventsPath = join(testDir, "events.jsonl");
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    try {
      const workItems: StaticWorkItemInput[] = [
        {
          scopeId: "src/math.ts",
          title: "Optimize Math Module",
          filesModified: ["src/math.ts"],
          modulePatch: { math: originalMath },
          rawDiffContent: "diff --git a/src/math.ts b/src/math.ts\n+export function add...",
          workerDelayMs: 20, // Introduces real concurrent overlap
        },
        {
          scopeId: "src/parser.ts",
          title: "Improve Parser Resilience",
          filesModified: ["src/parser.ts"],
          modulePatch: { parser: originalParser },
          rawDiffContent: "diff --git a/src/parser.ts b/src/parser.ts\n+export function parse...",
          workerDelayMs: 20,
        },
      ];

      const report = await WaveScheduler.executeStaticWave({
        workspaceRoot: testDir,
        missionId: "mission-phase2-green",
        eventsPath,
        baseBundle,
        workItems,
        driver: new MockAgyDriver(),
      });

      assert.equal(report.status, "succeeded");
      assert.equal(report.parallelOverlapObserved, true, "Workers must overlap in execution time");
      assert.equal(report.reviewsCount, 4, "2 work items * 2 independent reviews = 4 reviews");
      assert.ok(report.integrationReport?.commitHash, "Single commit hash must be produced");

      // Verify diff artifacts were preserved on disk after worktree cleanup
      const artMath = join(testDir, ".oma", "missions", "mission-phase2-green", "artifacts", "diff-work-src-math-ts.patch");
      const artParser = join(testDir, ".oma", "missions", "mission-phase2-green", "artifacts", "diff-work-src-parser-ts.patch");
      assert.ok(existsSync(artMath), "Frozen math diff artifact must exist");
      assert.ok(existsSync(artParser), "Frozen parser diff artifact must exist");

      // Verify events in journal
      const events = MissionEventsStore.readEvents(eventsPath);
      assert.ok(events.some((e) => e.type === "mission_started"));
      assert.ok(events.some((e) => e.type === "artifact_created" && e.workItemId === "work-src-math-ts"));
      assert.ok(events.some((e) => e.type === "artifact_created" && e.workItemId === "work-src-parser-ts"));
      assert.ok(events.some((e) => e.type === "review_attested" && e.reviewerExpertId === "reviewer-alpha"));
      assert.ok(events.some((e) => e.type === "review_attested" && e.reviewerExpertId === "reviewer-beta"));
      assert.ok(events.some((e) => e.type === "integration_attempted" && e.status === "integrated"));
      assert.ok(events.some((e) => e.type === "mission_finished" && e.finalStatus === "succeeded"));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("Gate 2.3: Red Gate — Adversarial review and judge reject faulty/mutant diffs without mutating target", async () => {
    const testDir = join(process.cwd(), ".oma", "test-phase2-red");
    const eventsPath = join(testDir, "events.jsonl");
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    try {
      const faultyWorkItems: StaticWorkItemInput[] = [
        {
          scopeId: "src/math.ts",
          title: "Faulty Mutant Math Implementation",
          filesModified: ["src/math.ts"],
          modulePatch: { math: mutant1Math },
          rawDiffContent: "diff --git a/src/math.ts b/src/math.ts\n+mutant1 logic",
        },
      ];

      const report = await WaveScheduler.executeStaticWave({
        workspaceRoot: testDir,
        missionId: "mission-phase2-red",
        eventsPath,
        baseBundle,
        workItems: faultyWorkItems,
        driver: new MockAgyDriver(),
      });

      assert.equal(report.status, "failed");
      assert.equal(report.integrationReport?.status, "judge_rejected");

      const events = MissionEventsStore.readEvents(eventsPath);
      const finishedEvent = events.find((e) => e.type === "mission_finished");
      assert.equal(finishedEvent?.finalStatus, "failed");
      assert.ok(!events.some((e) => e.type === "integration_attempted" && e.status === "integrated"));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("Gate 2.4: Conflict Blocker — Overlapping scope generates Blocker without auto-merging", async () => {
    const testDir = join(process.cwd(), ".oma", "test-phase2-conflict");
    const eventsPath = join(testDir, "events.jsonl");
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    try {
      const conflictingWorkItems: StaticWorkItemInput[] = [
        {
          scopeId: "src/math.ts",
          title: "Math Feature A",
          filesModified: ["src/math.ts"],
          modulePatch: { math: originalMath },
          rawDiffContent: "diff --git a/src/math.ts b/src/math.ts\n+feature A",
        },
        {
          scopeId: "src/math-alt.ts",
          title: "Math Feature B Overlapping",
          filesModified: ["src/math.ts"], // Conflicting file target!
          modulePatch: { math: originalMath },
          rawDiffContent: "diff --git a/src/math.ts b/src/math.ts\n+feature B",
        },
      ];

      const report = await WaveScheduler.executeStaticWave({
        workspaceRoot: testDir,
        missionId: "mission-phase2-conflict",
        eventsPath,
        baseBundle,
        workItems: conflictingWorkItems,
        driver: new MockAgyDriver(),
      });

      assert.equal(report.status, "conflict_blocked");
      assert.ok(report.integrationReport?.conflictDetails?.includes("Scope conflict on file 'src/math.ts'"));

      const events = MissionEventsStore.readEvents(eventsPath);
      const conflictEvent = events.find((e) => e.type === "integration_attempted");
      assert.equal(conflictEvent?.status, "conflict_blocked");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
