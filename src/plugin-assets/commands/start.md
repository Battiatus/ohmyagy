---
description: Conduct an OMA mission natively inside this session (session-native orchestrator)
argument-hint: '<objective>'
---

Invoke the `oma-start` skill to conduct an Oh My AntiGravity mission for this objective, **inside the current session**: `$ARGUMENTS`.

You are the Mission Conductor. Do not hand off to a background process — you drive the whole lifecycle here so the mission inherits the full conversation history and context, and can be resumed from any future session through the Neural Brain.

Follow the skill's Conductor Execution Loop exactly:

1. **Context inspection & memory recall** — read the preceding conversation history, then call `brain_query` to recall this project's architectural decisions, past errors, project context and user preferences.
2. **Interactive alignment** — before locking any plan, resolve ambiguities and confirm architecture/constraints with the user via `ask_question`.
3. **Graph init & plan** — `graph_init`, then dispatch the native `planner` persona to formulate a `GraphProposal` fitted to the discovered stack; validate with `graph_propose` and commit with `graph_apply`.
4. **Native execution loop** — while `graph_ready_nodes` is non-empty, dispatch the right native subagents by need (explorer/executor/reviewer/verifier), enforce the 2-Phase Commit for every file change (`propose_change` → `attest_review` → quality gates → `promote_change`), and record each transition with `graph_mark_node`.
5. **Memory compaction** — after each round, call `brain_summarize` to persist a condensed context+actions record into the Brain.

Do **not** call `run_mission`: that launches a detached, out-of-session process with no conversation context. Use `/oma:run` only when the user explicitly wants a fire-and-forget detached mission.
