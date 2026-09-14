# 2026-09-14 — the model table was rotten too

Layer 3 needs roles to be dispatched to real agents. Before that could even be attempted,
the thing every dispatch depends on turned out to be broken.

## What was there

`src/runtime/capability-resolver.ts` hardcoded one slug per model class:

```ts
fast:     "gemini-2.5-flash"
balanced: "gemini-3.7-flash"
frontier: "gemini-3.7-pro"
```

The installed AntiGravity 1.2.1 offers none of them. `agy models` lists:

```
gemini-3.8-flash-high / -medium / -low      gemini-3.7-flash-…      gemini-3.6-flash-…
gemini-3.1-pro-high / -low                  claude-sonnet-4-6       claude-opus-4-6-thinking
gpt-oss-120b-medium
```

Every slug carries a tier suffix, and the Pro line is `gemini-3.1-pro-*`, not `3.7-pro`.
So **every role dispatch resolved to a model the build rejects** — and the process-runner
defect documented in `docs/audits/2026-09-14-oma-agent-execution/` swallowed the resulting
error. Fixing the runner alone would have produced a plain "invalid model selection" on
every run.

And the tests **pinned the rot**: `phase1-moe-transport.test.ts` asserted
`assert.equal(plannerCap.modelSlug, "gemini-3.7-pro")`, so the suite stayed green while
nothing could run. That is the same shape as the `interview gate` regex and the
`phase5` accidental green: a test that certifies the broken state.

## What replaced it

`src/runtime/model-catalog.ts` resolves slugs from the **installed build**:
`agy models` is read once and cached, `OMA_MODEL_FAST|BALANCED|FRONTIER` override
explicitly, and the fallbacks are checked against the build by a test rather than trusted.
Selection is newest-version-then-requested-tier, so `fast` is the cheapest Flash,
`balanced` the medium tier, and `frontier` the Pro-high line with a Flash-high backstop.

`flash-summarizer` now shares the catalogue instead of carrying its own copy of the same
rot-prone logic.

## Two more defects found by running it

- **The watchdog raced agy's own timeout.** `buildCliArguments` derived `--print-timeout`
  from the same `timeoutMs` the ProcessRunner watchdog used, so both fired at the same
  instant: agy was killed exactly when it would have returned its own timeout as clean
  JSON. Measured: a dispatch killed at **180 651 ms** with empty stdout (the empty-string
  hash `e3b0c442…`). The watchdog now waits `WATCHDOG_GRACE_MS = 15 s` longer than agy's
  own budget, so agy always gets to report why it stopped.
- **The summarizer's budget was a coin flip.** A reformulation measured **21 s** while
  `DEFAULT_TIMEOUT_MS` was 25 s — it succeeded or failed depending on the machine. Raised
  to 90 s, which is honest about what a call that loads a large global context costs.

## Verified

- **All six vision roles resolve to slugs the installed build offers**, asserted against
  `agy models` — `src/runtime/__tests__/model-catalog.test.ts`. The three classes resolve to
  three distinct slugs, so the role model (fast explorer, frontier reviewer) means something.
- **A real role dispatch succeeds end to end**: `.oma/verify-role-dispatch.mjs verifier`
  resolved `verifier → gemini-3.1-pro-high`, effort `high`, sandbox `read-only`, exit 0 in
  31.5 s, with a receipt (`expertId`, model, effort, sandbox, duration, stdout hash).
- `npm test`: **413 pass, 5 skip, 0 fail**, exit 0.

## Still open

- Roles are **resolvable and dispatchable**, but the IDE path still does not dispatch them:
  the conductor does the work itself and records whatever `expertId` it likes on the node.
  A `dispatch_node` MCP tool that really spawns the node's assigned expert — and a
  `graph_mark_node(succeeded)` that refuses an unattributed completion — is the remaining
  half of Layer 3.
- Real dispatch latency measured at **31–85 s** per role, because agy loads a large global
  context per invocation. Any timeout in that path must be sized from that measurement.
