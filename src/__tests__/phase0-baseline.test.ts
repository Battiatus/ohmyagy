import assert from "node:assert/strict";
import { describe, it, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 1. Fixture & Judge Imports
import * as originalMath from "../../test-fixtures/minimal-pipeline/src/math.js";
import * as originalParser from "../../test-fixtures/minimal-pipeline/src/parser.js";
import * as originalPipeline from "../../test-fixtures/minimal-pipeline/src/pipeline.js";

import * as mutant1Math from "../../test-fixtures/minimal-pipeline/src/mutants/mutant1-math.js";
import * as mutant2Parser from "../../test-fixtures/minimal-pipeline/src/mutants/mutant2-parser.js";

import { ObjectiveJudge, type PipelineModuleBundle, type ProgressVector } from "../oracle/objective-judge.js";
import {
  MissionEventsStore,
  generateDeterministicRunId,
  generateDeterministicWorkItemId,
} from "../ledger/mission-events.js";
import {
  DeterministicIntegrator,
  type WorkItemChangeProposal,
} from "../orchestration/integrator.js";
import { OmaDoctor } from "../runtime/doctor.js";
import type { BenchmarkSharedBaseline } from "../benchmark/types.js";

describe("Phase 0 — Juge, Fixture, Baseline & Gate Observable", () => {
  const originalBundle: PipelineModuleBundle = {
    math: originalMath,
    parser: originalParser,
    pipeline: originalPipeline,
  };

  it("Gate 0.1: Objective Judge accepts original fixture implementation", () => {
    const verdict = ObjectiveJudge.evaluatePipelineBundle(originalBundle);

    assert.equal(verdict.status, "approved");
    assert.equal(verdict.progressVector.hiddenTestsFailing, 0);
    assert.equal(verdict.progressVector.visibleTestsFailing, 0);
    assert.equal(verdict.progressVector.gateFailures, 0);
    assert.equal(verdict.progressVector.acceptedWorkItems, 3);
    assert.equal(verdict.diagnostics.length, 0);
    assert.ok(verdict.verdictHash.length === 64);
  });

  it("Gate 0.2: Objective Judge strictly rejects Mutant 1 (naive recursive fibonacci)", () => {
    const mutant1Bundle: PipelineModuleBundle = {
      math: mutant1Math,
      parser: originalParser,
      pipeline: originalPipeline,
    };

    const verdict = ObjectiveJudge.evaluatePipelineBundle(mutant1Bundle);

    assert.equal(verdict.status, "rejected");
    assert.ok(verdict.progressVector.hiddenTestsFailing > 0, "Hidden tests must fail for Mutant 1");
    assert.equal(verdict.progressVector.gateFailures, 1);
    assert.ok(
      verdict.diagnostics.some((d) => d.includes("fibonacci negative rejection")),
      "Must diagnose negative fibonacci violation",
    );
  });

  it("Gate 0.3: Mutant 1 passes visible tests (demonstrating visible tests alone are insufficient for promotion)", () => {
    // Mutant 1 passes visible test values
    assert.equal(mutant1Math.add(2, 3), 5);
    assert.equal(mutant1Math.multiply(4, 5), 20);
    assert.equal(mutant1Math.fibonacci(5), 5); // Passes visible input 5
  });

  it("Gate 0.4: Objective Judge strictly rejects Mutant 2 (naive integer-only parser)", () => {
    const mutant2Bundle: PipelineModuleBundle = {
      math: originalMath,
      parser: mutant2Parser,
      pipeline: originalPipeline,
    };

    const verdict = ObjectiveJudge.evaluatePipelineBundle(mutant2Bundle);

    assert.equal(verdict.status, "rejected");
    assert.ok(verdict.progressVector.hiddenTestsFailing > 0, "Hidden tests must fail for Mutant 2");
    assert.equal(verdict.progressVector.gateFailures, 1);
    assert.ok(
      verdict.diagnostics.some((d) => d.includes("parser decimal & whitespace tolerance")),
      "Must diagnose decimal / whitespace rejection",
    );
  });

  it("Gate 0.5: Mutant 2 passes visible tests (demonstrating visible tests alone are insufficient for promotion)", () => {
    const p1 = mutant2Parser.parseExpression("2 + 3");
    assert.equal(p1.op, "add");
    assert.deepEqual(p1.args, [2, 3]);

    const p2 = mutant2Parser.parseExpression("4 * 5");
    assert.equal(p2.op, "multiply");
    assert.deepEqual(p2.args, [4, 5]);

    const p3 = mutant2Parser.parseExpression("fib(5)");
    assert.equal(p3.op, "fib");
    assert.deepEqual(p3.args, [5]);
  });

  it("Gate 0.6: ProgressVector lexicographical comparison evaluates progress monotonically", () => {
    const initialVector: ProgressVector = {
      hiddenTestsFailing: 2,
      hiddenTestsPassed: 3,
      visibleTestsFailing: 1,
      visibleTestsPassed: 2,
      gateFailures: 1,
      openDiagnosticsCount: 3,
      acceptedWorkItems: 1,
      totalWorkItems: 3,
    };

    const improvedVector: ProgressVector = {
      hiddenTestsFailing: 0,
      hiddenTestsPassed: 5,
      visibleTestsFailing: 0,
      visibleTestsPassed: 3,
      gateFailures: 0,
      openDiagnosticsCount: 0,
      acceptedWorkItems: 3,
      totalWorkItems: 3,
    };

    const regressedVector: ProgressVector = {
      hiddenTestsFailing: 3,
      hiddenTestsPassed: 2,
      visibleTestsFailing: 2,
      visibleTestsPassed: 1,
      gateFailures: 1,
      openDiagnosticsCount: 5,
      acceptedWorkItems: 0,
      totalWorkItems: 3,
    };

    assert.equal(ObjectiveJudge.isProgressing(initialVector, improvedVector), true);
    assert.equal(ObjectiveJudge.isProgressing(initialVector, regressedVector), false);
    assert.equal(ObjectiveJudge.isProgressing(initialVector, initialVector), false);
  });

  it("Gate 0.7: Authoritative single event log (events.jsonl), hash chaining & projection reconstruction", () => {
    const testDir = join(process.cwd(), ".oma", "test-phase0-mission");
    const eventsPath = join(testDir, "events.jsonl");
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    try {
      const missionId = "mission-phase0-test";
      const wiId1 = generateDeterministicWorkItemId("src/math.ts");
      const wiId2 = generateDeterministicWorkItemId("src/parser.ts");
      const runId1 = generateDeterministicRunId(wiId1, "worker-alpha", 1);

      // Append events
      const e1 = MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "mission_started",
        workflowDigest: "digest-converge-v1",
        rulebookRevision: "rev-001",
        goal: "Implement pipeline baseline",
      });
      assert.equal(e1.seq, 1);

      const e2 = MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "work_item_discovered",
        workItemId: wiId1,
        title: "Implement Math Module",
        scope: ["src/math.ts"],
        dependsOn: [],
        roleRequired: "worker",
        acceptanceCriteria: ["add", "multiply", "fibonacci"],
      });
      assert.equal(e2.seq, 2);

      const e3 = MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "run_started",
        runId: runId1,
        workItemId: wiId1,
        expertId: "worker-alpha",
        model: "gemini-3.7-flash",
        effort: "medium",
      });
      assert.equal(e3.seq, 3);

      const events = MissionEventsStore.readEvents(eventsPath);
      assert.equal(events.length, 3);

      // Verify hash chain
      const verification = MissionEventsStore.verifyEventChain(events);
      assert.equal(verification.valid, true);

      // Reconstruct projection from scratch
      const projection = MissionEventsStore.projectMission(events);
      assert.equal(projection.missionId, missionId);
      assert.equal(projection.workItems.size, 1);
      assert.equal(projection.runs.size, 1);
      assert.equal(projection.workItems.get(wiId1)?.state, "running");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("Gate 0.8: Deterministic Integrator detects conflicts and merges clean proposals", () => {
    const wiMath = generateDeterministicWorkItemId("src/math.ts");
    const wiParser = generateDeterministicWorkItemId("src/parser.ts");

    const proposalA: WorkItemChangeProposal = {
      workItemId: wiMath,
      filesModified: ["src/math.ts"],
      modulePatch: { math: originalMath },
      stagedDiffDigest: "a".repeat(64),
    };

    const proposalB: WorkItemChangeProposal = {
      workItemId: wiParser,
      filesModified: ["src/parser.ts"],
      modulePatch: { parser: originalParser },
      stagedDiffDigest: "b".repeat(64),
    };

    // 1. Clean integration of parallel proposals
    const reportClean = DeterministicIntegrator.integrateWorkItems(originalBundle, [
      proposalB,
      proposalA,
    ]);
    assert.equal(reportClean.status, "integrated");
    assert.deepEqual(reportClean.integratedWorkItems, [wiMath, wiParser]); // Deterministic sort
    assert.ok(reportClean.commitHash);

    // 2. Conflict detection on overlapping file scope
    const conflictingProposal: WorkItemChangeProposal = {
      workItemId: "work-conflict",
      filesModified: ["src/math.ts"],
      modulePatch: { math: mutant1Math },
      stagedDiffDigest: "c".repeat(64),
    };

    const reportConflict = DeterministicIntegrator.integrateWorkItems(originalBundle, [
      proposalA,
      conflictingProposal,
    ]);
    assert.equal(reportConflict.status, "conflict_blocked");
    assert.ok(reportConflict.conflictDetails?.includes("Scope conflict on file 'src/math.ts'"));
  });

  it("Gate 0.9: OMA Doctor reports system capabilities and diagnostic fields", () => {
    const report = OmaDoctor.diagnoseEnvironment(process.cwd());

    assert.ok(report.timestamp);
    assert.ok(report.os);
    assert.ok(report.gitCli);
    assert.ok(report.bunCli);
    assert.ok(Array.isArray(report.agyCli.supportedFlags));
  });

  it("Gate 0.10: Benchmark Shared Baseline enforces unified configuration across variants", () => {
    const baseline: BenchmarkSharedBaseline = {
      baselineCommitSha: "commit-phase0-root",
      taskPrompt: "Implement pipeline components with full test coverage",
      modelSlug: "gemini-3.7-flash",
      reasoningEffort: "medium",
      timeoutMs: 60000,
      maxBudgetTokens: 50000,
      hiddenTestsSuiteId: "suite-pipeline-hidden-v1",
    };

    assert.ok(baseline.baselineCommitSha.length > 0);
    assert.ok(baseline.taskPrompt.length > 0);
    assert.equal(baseline.reasoningEffort, "medium");
  });
});
