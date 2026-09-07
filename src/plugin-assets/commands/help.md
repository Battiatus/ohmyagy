---
description: List the OMA commands available from this conversation
---

Present the OMA command palette. Do not call any tool; this is a static reference.

Show the user this list:

- `/oma:run <objective>` — start a new multi-agent mission for the objective.
- `/oma:status [mission-id]` — live status of the active or named mission.
- `/oma:list` — every mission in this workspace, most recent first.
- `/oma:inspect [mission-id]` — provenance chain: artifacts, reviews, terminal verdict.
- `/oma:resume [mission-id]` — resume an interrupted mission without re-running finished work.
- `/oma:doctor` — check the AntiGravity runtime and OMA plugin installation.
- `/oma:help` — show this palette.

Add that missions run with the plugin's installed quality gates and AGY's native model and effort defaults, so none of these commands need extra configuration.
