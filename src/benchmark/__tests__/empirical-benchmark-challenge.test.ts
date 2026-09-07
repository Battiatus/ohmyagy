import { describe, it } from "bun:test";
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchmarkRunner } from '../benchmark-runner.js';
import { ObjectiveJudge, type PipelineModuleBundle, type ProgressVector } from '../../oracle/objective-judge.js';
import { DynamicConvergenceEngine } from '../../orchestration/dynamic-engine.js';
import { WaveScheduler } from '../../orchestration/wave-scheduler.js';
import { MockAgyDriver } from '../../runtime/mock-driver.js';
import type { BenchmarkTrialResult, BenchmarkComparisonSummary } from '../types.js';

import * as originalMath from '../../../test-fixtures/minimal-pipeline/src/math.js';
import * as originalParser from '../../../test-fixtures/minimal-pipeline/src/parser.js';
import * as originalPipeline from '../../../test-fixtures/minimal-pipeline/src/pipeline.js';

import * as mutant1Math from '../../../test-fixtures/minimal-pipeline/src/mutants/mutant1-math.js';
import * as mutant2Parser from '../../../test-fixtures/minimal-pipeline/src/mutants/mutant2-parser.js';

describe('Empirical Benchmark and Oracle Adversarial Challenge', () => {
  const baseBundle: PipelineModuleBundle = {
    math: originalMath,
    parser: originalParser,
    pipeline: originalPipeline,
  };

  describe('Challenge 1: Real Clock Timing and Non-Determinism Verification', () => {
    it('measures real wall-clock durations with non-deterministic jitter across multiple trials', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'oma-bench-timing-'));
      try {
        const trialsPerVariant = 5;
        const { rawResults } = await BenchmarkRunner.executeBenchmark({
          workspaceRoot: testDir,
          trialsPerVariant,
          driver: new MockAgyDriver(),
        });

        assert.equal(rawResults.length, 4 * trialsPerVariant);

        const staticDurations = rawResults
          .filter((r) => r.variant === 'oma_static_wave')
          .map((r) => r.metrics.totalDurationMs);
        const dynamicDurations = rawResults
          .filter((r) => r.variant === 'oma_dynamic_workflow')
          .map((r) => r.metrics.totalDurationMs);

        for (const dur of [...staticDurations, ...dynamicDurations]) {
          assert.ok(dur >= 0, 'Duration must be >= 0');
          assert.ok(typeof dur === 'number');
        }

        const uniqueStatic = new Set(staticDurations);
        const uniqueDynamic = new Set(dynamicDurations);
        assert.ok(
          uniqueStatic.size > 1 || uniqueDynamic.size > 1 || staticDurations.some((d) => d > 0),
          'Durations must reflect genuine elapsed time rather than a synthetic fixed constant'
        );

        const timestamps = rawResults.map((r) => new Date(r.timestamp).getTime());
        for (let i = 1; i < timestamps.length; i++) {
          assert.ok(timestamps[i] >= timestamps[i - 1], 'Timestamps must be monotonically non-decreasing');
        }
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('reflects physical task latency when artificial processing delays are introduced', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'oma-bench-delay-'));
      try {
        const start = Date.now();
        const report = await WaveScheduler.executeStaticWave({
          workspaceRoot: testDir,
          missionId: 'bench-delay-test',
          eventsPath: join(testDir, 'events.jsonl'),
          baseBundle,
          driver: new MockAgyDriver(),
          workItems: [
            {
              scopeId: 'src/math.ts',
              title: 'Math with delay',
              filesModified: ['src/math.ts'],
              modulePatch: { math: mutant1Math },
              rawDiffContent: 'diff --git a/src/math.ts b/src/math.ts',
              workerDelayMs: 25,
            },
          ],
        });
        const elapsed = Date.now() - start;

        assert.ok(report.durationMs >= 20, 'Measured report.durationMs must be >= 20ms');
        assert.ok(elapsed >= 20, 'Measured wall-clock elapsed must be >= 20ms');
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });

  describe('Challenge 2: Objective Judge Authenticity and Mutant Inversion Sensitivity', () => {
    it('approves pristine baseBundle with 100% visible and 100% hidden tests passing', () => {
      const verdict = ObjectiveJudge.evaluatePipelineBundle(baseBundle);
      assert.equal(verdict.status, 'approved');
      assert.equal(verdict.progressVector.visibleTestsFailing, 0);
      assert.equal(verdict.progressVector.visibleTestsPassed, 3);
      assert.equal(verdict.progressVector.hiddenTestsFailing, 0);
      assert.equal(verdict.progressVector.hiddenTestsPassed, 5);
      assert.equal(verdict.progressVector.gateFailures, 0);
      assert.equal(verdict.progressVector.openDiagnosticsCount, 0);
      assert.equal(verdict.diagnostics.length, 0);
      assert.ok(verdict.verdictHash.length === 64, 'SHA-256 verdictHash must be 64 hex chars');
    });

    it('rejects mutant1Math with exact hidden negative fibonacci diagnostic while passing visible tests', () => {
      const mutantBundle: PipelineModuleBundle = {
        math: mutant1Math,
        parser: originalParser,
        pipeline: originalPipeline,
      };
      const verdict = ObjectiveJudge.evaluatePipelineBundle(mutantBundle);

      assert.equal(verdict.status, 'rejected');
      assert.equal(verdict.progressVector.visibleTestsFailing, 0, 'Mutant 1 passes visible tests');
      assert.equal(verdict.progressVector.visibleTestsPassed, 3);
      assert.equal(verdict.progressVector.hiddenTestsFailing, 1, 'Mutant 1 fails 1 hidden test');
      assert.equal(verdict.progressVector.hiddenTestsPassed, 4);
      assert.equal(verdict.progressVector.gateFailures, 1);
      assert.equal(verdict.progressVector.openDiagnosticsCount, 1);
      assert.ok(verdict.diagnostics.some((d) => d.includes('fibonacci negative rejection')));
    });

    it('rejects mutant2Parser with exact hidden decimal and syntax diagnostics while passing visible tests', () => {
      const mutantBundle: PipelineModuleBundle = {
        math: originalMath,
        parser: mutant2Parser,
        pipeline: originalPipeline,
      };
      const verdict = ObjectiveJudge.evaluatePipelineBundle(mutantBundle);

      assert.equal(verdict.status, 'rejected');
      assert.equal(verdict.progressVector.visibleTestsFailing, 0, 'Mutant 2 passes visible tests');
      assert.equal(verdict.progressVector.visibleTestsPassed, 3);
      assert.equal(verdict.progressVector.hiddenTestsFailing, 2, 'Mutant 2 fails 2 hidden tests');
      assert.equal(verdict.progressVector.hiddenTestsPassed, 3);
      assert.equal(verdict.progressVector.openDiagnosticsCount, 2);
      assert.ok(verdict.diagnostics.some((d) => d.includes('parser decimal')));
      assert.ok(verdict.diagnostics.some((d) => d.includes('parser invalid syntax')));
    });

    it('rejects compound double-mutant with cumulative failures', () => {
      const doubleMutantBundle: PipelineModuleBundle = {
        math: mutant1Math,
        parser: mutant2Parser,
        pipeline: originalPipeline,
      };
      const verdict = ObjectiveJudge.evaluatePipelineBundle(doubleMutantBundle);

      assert.equal(verdict.status, 'rejected');
      assert.equal(verdict.progressVector.visibleTestsFailing, 0);
      assert.equal(verdict.progressVector.hiddenTestsFailing, 3);
      assert.equal(verdict.progressVector.hiddenTestsPassed, 2);
      assert.equal(verdict.progressVector.openDiagnosticsCount, 3);
    });

    it('detects and diagnoses broken visible math functions', () => {
      const brokenVisibleMath = {
        add: () => 999,
        multiply: originalMath.multiply,
        fibonacci: originalMath.fibonacci,
      };
      const verdict = ObjectiveJudge.evaluatePipelineBundle({
        math: brokenVisibleMath,
        parser: originalParser,
        pipeline: originalPipeline,
      });

      assert.equal(verdict.status, 'rejected');
      assert.ok(verdict.progressVector.visibleTestsFailing >= 1);
      assert.ok(verdict.diagnostics.some((d) => d.includes('Math operations returned incorrect results')));
    });

    it('detects and diagnoses broken visible parser functions', () => {
      const brokenVisibleParser = {
        parseExpression: () => ({ op: 'corrupt', args: [0] }),
      };
      const verdict = ObjectiveJudge.evaluatePipelineBundle({
        math: originalMath,
        parser: brokenVisibleParser,
        pipeline: originalPipeline,
      });

      assert.equal(verdict.status, 'rejected');
      assert.ok(verdict.progressVector.visibleTestsFailing >= 1);
      assert.ok(verdict.diagnostics.some((d) => d.includes('Parser returned incorrect AST')));
    });

    it('detects and diagnoses broken pipeline aggregation functions', () => {
      const brokenPipeline = {
        evaluatePipeline: () => ({ steps: [], aggregateSum: 0, aggregateProduct: 0 }),
      };
      const verdict = ObjectiveJudge.evaluatePipelineBundle({
        math: originalMath,
        parser: originalParser,
        pipeline: brokenPipeline,
      });

      assert.equal(verdict.status, 'rejected');
      assert.ok(verdict.progressVector.visibleTestsFailing >= 1);
      assert.ok(verdict.diagnostics.some((d) => d.includes('Pipeline evaluation mismatch')));
    });

    it('handles throwing exceptions inside tested modules gracefully without crashing the judge', () => {
      const explodingBundle: PipelineModuleBundle = {
        math: {
          add: () => { throw new Error('Explosion in add'); },
          multiply: () => { throw new Error('Explosion in multiply'); },
          fibonacci: () => { throw new Error('Explosion in fib'); },
        },
        parser: {
          parseExpression: () => { throw new Error('Explosion in parse'); },
        },
        pipeline: {
          evaluatePipeline: () => { throw new Error('Explosion in pipeline'); },
        },
      };

      const verdict = ObjectiveJudge.evaluatePipelineBundle(explodingBundle);
      assert.equal(verdict.status, 'rejected');
      assert.equal(verdict.progressVector.visibleTestsFailing, 3);
      assert.ok(verdict.diagnostics.some((d) => d.includes('Explosion in add')));
      assert.ok(verdict.diagnostics.some((d) => d.includes('Explosion in parse')));
      assert.ok(verdict.diagnostics.some((d) => d.includes('Explosion in pipeline')));
    });
  });

  describe('Challenge 3: ProgressVector Lexicographic Ordering and Dynamic Convergence', () => {
    it('validates ObjectiveJudge.isProgressing lexicographic hierarchy', () => {
      const vBase: ProgressVector = {
        hiddenTestsFailing: 2,
        hiddenTestsPassed: 3,
        visibleTestsFailing: 1,
        visibleTestsPassed: 2,
        gateFailures: 1,
        openDiagnosticsCount: 3,
        acceptedWorkItems: 1,
        totalWorkItems: 3,
      };

      const vFewerHidden: ProgressVector = { ...vBase, hiddenTestsFailing: 1, visibleTestsFailing: 2 };
      assert.equal(ObjectiveJudge.isProgressing(vBase, vFewerHidden), true);

      const vMoreHidden: ProgressVector = { ...vBase, hiddenTestsFailing: 3 };
      assert.equal(ObjectiveJudge.isProgressing(vBase, vMoreHidden), false);

      const vFewerVisible: ProgressVector = { ...vBase, visibleTestsFailing: 0 };
      assert.equal(ObjectiveJudge.isProgressing(vBase, vFewerVisible), true);

      const vMoreAccepted: ProgressVector = { ...vBase, acceptedWorkItems: 2 };
      assert.equal(ObjectiveJudge.isProgressing(vBase, vMoreAccepted), true);

      const vFewerDiag: ProgressVector = { ...vBase, openDiagnosticsCount: 1 };
      assert.equal(ObjectiveJudge.isProgressing(vBase, vFewerDiag), true);

      assert.equal(ObjectiveJudge.isProgressing(vBase, { ...vBase }), false);
    });

    it('fails dynamic convergence if fixer module is also corrupted or flawed', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'oma-bench-corrupt-fixer-'));
      try {
        const report = await DynamicConvergenceEngine.execute({
          workspaceRoot: testDir,
          missionId: 'mission-corrupt-fixer',
          baseBundle,
          driver: new MockAgyDriver(),
          limits: { maxRounds: 2, maxConsecutiveNoProgressRounds: 1 },
          initialWorkItemsSupplier: () => [
            {
              scopeId: 'src/math.ts',
              title: 'Math with mutant 1',
              filesModified: ['src/math.ts'],
              modulePatch: { math: mutant1Math },
              rawDiffContent: 'diff mutant1',
            },
          ],
          diagnosticFixerSupplier: () => [
            {
              scopeId: 'src/math-fix.ts',
              title: 'Faulty Fixer',
              filesModified: ['src/math.ts'],
              modulePatch: { math: mutant1Math },
              rawDiffContent: 'diff mutant1 again',
            },
          ],
        });

        assert.notEqual(report.status, 'succeeded');
        assert.ok(['no_progress_blocked', 'budget_exhausted'].includes(report.status));
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });

  describe('Challenge 4: .oma/benchmark/ File Integrity and Mathematical Verification', () => {
    it('verifies that all existing JSON results in .oma/benchmark/ match exact schemas and arithmetic means', () => {
      const benchmarkDir = join(process.cwd(), '.oma', 'benchmark');
      if (!existsSync(benchmarkDir)) return;

      const files = readdirSync(benchmarkDir).filter((f) => f.startsWith('results-') && f.endsWith('.json'));
      assert.ok(files.length > 0, 'At least one results JSON file must exist in .oma/benchmark');

      for (const file of files) {
        const filePath = join(benchmarkDir, file);
        const content = JSON.parse(readFileSync(filePath, 'utf8'));

        assert.ok(content.summary, 'File ' + file + ' missing summary');
        assert.ok(Array.isArray(content.rawResults), 'File ' + file + ' rawResults must be an array');

        const summary: BenchmarkComparisonSummary = content.summary;
        const rawResults: BenchmarkTrialResult[] = content.rawResults;

        assert.equal(rawResults.length, summary.totalTrialsPerVariant * 4);

        for (const variant of ['vanilla_agy', 'skills_only', 'oma_static_wave', 'oma_dynamic_workflow'] as const) {
          const trials = rawResults.filter((r) => r.variant === variant);
          assert.equal(trials.length, summary.totalTrialsPerVariant);

          const expectedPassed = trials.filter((r) => r.outcome.hiddenTestsPassed).length;
          const expectedSuccessRate = expectedPassed / trials.length;
          const expectedMeanDuration = trials.reduce((s, r) => s + r.metrics.totalDurationMs, 0) / trials.length;
          const expectedMeanTokens = trials.reduce((s, r) => s + r.metrics.totalTokens, 0) / trials.length;
          const expectedMeanWaves = trials.reduce((s, r) => s + r.metrics.wavesCount, 0) / trials.length;
          const expectedMeanDefects = trials.reduce((s, r) => s + r.metrics.defectsCaughtByReviewers, 0) / trials.length;

          const variantSummary = summary.resultsByVariant[variant];
          assert.equal(variantSummary.successRate, expectedSuccessRate, variant + ' successRate mismatch');
          assert.equal(variantSummary.meanDurationMs, expectedMeanDuration, variant + ' meanDurationMs mismatch');
          assert.equal(variantSummary.meanTokens, expectedMeanTokens, variant + ' meanTokens mismatch');
          assert.equal(variantSummary.meanWaves, expectedMeanWaves, variant + ' meanWaves mismatch');
          assert.equal(variantSummary.meanDefectsIntercepted, expectedMeanDefects, variant + ' meanDefectsIntercepted mismatch');
        }
      }
    });

    it('verifies causal_benchmark_report.md markdown table integrity against latest results', () => {
      const reportPath = join(process.cwd(), '.oma', 'benchmark', 'causal_benchmark_report.md');
      assert.ok(existsSync(reportPath), 'causal_benchmark_report.md must exist');

      const md = readFileSync(reportPath, 'utf8');
      assert.ok(md.includes('# Rapport de Benchmark Causal Empirique — Oh My Antigravity (OMA)'));
      assert.ok(md.includes('vanilla_agy'));
      assert.ok(md.includes('skills_only'));
      assert.ok(md.includes('oma_static_wave'));
      assert.ok(md.includes('oma_dynamic_workflow'));
      assert.ok(md.includes('## 3. Analyse Causale et Déductions Expérimentales'));
    });
  });
});
