---
name: oma-start
description: Start a verified OMA mission from a natural-language objective
---

# Start an OMA mission

When invoked with an objective, call the `run_mission` tool exposed by the `oma-broker` MCP server with only:

```json
{"goal":"$ARGUMENTS"}
```

Do not ask for or invent a mission id, model, effort, gates path, timeout, concurrency, or wave count.

When the tool returns `status: "started"`, report the mission id and the exact command `oma watch --mission <mission-id>`. Do not continue the mission or perform the requested analysis yourself.
