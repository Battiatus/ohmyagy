import assert from "node:assert/strict";
import { test } from "bun:test";
import { ProcessRunner } from "../process-runner.js";

/**
 * Regression guard for the worst defect found so far.
 *
 * `ProcessRunner` used to assign every Windows child to a Job Object created with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, from a fire-and-forget PowerShell process that
 * exited immediately. Closing the last job handle terminated the child a few hundred
 * milliseconds after spawn, so the runner reported `exitCode: 0` with empty stdout and
 * empty stderr. Measured 2026-09-14: the same argv that exits 1 with a JSON error under
 * `spawnSync` returned exit 0 with no output through the runner.
 *
 * Every `AgyDriver.invoke` goes through this runner — the detached engine, the oracle
 * gates, the benchmarks and the Flash memory summarizer — so the whole agent-execution
 * layer was silently producing nothing. No test caught it because the only test that
 * drives the real binary is skipped.
 */

test("returns a child's stdout, stderr and exit code unchanged", { timeout: 60_000 }, async () => {
  const result = await ProcessRunner.execute({
    executable: process.execPath,
    args: [
      "-e",
      'process.stdout.write("captured-out"); process.stderr.write("captured-err"); process.exit(3);',
    ],
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  assert.equal(result.stdout, "captured-out");
  assert.equal(result.stderr, "captured-err");
  assert.equal(result.exitCode, 3, "a non-zero exit code must survive the runner");
  assert.equal(result.timedOut, false);
});

test("does not kill a child that outlives the spawn call", { timeout: 60_000 }, async () => {
  // The job-object defect ended the child within roughly 600 ms. A child that works for
  // longer than that, and whose output arrives late, is the reproduction.
  const result = await ProcessRunner.execute({
    executable: process.execPath,
    args: ["-e", 'setTimeout(() => { process.stdout.write("late-output"); process.exit(0); }, 2000);'],
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });

  assert.equal(result.stdout, "late-output");
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});
