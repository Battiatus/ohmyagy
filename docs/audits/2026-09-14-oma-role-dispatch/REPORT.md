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

## Still open

- **An unattributed completion is still accepted.** `graph_mark_node(succeeded)` does not
  require a matching `run_finished` for the node, so a conductor can complete a node without
  dispatching anything. Making that a refusal is the other half of Layer 3, and it needs the
  five tests that mark nodes succeeded directly to be migrated onto dispatch first — which is
  why it is not bundled here.
- The isolation test was restructured while verifying this: one test proves the automatic
  drain *fires* (broker, roots), another proves isolation *holds* (the real drain and the real
  BrainStore, in-process, deterministic). Mixing the two made the isolation assertion depend
  on a fire-and-forget timing and fail under a full suite.
