---
description: Show the live status of the active (or a named) OMA mission
argument-hint: '[mission-id]'
---

Report the current state of an OMA mission. Do not start, resume, or modify any mission.

Call the `mission_status` tool exposed by the `oma-broker` MCP server with:

```json
{"missionId":"$ARGUMENTS"}
```

An empty `missionId` targets the most recently active mission. Summarize the returned `phase`, `currentWave`, `ready`/`running`/`accepted` work items and the `progress` vector in a few lines. If the tool reports no active mission, say so and suggest `/oma:list`.
