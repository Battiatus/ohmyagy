---
description: List every OMA mission recorded in this workspace
---

List the OMA missions in this workspace. Read-only.

Call the `list_missions` tool exposed by the `oma-broker` MCP server with:

```json
{}
```

Present the returned `missions` as a short table — mission id, status and current wave — most recently active first. If the list is empty, say there are no missions yet and suggest starting one with `/oma:start <objective>`.
