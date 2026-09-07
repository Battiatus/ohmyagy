---
description: Resume an interrupted OMA mission from its durable journal
argument-hint: '[mission-id]'
---

Resume an interrupted OMA mission. Successful work is never re-run; only interrupted or pending work items are retried.

Call the `resume_mission` tool exposed by the `oma-broker` MCP server with:

```json
{"missionId":"$ARGUMENTS"}
```

An empty `missionId` targets the most recently active mission. Report the returned mission id and confirm the run relaunched. Do not ask for a model, effort, gates path, timeout, concurrency, or wave count — the plugin supplies its installed quality gates and leaves model and effort to AGY's native defaults. After resuming, suggest `/oma:status` to follow progress.
