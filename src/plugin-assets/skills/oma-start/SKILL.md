---
name: oma-start
description: Start a verified OMA mission from a natural-language objective with late-init context cascade, blocking interview gate, and dynamic convergence
---

# OMA Session-Native Mission Conductor

`oma-start` is the primary entrypoint to execute an Oh My AntiGravity (OMA) mission directly within the active interactive session (Session-Native Orchestrator).

When invoked with an objective, you serve as the **Mission Conductor**. You drive the complete lifecycle iteratively using the MCP tools exposed by the `oma-broker` MCP server and project-scoped persistent memory in the Neural Brain (`brain_*`), delegating bounded subtasks to the 6 canonical specialist roles (`planner`, `explorer`, `executor`, `reviewer`, `verifier`, `orchestrator`).

---

## 1. Conductor Execution Loop (Nominal Session-Native Flow)

### Step 1: Late-Init Context Ingestion Cascade (3 Levels)
When invoked (at initial launch or mid-conversation / late-init), the Conductor systematically ingests context across three hierarchical levels:

1. **Level 1 — Primary / Nominal: Active Session Working Memory**
   - **Mechanism**: Native LLM conversation memory. Zero disk I/O required.
   - **Scope**: Inspect the full conversation history: user intent, objectives, implicit preferences, files inspected or modified, and established agreements.
   - This active conversational memory is the highest-fidelity source for the current session.

2. **Level 2 — Cross-Session & Cold Start: Persistent Facts & Graph State (SQLite & Ledger)**
   - **Mechanism**: MCP queries to the Neural Brain and Graph Ledger.
   - **Recall Brain Memories**: Query durable architectural decisions, past errors, project context, and user preferences:
     ```json
     {
       "tool": "brain_query",
       "arguments": {
         "dimensions": ["architectural_decision", "past_error", "project_context", "user_preference"]
       }
     }
     ```
   - **Inspect Graph & Convergence Baseline**: Query active graph state and convergence metrics:
     ```json
     {
       "tool": "converge_status",
       "arguments": {}
     }
     ```
     *(Or `graph_inspect` to review existing DAG nodes and completed work items).*

3. **Level 3 — Optional Secondary: Session Transcript File (Graceful Fallback)**
   - **Mechanism**: Inspect disk for runtime transcript exports (e.g. `~/.gemini/antigravity/brain/<session_id>/.system_generated/logs/transcript.jsonl`, `.oma/transcript.jsonl`, or workspace `transcript.jsonl`) **if** supported by the execution runtime.
   - **Graceful Fallback**: If no transcript file is accessible or if the host runtime does not produce transcript files, **omit gracefully without error or blocking**. Level 1 (native conversational memory) and Level 2 (SQLite Brain & Ledger) provide complete context.

---

### Step 2: Mandatory Blocking Surgical Interview Gate
Before ANY execution, graph initialization, or file mutation, the Conductor MUST execute a strict, blocking alignment interview.

**The interview sequence is strictly enforced:**
1. **Synthesize & Summarize (2-3 sentences)**:
   Summarize in exactly 2 to 3 concise, high-density sentences what was understood from the discussion history and the project state (Level 1 + Level 2 context). Articulate the core objective and current technical baseline.
2. **Targeted Questions on Real Frictions (2-3 questions ONLY)**:
   Do NOT ask generic or redundant questions. Ask **only 2 to 3 targeted questions** strictly focused on real friction points:
   - **Measurable Goals & Acceptance Criteria**: What test suite, command, benchmark, or empirical behavior mathematically proves completion?
   - **Technical Constraints & Scope Boundaries**: Specific files forbidden to touch, performance budgets, or backwards-compatibility constraints.
   - **Architectural & Design Choices**: When multiple implementation paths exist, present the trade-off and ask for direction.
   - **Required Mission Mode**: Confirm the operational mode (`bugfix`, `feature`, `diagnostic`, `infra`, `pm` / `review`, `refactor`).
3. **MANDATORY BLOCKING GATE — Zero Run Before Confirmation**:
   **STRICT ENFORCEMENT: ZERO RUN / ZERO EXECUTION BEFORE EXPLICIT USER ANSWERS AND CONFIRMATION.**
   The conductor MUST NOT call `graph_init`, MUST NOT mutate files, MUST NOT stage changes, and MUST NOT dispatch workers until the user has provided explicit answers and confirmed the proposed direction. Execution is blocked at this gate. Present the summary and questions directly to the user (via interactive modal `ask_question` or explicit conversational prompt) and halt execution to await user response.

