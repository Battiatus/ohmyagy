---
name: dynamic-workflow
description: Dynamic Workflow proposal and Graph Broker expansion protocol for Oh My Antigravity (OMA).
---

# Dynamic Workflow Skill

Use this skill when extending the active task graph during runtime exploration or execution.

## Instructions
1. Prepare a valid `GraphProposal` containing `proposalId`, `targetGraphRevision`, `rationale`, and delta operations.
2. Ensure that added nodes and edges do not introduce cycles or mutate terminal nodes.
3. Submit the proposal to the OMA Graph Broker to atomically increment the graph revision to $N+1$.
