# 2026-09-14 — the interview gate, as a contract

The requirement is unambiguous: **no run and no execution before the user has answered and
confirmed.** It was prose. This report records what was actually there and what replaced it.

## What was there

- `ask_question` **did not exist**. The name appeared in exactly one place in the whole
  codebase: the allow-list of `src/strict/policy.ts`. There was no tool, no record, no
  enforcement.
- The only "proof" of the gate was `src/orchestration/__tests__/session-conductor-skill.test.ts`,
  which asserted `assert.match(content, /interview gate/i)` against a Markdown file. It
  tested that a sentence was written down.
- A conductor could call `graph_init`, propose a plan, apply it and mark a node `running`
  without ever asking the user anything, and every one of those calls would succeed.

## What replaced it

`src/mission/interview-gate.ts` records the interview in the **mission journal** — durable
evidence, hash-chained with the rest of the mission — and every execution entry point
consults it:

- `record_interview` is a real MCP tool (`questions`, `answers`, `confirmed`). It refuses an
  interview with no question, and refuses one the user never answered: recording an
  unanswered question as "asked" is how a gate becomes a formality.
- `graph_mark_node` with `state: "running"` is the moment work actually starts, and it throws
  `no recorded interview` unless the user answered **and** confirmed.
- `converge_step` — the conductor's drive point — is gated the same way, so the loop cannot
  advance before the interview either.
- `confirmed: false` stores the answers and extends the block, so a user who answers but has
  not yet said "go" is represented, not silently promoted.

The gate is deliberately placed at the execution boundary, not at planning: `graph_init` and
`graph_propose` still work, because a plan is not a run.

## Verified

`src/mission/__tests__/interview-gate.test.ts` drives the real MCP tool surface:

- a mission that was never interviewed cannot converge (`isError: true`, `no recorded
  interview`);
- a mission whose interview was never confirmed is still refused ("asking is not
  confirmation");
- a node cannot be marked `running` before the interview;
- after `record_interview` with `confirmed: true`, the same dispatch and the same
  `converge_step` succeed;
- a two-step confirm — answers first, confirmation later — stays blocked in between.

`session-conductor-skill.test.ts` now asserts the skill names `record_interview`, so the
skill and the enforcement cannot drift apart again.

## Also fixed while verifying

- **The workspace registry raced.** `registerWorkspace` read-modify-wrote a single
  `~/.oma/workspaces.json`, so two brokers starting at once clobbered each other: the last
  writer won and the other project disappeared. That surfaced as a flaky isolation test (it
  failed twice in full-suite runs and passed in isolation). Each workspace now gets its own
  file under `~/.oma/workspaces/`, keyed by a digest of its root — no shared state, nothing
  to race over. Three consecutive runs of the isolation test are clean.
- **The suite was being run wrong.** `npx bun test` runs files concurrently; the repository's
  contract is `bun test --timeout=120000 --parallel=1 --isolate` (`npm test`). Several
  timing-sensitive tests flake under the former and are stable under the latter.
- **`node:sqlite` is not resolvable under `bun test --isolate`.** A test that imported
  `DatabaseSync` directly failed to load; it now goes through `src/brain/sqlite-adapter.ts`,
  which is the reason the Brain works under both runtimes.

## Result

`npm test`: **408 pass, 5 skip, 0 fail**, exit 0.
