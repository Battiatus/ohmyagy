# 2026-09-14 — one project for every workspace

The vision states that the Brain is split **per project, then per session**, so every
session of one project shares its memory while projects stay isolated. This report
records the measurement that shows the isolation never engages in the IDE.

## Measurement

Both `brain.sqlite` files present on this machine, read directly:

```
checkout ohmyagy   projects: 1   name="ohmyagy"      memory_entries=0    sessions=1
editor install dir projects: 1   name="antigravity"  memory_entries=23   sessions=3
                     80a00780  "Mission mission-1789144666489"   11/09   ← the Symap analysis
                     5656f255  (no objective)                  11/09
                     543f421a  "Mission mission_audit_v2"        14/09   ← another workspace's session
Symap              no brain.sqlite at all
```

The checkout file is this agent's own test artifact (0 entries) and was deleted. The
file that matters holds **one** `projects` row, named after the editor's installation
directory, containing a Symap mission and an unrelated session from a different
workspace.

## The reported symptom

A `/oma-start` in one project was answered with a synthesis about Symap and AgentsHub.
The prompt named neither, so they came from stored memory: specifically from session
`80a00780`, the 11/09 Symap run. The responding session never governed its own project.

## Why the isolation never engaged

The hierarchy is implemented and correct — `src/brain/brain-store.ts:46-97`:

```sql
projects (id, ...)                                    sessions (id, project_id, ...)
memory_entries (project_id, session_id, ...)          interaction_summaries (session_id, ...)
```

and `queryMemory` filters on `project_id` unconditionally, commented "this is the
multi-project isolation".

But its key is the workspace root (`src/brain/mission-ingest.ts:22`, "Workspace root
path (used to derive default projectId and paths)"), and the workspace root came from:

```ts
workspaceRoot: process.env.OMA_WORKSPACE_ROOT || process.cwd(),
```

AntiGravity spawns stdio MCP servers with `cwd` set to its own installation directory
(`%LOCALAPPDATA%\Programs\antigravity`, proven by probe in the 2026-09-11 report). Every
project therefore resolved to one root, produced one `projectId` and shared one brain.
`projects: 1` is the whole failure in one number, and no test caught it because every
test constructs a broker with an explicit workspace root.

## Fix

`src/mcp/broker-server.ts` now binds the governed workspace during the MCP handshake:

1. If `OMA_WORKSPACE_ROOT` is set, it wins. An operator pin is never overridden.
2. Otherwise, if the client advertises `capabilities.roots`, the broker sends
   `roots/list` and uses the host's answer. A malformed root is never substituted by a
   guess; several roots are reported and refused rather than resolved by guessing; a
   5-second timeout leaves the workspace unresolved.
3. Requests are still answered in arrival order, except replies — a reply to
   `roots/list` must not queue behind the initialize that is waiting for it. (The first
   version of this code did exactly that and deadlocked the handshake for 5 seconds,
   which the tests caught.)

`workspaceRefusal` makes the failure loud: a session whose workspace is the editor
installation directory is refused with a message naming the root and its source, while
`doctor` stays reachable so the cause is diagnosable.

## Verified

`src/mcp/__tests__/workspace-roots.test.ts` drives the real transport over stdio:

- the host's roots decide the project, not the editor's cwd: `graph_init` lands in the
  declared project and creates nothing in the install tree;
- an editor-install workspace with no host roots is refused (`-32002`) and writes
  nothing, while `doctor` still answers;
- several host roots are never resolved by guessing.

`src/runtime/__tests__/workspace-report.test.ts` pins the report semantics, including
that a real workspace carrying no marker at all (Symap: no `.git`, no `package.json`)
is never mistaken for an install tree.

## Still open

- **Whether AntiGravity answers `roots/list` is unverified.** The capability is present
  in the 1.2.1 binary beside `tools/list`, but only an IDE run can confirm it. If the
  host stays silent, OMA now refuses every tool instead of answering about the wrong
  project — a deliberate trade. `doctor`'s `workspace.source` shows which happened:
  `roots/list` means the host answered; `process.cwd` means it did not.
- `~/.oma/staging` is still one directory for every session and every project, and the
  PostToolUse hook runs with `workspacePaths: []`, so it cannot know which project it
  captured.
- The `antigravity` brain's 23 entries must be archived, then that file removed: it is
  the editor's install tree, not a project.
