import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { AgyDriver } from "../agy-driver.js";

/**
 * Real end-to-end invocation of the installed AntiGravity CLI (agy.exe).
 *
 * These tests spend real tokens and take ~1-2 minutes per call, so they are
 * opt-in. Enable them explicitly:
 *
 *   OMA_REAL_AGY=1 bun test src/runtime/__tests__/agy-driver.real.test.ts
 *
 * They are skipped by default (CI, sandbox, the normal `npm test` run) so the
 * deterministic suite stays fast and free of external dependencies.
 */
const REAL_AGY_ENABLED = process.env.OMA_REAL_AGY === "1";
const REAL_AGY_TIMEOUT_MS = 240_000;

test.skipIf(!REAL_AGY_ENABLED)(
  "AgyDriver.invoke drives the real agy binary and returns parsed structured JSON",
  async () => {
    const workdir = mkdtempSync(join(tmpdir(), "oma-real-agy-"));
    try {
      const driver = new AgyDriver();
      const result = await driver.invoke({
        contractPrompt:
          'Reply with a single JSON object exactly equal to {"ok":true,"answer":42}. Output only that JSON, nothing else.',
        persona: "worker",
        worktreeDir: workdir,
        timeoutMs: 180_000,
        runId: "real-agy-smoke",
        bare: true,
      });

      assert.equal(result.status, "success", `agy driver did not succeed: ${result.error ?? ""}`);
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);

      // unwrapAgyResponse peels the agy envelope's `response` field into the model's JSON.
      assert.deepEqual(result.parsedOutput, { ok: true, answer: 42 });

      // A real, non-empty, verifiable execution receipt was produced.
      assert.equal(result.receipt.runId, "real-agy-smoke");
      assert.equal(result.receipt.status, "success");
      assert.equal(result.receipt.exitCode, 0);
      assert.ok(result.durationMs > 0, "a real invocation must record a positive duration");
      assert.match(result.stdoutHash, /^[0-9a-f]{64}$/u);
      assert.match(result.receipt.receiptHash, /^[0-9a-f]{64}$/u);
    } finally {
      // Best-effort cleanup: agy can keep a transient lock on the workdir on
      // Windows (EBUSY), which must not fail an otherwise-passing real run.
      try {
        rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Leave the temp dir for the OS to reap; the assertions already passed.
      }
    }
  },
  REAL_AGY_TIMEOUT_MS,
);
