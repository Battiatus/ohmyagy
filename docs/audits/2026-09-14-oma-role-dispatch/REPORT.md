# 2026-09-14 — dispatching a node to its expert

Layer 3 asks for roles that are actually dispatched to agents. `capability-resolver.ts` has
described six experts — role, model class, effort, tool set, read-only — since the beginning,
and nothing ever ran one from the IDE path.

## What was missing

Every execution entry point recorded an expert it had been *told* about:

```ts
expertId: targetNode.executor?.persona ?? targetNode.completionAuthority
```

The conductor did the work itself in its own process and wrote that expert id onto the
`run_started` event. So the roles were configuration, not agents: an `explorer` node could be
completed by the conductor with no explorer involved, and the journal would say an explorer
did it.

## `dispatch_node`

A new MCP tool (`src/mcp/dispatch-tools.ts`, 25 tools now) that takes a `nodeId`, resolves the
node's `executor.persona` through `CapabilityResolver`, and runs **that expert** as a real
AntiGravity process with its own model class, effort and sandbox. It records `run_started` and
`run_finished` under the expert that actually ran, with the same `runId`, and returns the
expert's answer plus the execution receipt.

Two deliberate boundaries:

- **Read-only experts only.** A dispatch runs in the live workspace with the expert's own
  tools. Handing a writer persona a shell there would route around the reviewed two-phase
  commit, so a writer node is refused with a message naming `propose_change`. Widening this is
  a decision about Layer 5 (working without a worktree), not an oversight.
- **The interview gate applies.** `dispatch_node` calls
  `assertInterviewAuthorisesExecution` exactly as `converge_step` does: no expert is woken
  before the user answered and confirmed.

It is the one tool that runs a process, so it takes the asynchronous path in the broker's
transport rather than the synchronous `handleRequest` table.

## A defect the real run exposed

`output` returned agy's **transport envelope** (`{"conversation_id":…,"status":"SUCCESS",
"response":"…"}`) instead of the expert's answer: the code took the first balanced JSON object
out of raw stdout, and the envelope is that object. `resolveAnswer` now prefers the driver's
unwrapped `parsedOutput`, and otherwise reads inside `response`. The unit test pins the real
envelope shape observed in production.

## Verified

`.oma/verify-dispatch-node.mjs` runs the whole chain for real — graph → interview gate →
capability resolution → process → run events → answer:

```
before the interview: Mission '…' has no recorded interview. …
status=dispatched succeeded=true durationMs=63823
expert={"expertId":"reviewer","model":"gemini-3.1-pro-high","effort":"high","sandbox":"read-only"}
output={"summary":"The workspace is readable…","evidence":[…],"confidence":"high"}
event run_started:  runId=dispatch-explore-scope-… expert=reviewer model=gemini-3.1-pro-high
event run_finished: runId=dispatch-explore-scope-… expert=reviewer status=succeeded
```

`src/mcp/__tests__/dispatch-tools.test.ts` proves the rest with an injected driver:
the assigned persona runs, with the class's model slug (verified against `agy models`), the
class's effort and the read-only sandbox; the run is recorded under that expert; a writer node
is refused; the interview gate blocks; the engine's synthetic seed is refused; a failed driver
run is recorded `failed` and not reported as a dispatch.

`npm test`: **421 pass, 5 skip, 0 fail**, exit 0.

## Attribution: a completion now needs a run behind it

`graph_mark_node(succeeded)` wrote its **own** `run_finished`, attributed to
`node.executor?.persona ?? node.completionAuthority` — an expert the caller had merely named.
So a completion could not be checked against anything: the transition supplied its own
evidence. Dispatching a node would have been optional, and the journal would still claim an
explorer did the work.

`src/mission/run-attribution.ts` reads the journal and requires, **before** the transition
writes anything, that a run was started for this work item and finished successfully — and
when the node names an executor, that the successful run was performed by that expert. A
failure may still be reported without a run; refusing to record a failure until something is
dispatched would be perverse.

Three tests pin it: a completion with no run is refused with the actionable message
(`… Dispatch the node to its expert with 'dispatch_node' first …`); a completion after a
dispatch is accepted; a successful run by a **different** expert is refused, naming both the
node's expert and the one that really ran.

Eight tests completed nodes directly and had to say what did the work. Two now go through
`dispatch_node`; the rest use a shared helper that records a started-and-finished run, because
their subject is the success contract, the projection or the event stream rather than dispatch
itself.

## Still open

- The isolation test was restructured while verifying this: one test proves the automatic
  drain *fires* (broker, roots), another proves isolation *holds* (the real drain and the real
  BrainStore, in-process, deterministic). Mixing the two made the isolation assertion depend
  on a fire-and-forget timing and fail under a full suite.
- `dispatch_node` runs read-only experts only. Letting it run writers is a decision about
  Layer 5 (working without a git worktree), not a gap to close quietly.
