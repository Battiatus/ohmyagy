---
name: graph-recovery
description: Crash recovery and deterministic state reconstruction protocol for Oh My Antigravity (OMA).
---

# Graph Recovery Skill

Use this skill when recovering from an unexpected system crash, process termination, or session interruption.

## Instructions
1. Run `oma resume` to read `.oma/ledger/events.jsonl` and `.oma/graph/events.jsonl`.
2. Clean up any orphaned worktree directories under `.oma/worktrees/`.
3. Advance the mission epoch to invalidate stale worker leases.
4. Calculate the projected `readySet` and resume execution of uncompleted tasks.