---

### Step 3: Mode Selection & Canonical Role Routing (`plan_route`)
Once the user validates the interview and confirms the mission mode:
1. Invoke the MCP routing tool `plan_route`:
   ```json
   {
     "tool": "plan_route",
     "arguments": {
       "mode": "<mode>"
     }
   }
   ```
   *(Modes: `bugfix`, `feature`, `diagnostic`, `infra`, `pm`; aliases like `debug`, `fix`, `refactor`, `review`, `exploration` are normalized automatically).*
2. The tool responds with:
   - `roles`: Canonical role subset strictly authorized for this mode:
     - `bugfix` / `debug`: `["planner", "executor", "verifier"]` (fast, focused patch cycle)
     - `feature` / `refactor`: `["planner", "explorer", "executor", "reviewer", "verifier"]` (full lifecycle)
     - `diagnostic` / `review`: `["explorer", "reviewer"]` (read-only root cause and audits)
     - `infra`: `["planner", "executor", "verifier"]` (scripts, dependencies, environmental configuration)
     - `pm`: `["planner", "orchestrator"]` (planning, scoping, work breakdown)
   - `modeConfig`: Operational constraints and configuration overlays:
     - `sandbox`: Confinement level (`workspace-write` or `read-only`)
     - `promptOverlay`: Specific domain instructions injected into agent prompts
     - `extraGates`: Mandatory automated validation gates (e.g. test programs)
3. Constrain all subsequent planning and dispatching strictly to the selected `roles` and apply `modeConfig` overlays.

---

### Step 4: Graph Initialization & Plan Formulation
1. **Initialize Execution DAG**:
   ```json
   {
     "tool": "graph_init",
     "arguments": {
       "goal": "<validated objective from interview>"
     }
   }
   ```
   This creates `.oma/graph/` (execution DAG, event journal, CAS store) and returns `missionId` and `graphId`.
2. **Dispatch Planner Persona**:
   Dispatch the native `planner` persona constrained by `roles` and `modeConfig` to construct an atomic `GraphProposal` comprising nodes (`id`, `role`, `title`, `scope`, `dependencies`).
3. **Validate & Apply Proposal**:
   - Validate acyclicity and topological invariants:
     ```json
     {
       "tool": "graph_propose",
       "arguments": {
         "proposal": { ... }
       }
     }
     ```
   - Commit the proposal to the canonical graph:
     ```json
     {
       "tool": "graph_apply",
       "arguments": {
         "proposal": { ... }
       }
     }
     ```

---

### Step 5: Session-Native Execution Loop driven by `converge_step` & `graph_replan`
The Conductor drives execution iteratively using `converge_step`:

1. **Evaluate Convergence Step**:
   At the start of each wave/round, evaluate progress and fetch executable nodes:
   ```json
   {
     "tool": "converge_step",
     "arguments": {
       "currentRound": <wave_number>,
       "currentProgress": {
         "visibleTestsPassed": <count>,
         "visibleTestsFailing": <count>,
         "acceptedWorkItems": <count>,
         "totalWorkItems": <count>
       }
     }
   }
   ```
   Inspect the returned `status`:
   - **`"succeeded"` / `"converged"`**: All DAG nodes completed, all quality gates green. Proceed to Step 6 (Memory Compaction & Completion).
   - **`"no_progress_blocked"`**: **HALT IMMEDIATELY.** Two consecutive rounds without ProgressVector improvement detected. Do not retry blindly. Halt execution and output a structured diagnosis detailing stagnated items, failed gates, and root cause.
   - **`"budget_exhausted"`**: **HALT.** Maximum round limit or timeout reached. Report status and await user direction.
   - **`"failed"`**: **HALT.** Terminal graph failure detected with no ready or running nodes and unresolvable gate failures. Report failure diagnosis and await user direction.
   - **`"in_progress"`**: Retrieve `readyNodes` and proceed with dispatch.

