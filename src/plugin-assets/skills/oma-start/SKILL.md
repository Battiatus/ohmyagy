---
name: oma-start
description: Start a verified OMA mission from a natural-language objective
---

# OMA Session-Native Mission Conductor

`oma-start` is the primary entrypoint to execute an Oh My AntiGravity (OMA) mission directly within the active interactive session.

When invoked with an objective, you serve as the **Mission Conductor**. You drive the complete lifecycle iteratively using the MCP tools exposed by the `oma-broker` MCP server and project-scoped persistent memory in the Neural Brain (`brain_*`), delegating bounded subtasks to native specialist roles (`planner`, `explorer`, `executor`, `reviewer`, `verifier`).

---

## 1. Conductor Execution Loop (Nominal Session-Native Flow)

### Step 1: Context Inspection & Memory Recall
1. Read the preceding conversation history to extract full context, user intent, explicit constraints, and discovered files.
2. Query the Neural Brain for existing project memories and past learnings:
   ```json
   {
     "tool": "brain_query",
     "arguments": {
       "dimensions": ["architectural_decision", "past_error", "project_context", "user_preference"]
     }
   }
   ```
3. Synthesize the recalled memories with the objective to prevent repeating past mistakes or contradicting established decisions.

### Step 2: Interactive Alignment
If the objective contains ambiguities, conflicting requirements, or critical architectural choices:
1. Clarify immediately with the user using `ask_question`.
2. Do not proceed with ungrounded assumptions on breaking API designs or destructive operations.

### Step 3: Graph Initialization
Initialize the canonical DAG execution graph for the mission:
```json
{
  "tool": "graph_init",
  "arguments": {
    "goal": "$ARGUMENTS"
  }
}
```
This sets up `.oma/graph/` (the execution graph store, event journal, and head state) and returns `missionId` and `graphId`.

### Step 4: Plan Formulation & Graph Proposal
1. Dispatch the native `planner` persona to inspect the repository stack and formulate an atomic DAG proposal (`GraphProposal`).
2. Validate the proposed DAG extension:
   ```json
   {
     "tool": "graph_propose",
     "arguments": {
       "proposal": { ... }
     }
   }
   ```
   Verify that Kahn acyclicity checks pass and no cycles, duplicate nodes, or scope collisions exist.
3. Apply the validated revision to the canonical graph:
   ```json
   {
     "tool": "graph_apply",
     "arguments": {
       "proposal": { ... }
     }
   }
   ```

### Step 5: Native Execution Loop
Loop continuously while executable nodes remain:
1. **Fetch Ready Nodes**:
   ```json
   {
     "tool": "graph_ready_nodes",
     "arguments": {}
   }
   ```
   If `readySet` is empty, check `graph_inspect` to verify whether the DAG has completed successfully (`graphStatus: "succeeded"`) or stalled.

2. **Dispatch & Execute Node**:
   For each ready node:
   - Mark the node as running:
     ```json
     {
       "tool": "graph_mark_node",
       "arguments": {
         "nodeId": "<nodeId>",
         "state": "running"
       }
     }
     ```
   - Dispatch the appropriate specialist subagent:
     - Exploration / Context: `explorer` for codebase mapping and fact-finding.
     - Implementation: `executor` (or worker) within its declared `scope`.
     - Code review: `reviewer` (adversarial reviewer) evaluating standards and correctness.
     - Quality verification: `verifier` (quality oracle) verifying test gates.

3. **Enforce 2-Phase Commit (2PC) Lifecycle for File Modifications**:
   Every code change must adhere to the strict 2PC sequence:
   - `propose_change`: Stage the file modification operations in an isolated staging worktree.
   - `attest_review`: Independent review verdict (approved/rejected).
   - Quality gates evaluation: Automated test execution.
   - `promote_change`: Fast-forward commit to HEAD once attested and gates pass.

4. **Mark Node Completion**:
   Record the completed transition with cryptographic evidence hash:
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

### Step 6: Memory Compaction & Continuous Synthesis
After each logical batch or execution round:
1. Compact the interaction round and store key insights into the Neural Brain:
   ```json
   {
     "tool": "brain_summarize",
     "arguments": {
       "userIntent": "<intent>",
       "actionsTaken": "<actions>",
       "outcome": "<outcome>",
       "content": "<condensed summary for run_summary dimension>"
     }
   }
   ```
2. Store any newly discovered architectural decisions, pitfalls, or user preferences using `brain_store`.

---

## 2. Legacy Detached Mode (Compatibility Fallback)

If explicitly requested by the user or when running in environments where detached background execution is required:
1. Call `run_mission` with `{"goal": "$ARGUMENTS"}`.
2. Report the mission id and the watch command: `oma watch --mission <mission-id>`.
