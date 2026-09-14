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

## The repair edge, and what it exposed

A repair wave declares `dependsOn` the nodes that failed the previous one, with
`when: "failure"`. Attaching that edge immediately showed the graph was lying: the repair node
projected as **`skipped`**, because the wave-1 node had been completed as `succeeded` from the
**worker's** status even though its gate rejected the result. With the graph believing wave 1
passed, a failure edge could never activate the repair — while the repair's own patch was the
thing that fixed the code.

The completion is now recorded **after the gate**, for the whole wave at once, with the outcome
the gate decided. Measured on the phase-4 scenario:

```
graph nodes: bootstrap(synthetic, succeeded)  work-…-w1(failed)  work-…-fix-w2(succeeded)
graph edges: 1                      projection status: succeeded
```

Wave 1 failed its gate, the repair depends on that failure, and the repair is the node that
delivered. The graph now says why the second wave exists.

## Verified

`npm test`: **427 pass, 2 skip, 0 fail**, exit 0. The two remaining skips are the opt-in real
binary tests (`OMA_REAL_AGY=1`), not suspended work.

Re-enabled and green:

- **Gate 4.1 & 4.2** — red gate in wave 1 triggers wave 2, which converges green.
- **Gate 6.1–6.3** — paired and repeated benchmark across four frozen variants produces causal
  conclusions.
- **BenchmarkRunner** — multi-trial benchmark across all four variants with genuine metrics.
