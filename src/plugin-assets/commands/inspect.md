---
description: Inspect the provenance chain, artifacts and reviews of an OMA mission
argument-hint: '[mission-id]'
---

Inspect the cryptographic provenance of an OMA mission. Read-only: do not start, resume, or modify any mission.

Call the `mission_inspect` tool exposed by the `oma-broker` MCP server with:

```json
{"missionId":"$ARGUMENTS"}
```

An empty `missionId` targets the most recently active mission. From the returned `provenance`, summarize the produced artifacts, the attested reviews and the terminal verdict (with its commit SHA when present). If the tool reports no active mission, say so and suggest `/oma:list`.
