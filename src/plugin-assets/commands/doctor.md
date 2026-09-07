---
description: Diagnose the local AntiGravity runtime and OMA plugin installation
---

Check that OMA can run in this workspace. Read-only.

Call the `doctor` tool exposed by the `oma-broker` MCP server with:

```json
{}
```

From the returned `report`, tell the user whether the AntiGravity CLI is available and whether the workspace plugin is discovered and valid. If anything is missing, name the failing check and suggest `oma install` (from a terminal) to repair the workspace plugin.
