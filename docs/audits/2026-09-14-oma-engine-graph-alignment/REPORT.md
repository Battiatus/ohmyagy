# 2026-09-14 — one orchestrator: the engine writes a real graph

Supersedes the "still open" section of `2026-09-14-oma-engine-convergence/`, which named the
remaining defect. All three suspended tests are now re-enabled and green.

## What was wrong

The detached engine treated the execution graph as a decoration:

1. It hand-wrote its revision-1 graph as `{schemaVersion, graphId, revision, nodes: [], edges: []}`.
   `parseExecutionGraph` rejects that twice — `schedulerAuthorityId` is required, and an empty
   `nodes` array is refused — and a `catch {}` swallowed the parse error, so the engine ran
   against an empty fallback graph.
2. It emitted `node_dispatched` and `node_completed` for work items it had **never added** to
   the graph, again inside `try {} catch {}`. Every rejection was discarded.
3. Its own synthetic seed stayed `ready` forever, which kept the projection out of a terminal
   state even when every real node had succeeded.

The measured symptom: green progress (0 failing tests, 0 gate failures, 1/1 work items
accepted) reported as `budget_exhausted`.

## What replaced it

- **One builder.** `src/graph/bootstrap.ts` holds the canonical revision-1 graph, used by both
  `graph_init` and the engine, so the shape cannot drift again. The engine throws rather than
  continuing without a graph.
- **Materialization.** `src/graph/materialize.ts` adds each wave's work items as graph nodes
  through the same `GraphBroker` proposal path as `graph_replan` — same CAS, acyclicity and
  hash-chain checks as any other writer. A rejected proposal throws.
- **Repair edges.** A repair wave declares `dependsOn` the nodes that failed the previous wave,
  with `when: "failure"`, so the graph says why the new work exists instead of listing isolated
  roots.
- **Repeated runs.** Node ids are deterministic and a benchmark runs several variants over
  shared fixtures, so a second run meets nodes the first one completed. Transitions are emitted
  only when the projected state allows them (`ready` to dispatch, `running` to complete), which
  is why the benchmark's second and later runs no longer produce rejected transitions.
- **No silent bookkeeping.** `recordEngineProblem` reports a transition that cannot be
  recorded; that is precisely what used to go unnoticed.

## Verified

`npm test`: **427 pass, 2 skip, 0 fail**, exit 0. The two remaining skips are the opt-in real
binary tests (`OMA_REAL_AGY=1`), not suspended work.

Re-enabled and green:

- **Gate 4.1 & 4.2** — red gate in wave 1 triggers wave 2, which converges green.
- **Gate 6.1–6.3** — paired and repeated benchmark across four frozen variants produces causal
  conclusions.
- **BenchmarkRunner** — multi-trial benchmark across all four variants with genuine metrics.

Measured on the phase-4 scenario (`.oma/diagnose-phase4.mjs`): the graph now holds
`bootstrap` (synthetic, succeeded), `work-src-math-ts-w1` and `work-src-math-fix-ts-w2`, both
deliverable and succeeded, and `projection status: succeeded` at wave 2 with an integrated
commit.

## Known gap, stated rather than papered over

The repair edge is wired to **worker-level** failures. In the phase-4 scenario the wave-1 worker
succeeds and the *gate* fails, so `previousWaveFailures` is empty and no edge is created — the
measured graph has `edges: 0`. The mission still converges (the repair node is a root and
delivers), but the graph does not yet express "wave 2 repairs wave 1's gate failure". Deriving
failed nodes from the judge's per-item outcome instead of from worker status is the next step.
