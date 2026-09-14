import { describe, it, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BenchmarkRunner } from "../benchmark-runner.js";
import { MockAgyDriver } from "../../runtime/mock-driver.js";

describe("BenchmarkRunner Unit & Causal Validation Suite", () => {
  let testWorkspace: string;

  beforeAll(() => {
    testWorkspace = mkdtempSync(join(tmpdir(), "oma-bench-test-"));
  });

  afterAll(() => {
    try {
      rmSync(testWorkspace, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  // SUSPENDED with Phase 6: the benchmark scores success from the detached
  // engine's report, and that engine could only ever report success through the
  // `isIntegrated` bypass the success contract now refuses. Re-enable together
  // with the engine's graph alignment (finding C6).
  it("executes multi-trial benchmark across all 4 variants with genuine metrics", { timeout: 30000 }, async () => {
    const trialsCount = 2;
    const { summary, rawResults, resultsFilePath } = await BenchmarkRunner.executeBenchmark({
      workspaceRoot: testWorkspace,
      trialsPerVariant: trialsCount,
      driver: new MockAgyDriver(),
    });

    assert.equal(summary.taskId, "minimal-pipeline-causal-bench");
    assert.equal(summary.totalTrialsPerVariant, trialsCount);
    assert.equal(rawResults.length, 4 * trialsCount);

    // Verify persistence
    assert.ok(existsSync(resultsFilePath));
    const persistedJson = JSON.parse(readFileSync(resultsFilePath, "utf8"));
    assert.equal(persistedJson.summary.taskId, "minimal-pipeline-causal-bench");
    assert.equal(persistedJson.rawResults.length, 4 * trialsCount);

    const reportPath = join(testWorkspace, ".oma", "benchmark", "causal_benchmark_report.md");
    assert.ok(existsSync(reportPath));
    const reportContent = readFileSync(reportPath, "utf8");
    assert.ok(reportContent.includes("Rapport de Benchmark Causal Empirique"));
    assert.ok(reportContent.includes("vanilla_agy"));
    assert.ok(reportContent.includes("oma_dynamic_workflow"));

    // Verify Causal Invariants
    const v = summary.resultsByVariant;

    // 1. Vanilla AntiGravity: 0% hidden test success rate
    assert.equal(v.vanilla_agy.successRate, 0);
    assert.equal(v.vanilla_agy.meanDefectsIntercepted, 0);
    assert.ok(v.vanilla_agy.meanDurationMs >= 0);

    // 2. Skills-Only: 0% hidden test success rate
    assert.equal(v.skills_only.successRate, 0);
    assert.equal(v.skills_only.meanDefectsIntercepted, 0);

    // 3. OMA Static Wave: Intercepts defect at gate (0% unverified promotion)
    assert.equal(v.oma_static_wave.successRate, 0);
    assert.ok(v.oma_static_wave.meanDefectsIntercepted >= 1);

    // 4. OMA Dynamic Workflow: 100% hidden test success rate in 2 waves
    assert.equal(v.oma_dynamic_workflow.successRate, 1.0);
    assert.equal(v.oma_dynamic_workflow.meanWaves, 2.0);
    assert.ok(v.oma_dynamic_workflow.meanTokens > v.vanilla_agy.meanTokens);

    // Verify genuine timestamps and durations (no hardcoded zeroes or fake negative values)
    for (const res of rawResults) {
      assert.ok(Date.parse(res.timestamp) > 0);
      assert.ok(res.metrics.totalDurationMs >= 0);
      assert.ok(res.metrics.totalTokens > 0);
    }
  });
});
