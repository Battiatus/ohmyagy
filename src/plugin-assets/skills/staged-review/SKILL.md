---
name: staged-review
description: 2-Phase Commit staged code review and promotion protocol for Oh My Antigravity (OMA).
---

# Staged Review Skill

Use this skill to submit, inspect, and attest adversarial code reviews on staged transactions.

## Instructions
1. Submit multi-file changes using `oma-broker`'s `propose_change` MCP tool to obtain a `stagedDiffDigest`.
2. Inspect the isolated staging worktree and compute independent review findings.
3. Attest approval or rejection using `attest_review` with an independent reviewer persona.
4. Verify that promotion occurs only after gate validation and review attestation.
