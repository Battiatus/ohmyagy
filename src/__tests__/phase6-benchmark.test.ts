import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BenchmarkRunner } from "../benchmark/benchmark-runner.js";

describe("Phase 6 — Benchmark Causal (Gate Observable)", () => {
  it("Gate 6.1, 6.2 & 6.3: Automated paired & repeated benchmark across 4 frozen variants produces causal conclusions", { timeout: 180_000 }, async () => {
    const testDir = join(process.cwd(), ".oma", "test-phase6-benchmark");
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    try {
      const trialsPerVariant = 3;
      const { summary, rawResults, resultsFilePath } = await BenchmarkRunner.executeBenchmark({
        workspaceRoot: testDir,
        trialsPerVariant,
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
