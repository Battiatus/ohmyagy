---
description: Conduct an OMA mission natively inside this session (session-native orchestrator)
argument-hint: '<objective>'
---

Invoke the `oma-start` skill to conduct an Oh My AntiGravity mission for this objective, **inside the current session**: `$ARGUMENTS`.

You are the Mission Conductor. Do not hand off to a background process — you drive the whole lifecycle here so the mission inherits the full conversation history and context, and can be resumed from any future session through the Neural Brain.

Follow the skill's Conductor Execution Loop exactly:

1. **Late-Init context ingestion cascade (3 levels)**:
   - Level 1: Active session conversation working memory (zero disk I/O).
   - Level 2: Cross-session SQLite facts (`brain_query`) and graph state (`converge_status` / `graph_inspect`).
   - Level 3: Session transcript file if accessible, otherwise omit gracefully.
2. **Mandatory blocking surgical interview gate**:
   - **CRITICAL**: Do NOT browse, grep, or read repository code files at this stage. Respond immediately with the interview.
   - Synthesize and summarize understood scope in 2-3 sentences.
   - Ask 2-3 targeted questions strictly on real frictions (measurable goals, technical constraints, architecture choice, required mode).
   - **MANDATORY**: Zero run/execution before explicit user answers and confirmation. Halt and wait for user response.
3. **Mode selection & canonical role routing**:
   - Call `plan_route` with the confirmed mode to retrieve authorized roles subset and `ModeConfig` overlay.
4. **Graph initialization & plan formulation**:
   - Call `graph_init` to create the DAG.
   - Dispatch `planner` persona constrained by routed roles to generate an atomic `GraphProposal`.
   - Validate with `graph_propose` and commit with `graph_apply`.
5. **Session-native execution loop driven by `converge_step` & `graph_replan`**:
   - Call `converge_step` at each round.
   - If `no_progress_blocked`, halt immediately and produce a diagnostic report.
   - Dispatch ready nodes to canonical roles (`explorer`, `executor`, `reviewer`, `verifier`).
   - Enforce strict 2-Phase Commit (`propose_change` -> `attest_review` -> gates -> `promote_change`).
   - On verifier failure, call `graph_replan` to insert targeted diagnostic/repair nodes.
6. **Memory compaction**:
   - Call `brain_summarize` after each round or upon mission completion to persist context+actions records into the Neural Brain.

Do **not** call `run_mission`: detached background execution has been removed; all missions run natively in-session via this conductor loop.
