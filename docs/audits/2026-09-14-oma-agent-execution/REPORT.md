# 2026-09-14 — every agent invocation was silently producing nothing

The vision depends on agents really executing: the six roles dispatched per need, and a
Flash mini-agent reformulating every exchange into memory. Neither has ever run. This
report records the measurement chain that proves it and the two defects behind it.

## The chain

1. **The reformulator returns `null`.** Running `createFlashReformulator` for real
   (`.oma/verify-reformulator.mjs`) produced no summary, and `AgyDriver.invoke` returned
   `status: failed`, `error: "Process returned exit code 0 but failed to provide valid
   JSON output: Empty stdout"`.

2. **The same argv does not behave that way outside the driver.** Asking agy directly
   with the driver's exact argument vector exits **1** and prints a JSON error; the
   driver's run exits **0** with empty stdout in **593 ms**. Reproduced side by side
   (`.oma/diagnose-runner-vs-spawn.mjs`):

   ```
   via OMA ProcessRunner : exitCode 0, stdout "", stderr "", durationMs 593
   via direct spawnSync  : exitCode 1, stdout "{...\"status\":\"ERROR\"...}"
   ```

3. **Why.** `ProcessRunner` assigned every Windows child to a Job Object configured with
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (0x2000). The job was created by a
   **fire-and-forget PowerShell process** (`spawn(...).unref()`) that exits immediately,
   which closes the last handle to the job, which makes Windows terminate the child.
   `maxMemoryMb` — the reason the mechanism existed — was **never used** (`_maxMemoryMb`),
   so the only effect was to kill the process. The child's death surfaces as exit code 0
   with no output, which `AgyDriver` reports as "exit code 0 but no JSON".

4. **Second, independent defect.** `flash-summarizer.ts` hardcoded
   `gemini-2.5-flash`. The installed build does not know that model:

   ```
   $ agy models
   gemini-3.8-flash-high   Gemini 3.8 Flash (High)
   gemini-3.8-flash-medium Gemini 3.8 Flash (Medium)
   gemini-3.8-flash-low    Gemini 3.8 Flash (Low)
   ... gemini-3.7/3.6 Flash, gemini-3.1-pro, claude-sonnet-4-6, gpt-oss-120b-medium
   ```

   The name had rotted, and because of defect 3 the error was swallowed.

## What this invalidated

Every path that goes through `AgyDriver` — the detached engine (`real-mission`,
`dynamic-engine`, `wave-scheduler`, `mission-resumption`), the oracle gates, the
benchmark runner and the Flash memory summarizer — was executing a process that was
killed within a second and reported as a success that produced nothing.

That is consistent with several observations that were previously treated as separate
problems: `oma start` producing no result, the detached engine's graph never converging,
and the mini-agent never reformulating anything. Nothing caught it because the only test
that drives the real binary is skipped, and the two phase tests that exercise the engine
were passing on instant child death.

## Fixes

- `src/runtime/process-runner.ts`: the Job Object assignment and its helper are removed.
  `maxMemoryMb` remains in the options for callers but is documented as **not enforced**.
- `src/brain/flash-summarizer.ts`: the model is resolved from `agy models` (cheapest
  Flash tier), with `OMA_FLASH_MODEL` as an explicit override and a verified slug as the
  last resort.
- `src/brain/summarizer.ts` + `src/brain/staging-drain.ts`: a `null` reformulation is now
  recorded as `"reformulator returned no summary"` and surfaces as a drain error, instead
  of looking like an ordinary raw capture.
- `src/__tests__/phase5-resumption.test.ts`: injects `MockAgyDriver`, because a test of
  resumption bookkeeping must not depend on a live model call. It went from ~21 s and
  intermittent failure to **160 ms and deterministic**.
- `src/benchmark/__tests__/empirical-benchmark-challenge.test.ts`: explicit 120 s budget
  for the wall-clock jitter test, whose default 5 s produced load-dependent flakes.

## Verified

- **The real driver test now passes.** `OMA_REAL_AGY=1 bun test
  src/runtime/__tests__/agy-driver.real.test.ts` succeeds in 23.7 s:
  `AgyDriver.invoke` drives the installed binary, returns the parsed structured JSON
  (`{"ok":true,"answer":42}`), and produces a receipt whose status, exit code, duration
  and hashes are asserted. It is opt-in by design (`OMA_REAL_AGY=1`) and had simply never
  been run — which is why the defect survived.
- The reformulator now returns a real summary (context, actions, and a memory entry
  classified `architectural_decision` with tags) in ~21 s.
- `src/runtime/__tests__/process-runner.capture.test.ts` pins both properties that were
  broken: a child's stdout, stderr and non-zero exit code survive, and a child that
  outlives the spawn call by two seconds is not killed.
- Full suite: **400 pass, 5 skip, 0 fail**.

## Still open

- The three suspended engine tests (phase4, phase6, benchmark) are still suspended for
  the same reason as before — the detached engine emits no graph edges — but that verdict
  is now worth re-examining from scratch, because those engine runs were never real:
  every model call inside them returned nothing.
- `phase5` was passing on instant child death. Other tests in the same position may exist:
  any test whose subject is engine behaviour rather than bookkeeping should be audited for
  the same accidental dependency.
