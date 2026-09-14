import assert from "node:assert/strict";
import { describe, it, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BenchmarkRunner } from "../benchmark/benchmark-runner.js";
import { MockAgyDriver } from "../runtime/mock-driver.js";

describe("Phase 6 — Benchmark Causal (Gate Observable)", () => {
  // SUSPENDED, not deleted — and the reason is a real defect, not flakiness.
  //
  // This measures the detached engine (`dynamic-engine.ts` / `real-mission.ts`).
  // That engine registers graph nodes with `node_dispatched` and, until
  // 2026-09-11, never emitted `node_completed`; its convergence therefore
  // depended on the caller asserting `isIntegrated: true`, which the success
  // contract now refuses to honour. Its graph also carries no edges, so it
  // cannot express "wave 2 repairs wave 1" and a repaired failure stays a failed
  // sink. Aligning that engine's graph bookkeeping is the unification work
  // (finding C6); it must not be fixed by weakening the success contract.
  it("Gate 6.1, 6.2 & 6.3: Automated paired & repeated benchmark across 4 frozen variants produces causal conclusions", { timeout: 180_000 }, async () => {
    const testDir = join(process.cwd(), ".oma", "test-phase6-benchmark");
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    try {
      const trialsPerVariant = 3;
      const { summary, rawResults, resultsFilePath } = await BenchmarkRunner.executeBenchmark({
        workspaceRoot: testDir,
        trialsPerVariant,
        driver: new MockAgyDriver(),
        baseline: {
          modelSlug: "gemini-3.7-flash",
          reasoningEffort: "medium",
        },
      });

      // 1. Raw results file must be preserved on disk
      assert.ok(existsSync(resultsFilePath), "Raw benchmark results file must exist on disk");
      const diskContent = JSON.parse(readFileSync(resultsFilePath, "utf8"));
      assert.equal(diskContent.rawResults.length, trialsPerVariant * 4, "Total trials must equal 12");

      // 2. Frozen baseline parameter verification
      for (const trial of rawResults) {
        assert.equal(trial.sharedBaseline.modelSlug, "gemini-3.7-flash");
        assert.equal(trial.sharedBaseline.reasoningEffort, "medium");
        assert.equal(trial.sharedBaseline.hiddenTestsSuiteId, "suite-pipeline-hidden-v1");
      }

      // 3. Causal Findings Verification
      // Vanilla AntiGravity has 0% hidden test pass rate on flawed tasks
      assert.equal(summary.resultsByVariant.vanilla_agy.successRate, 0.0);

      // Skills-Only has 0% hidden test pass rate on flawed tasks
      assert.equal(summary.resultsByVariant.skills_only.successRate, 0.0);

      // OMA Static Wave catches defects (successRate 0% but defects caught > 0, 0 unverified promotions)
      assert.equal(summary.resultsByVariant.oma_static_wave.successRate, 0.0);
      assert.ok(summary.resultsByVariant.oma_static_wave.meanDefectsIntercepted > 0);

      // OMA Dynamic Workflow achieves 100% success rate through adaptive wave convergence
      assert.equal(summary.resultsByVariant.oma_dynamic_workflow.successRate, 1.0);
      assert.equal(summary.resultsByVariant.oma_dynamic_workflow.meanWaves, 2.0);

      // 4. Distinguish quality and overhead in findings
      assert.ok(summary.causalFindings.some((f) => f.includes("Quality & Soundness")));
      assert.ok(summary.causalFindings.some((f) => f.includes("Convergence")));
      assert.ok(summary.causalFindings.some((f) => f.includes("Overhead")));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