2. **Dispatch Ready Nodes to Canonical Roles**:
   For each ready node:
   - Mark node running:
     ```json
     {
       "tool": "graph_mark_node",
       "arguments": {
         "nodeId": "<nodeId>",
         "state": "running"
       }
     }
     ```
   - Dispatch specialist according to node's assigned role (must belong to `rolesForMode`):
     - `explorer`: Codebase inspection, fact-finding, root-cause investigation (read-only).
     - `executor`: Implementation and file modification within declared `scope`.
     - `reviewer`: Adversarial review of diffs against standards and spec.
     - `verifier`: Quality oracle executing automated test gates and regression checks.

3. **Enforce Strict 2-Phase Commit (2PC) Lifecycle for File Modifications**:
   Every file mutation MUST follow the 2PC protocol:
   - **Stage changes (`propose_change`)**:
     Stage changes in an isolated workspace worktree:
     ```json
     {
       "tool": "propose_change",
       "arguments": {
         "parentVersion": "HEAD",
         "operations": [
           {
             "type": "modify",
             "path": "<relative_path>",
             "content": "<new_content>"
           }
         ]
       }
     }
     ```
   - **Independent review (`attest_review`)**:
     Independent `reviewer` role inspects staged diff and issues attestation:
     ```json
     {
       "tool": "attest_review",
       "arguments": {
         "transactionId": "<transactionId>",
         "stagedDiffDigest": "<stagedDiffDigest>",
         "reviewerRunKey": "<reviewer_run_key>",
         "reviewerExpertId": "reviewer",
         "verdict": "approved"
       }
     }
     ```
   - **Automated test gates**: Run test program and evaluate `modeConfig.extraGates`.
   - **Promote changes (`promote_change`)**:
     Fast-forward CAS commit to HEAD only upon approved review and passing gates:
     ```json
     {
       "tool": "promote_change",
       "arguments": {
         "transactionId": "<transactionId>",
         "stagedDiffDigest": "<stagedDiffDigest>"
       }
     }
     ```
   - Never bypass 2PC with direct unverified workspace edits.

4. **Mark Node Completion & Handle Failures with Dynamic Replanning**:
   - **On Success**:
     Record completion with evidence hash:
     ```json
     {
       "tool": "graph_mark_node",
       "arguments": {
         "nodeId": "<nodeId>",
         "state": "succeeded",
         "evidenceHash": "<sha256>"
       }
     }
     ```
   - **On Verifier / Gate Failure**:
     - Mark node failed:
       ```json
       {
         "tool": "graph_mark_node",
         "arguments": {
           "nodeId": "<nodeId>",
           "state": "failed"
         }
       }
       ```
     - **Dynamic Replanning via `graph_replan`**:
       Invoke `graph_replan` to insert a targeted diagnostic or repair node:
       ```json
       {
         "tool": "graph_replan",
         "arguments": {
           "failedNodeId": "<nodeId>",
           "failureReason": "<error diagnostic from verifier or gate>",
           "role": "explorer",
           "title": "Investigate failure in <nodeId>",
           "scope": ["<affected_files>"]
         }
       }
       ```
       *(Use `role: "explorer"` for root-cause analysis, or `role: "executor"` for targeted surgical repair).*
       `graph_replan` creates a Kahn-validated DAG proposal linking the failure edge, allowing the execution loop to resolve the defect cleanly in subsequent waves.
     - Increment round index and call `converge_step` to evaluate the replanned ready nodes.

---

### Step 6: Memory Compaction & Continuous Synthesis
After each wave or upon mission completion:
1. Record condensed interaction summary into the Neural Brain:
   ```json
   {
     "tool": "brain_summarize",
     "arguments": {
       "userIntent": "<intent>",
       "actionsTaken": "<actions>",
       "outcome": "<outcome>",
       "content": "<condensed context and actions summary>"
     }
   }
   ```
2. Store persistent architectural decisions, errors, or preferences using `brain_store`.
3. Present terminal mission report to user with modified files, test proofs, and gate verdicts.

---

## 2. Legacy Detached Mode (Compatibility Fallback)

If explicitly requested by the user or when running in environments where detached background execution is required:
1. Call `run_mission` with `{"goal": "$ARGUMENTS"}`.
2. Report the mission id and the watch command: `oma watch --mission <mission-id>`.
