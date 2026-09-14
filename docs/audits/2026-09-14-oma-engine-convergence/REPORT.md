# 2026-09-14 — the detached engine could never converge

Layer 4 asks for one orchestrator instead of two. Un-suspending Gate 4.1 produced a concrete
failure, and diagnosing it replaced a speculative comment with a measured cause — plus one
defect that is now fixed.

## The measurement

Gate 4.1 was suspended with this reason, written from reading code: *"the engine also emits no
graph edges, so a repaired wave-1 failure remains a failed sink and its graph can never reach
`succeeded`"*. Running it says something more specific:

```
status: "budget_exhausted"
totalWaves: 3
finalProgress: { hiddenTestsFailing: 0, hiddenTestsPassed: 5,
                 visibleTestsFailing: 0, visibleTestsPassed: 3,
                 gateFailures: 0, openDiagnosticsCount: 0,
                 acceptedWorkItems: 1, totalWorkItems: 1 }
```

The engine **reaches green** — every gate passes, the single work item is accepted — and still
reports budget exhaustion after three waves.

## Cause 1, fixed: the engine wrote an invalid graph and swallowed the error

`DynamicConvergenceEngine` hand-wrote its revision-1 graph:

```ts
const initialGraph = { schemaVersion: 1, graphId, revision: 1, nodes: [], edges: [] };
```

`parseExecutionGraph` rejects that twice over: `schedulerAuthorityId` is required, and a graph
with an **empty `nodes` array** is refused. The rejection was then swallowed:

```ts
} catch {
  try { graphRuntime = loadGraphRuntime(workspaceRoot); } catch {}
}
```

so `graphRuntime` stayed `undefined` and the engine passed an empty fallback graph to
`evaluateConvergenceStep` — which can never report `succeeded`, because a graph with no node has
no delivered work.

`src/graph/bootstrap.ts` now holds the canonical builder, used by **both** orchestrators
(`graph_init` and the engine), so the shape cannot drift again. The engine also throws instead
of continuing without a graph: running a mission that cannot possibly be declared successful is
worse than refusing to start.

After the fix the graph loads (`nodes: [bootstrap]`, `projection status: ready`) and the parse
error is gone.

## Cause 2, remaining: work items never become graph nodes

The engine registers each materialized work item as a mission event, then:

```ts
if (graphRuntime) {
  try {
    appendGraphTransition(graphRuntime, { eventType: "node_dispatched", nodeId: workItemId, … });
  } catch {}
}
```

The node was never added to the graph, so the transition refers to a node the graph does not
have — and the `catch {}` hides it. The graph only ever holds the synthetic seed, so
`deliverableNodes` is 0 and the success contract correctly refuses to declare victory. The test
stays suspended for that reason, not for the old speculative one.

## Also verified

- `npm test`: **424 pass, 5 skip, 0 fail**, exit 0.
- Gate 4.1 is suspended again, with the measured evidence and both causes written into the
  test so the next reader starts from facts.
