---
name: quality-oracle
description: Deterministic test gate evaluation and proof generation protocol for Oh My Antigravity (OMA).
---

# Quality Oracle Skill

Use this skill to configure, register, and evaluate automated quality gates on isolated worktrees.

## Instructions
1. Define test, lint, and build gates in `.agents/plugins/oma/gates.json`.
2. Ensure each gate specifies executable program, arguments, and timeout in milliseconds.
3. Oracle executes the gates inside isolated worktrees, capturing stdout, stderr, exit code, and cryptographic execution proofs.
