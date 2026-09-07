---
description: Run an OMA multi-agent mission from this conversation
argument-hint: '<objective>'
---

Start exactly one OMA mission for this objective: `$ARGUMENTS`.

Call the `run_mission` tool exposed by the `oma-broker` MCP server with only:

```json
{"goal":"$ARGUMENTS"}
```

Do not ask for a model, effort, gates path, mission id, timeout, concurrency, or wave count. The plugin supplies its installed quality gates. OMA must leave model and effort unset so AGY applies its own native defaults.
