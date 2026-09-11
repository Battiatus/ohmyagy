# OMA — the first real IDE run (2026-09-11) and where it actually ran

Evidence from the live AntiGravity IDE session of 2026-09-11 18:35–18:45, archived
verbatim from `%LOCALAPPDATA%\Programs\antigravity\.oma` before the workspace pin
was applied. Raw artifacts sit beside this report; nothing here is reconstructed
from memory.

## Why this report exists

The run was requested as an analysis of `C:\Users\User\Documents\Repos\Symap`. It
produced a full conductor loop, a four-node plan, a revision-2 graph and a growing
brain database — all of it inside the editor's own installation directory. Every
OMA path, gate and metric was keyed to a workspace no user asked about, and the
system reported health the whole time.

## L1 — the broker governed the editor installation directory (critical)

`src/mcp/broker-server.ts:773` resolves the workspace once:

```ts
workspaceRoot: process.env.OMA_WORKSPACE_ROOT || process.cwd(),
```

`src/packaging/install.ts:292-300` deliberately writes no workspace into the
globally deployed plugin config, with this comment:

```ts
// For global plugin, do not hardcode a specific workspace root so it defaults to the active CWD
```

The assumption in that comment is false. AntiGravity spawns stdio MCP servers with
`cwd` set to its own installation directory, so the fallback is not the user's
project:

```
$ node docs/audits/2026-09-11-oma-ide-live-run/probe-workspace.mjs
{ "label": "no OMA_WORKSPACE_ROOT (the live run's configuration)",
  "workspace": { "root": "C:\\Users\\User\\AppData\\Local\\Programs\\antigravity",
                 "source": "process.cwd",
                 "installTreeMarkers": ["Antigravity.exe", "chrome_100_percent.pak"],
                 "governsEditorInstall": true } }
{ "label": "OMA_WORKSPACE_ROOT stated",
  "workspace": { "root": "C:\\Users\\User\\Documents\\Repos\\Symap",
                 "source": "OMA_WORKSPACE_ROOT", "governsEditorInstall": false } }
{ "label": "deployed plugin config verbatim (...\\plugins\\oma\\mcp_config.json)",
  "workspace": { "root": "C:\\Users\\User\\Documents\\Repos\\Symap",
                 "source": "OMA_WORKSPACE_ROOT", "governsEditorInstall": false } }
```

The third probe is the pre-flight proof: the pinned deployed configuration, used
verbatim including its `cwd` and `env`, resolves to Symap.

Corroboration in the archived state: `.oma/graph/session-mission-id` and
`.oma/missions/mission-1789144666489/` exist under
`%LOCALAPPDATA%\Programs\antigravity\`, and were written during the run
(`18:37:46`, `18:44:19`), not under Symap.

This is the same defect family as the false-success contract: a required input was
missing, a silent default was substituted for it, and every downstream status
stayed green. The difference is the blast radius — it invalidated the workspace
for *every* tool, not just the success verdict.

## L2 — what the run did prove (positive)

The conductor loop works end to end on real state. Archived:

| Artifact | Size | What it shows |
| --- | --- | --- |
| `graph-events.jsonl` | 5564 B | 10 hash-chained journal entries, head `0703913f…` |
| `execution-graph.rev-002.json` | 2614 B | the four-node DAG the conductor proposed and applied |
| `mission-events.jsonl` | 12042 B | `mission_started`, 5× `work_item_discovered`, 5× `run_started`/`run_finished`, 5× `integration_attempted`, 4× `round_started`, 4× `gate_evaluated` |
| `ledger-events.jsonl` | 811 B | ledger writes |

The IDE cached 23 `oma-broker` tools after the handshake fix. `ask_question` put
three questions to the user and received answers (`18:37:16`→`18:37:29`),
`plan_route(diagnostic)` ran, `graph_init` → `graph_propose` → `graph_apply`
reached revision 2, `converge_step` and `graph_mark_node(running)` were called, and
the explorer read the real Symap project. The hooks fired: 8 staging files exist
under `%USERPROFILE%\.oma\staging\`, the largest 34 KB
(`ba9c4b1e-…jsonl`, 18:45:14).

Note the split this created: the *explorer* read Symap because the prompt named it,
while the *mission, graph and brain* lived in the install directory. Nothing in the
system flagged the disagreement.

## L3 — the strict write gate cannot arm in the IDE

`src/strict/hook.ts:15` decides liveness from `process.cwd()` before reading
stdin. AntiGravity spawns plugin hooks with `cwd` set to the plugin directory
(`~/.gemini/config/plugins/oma`), so `isMissionLiveFor` searches
`~/.gemini/config/plugins/oma/.oma/v2/missions/*/live.json` and its ancestors —
never the workspace. In the IDE the gate always takes the fail-open branch.

Confirmed empirically: no `live.json` exists anywhere under the plugin tree, the
user profile, Symap or the install directory, and a probe run confirmed the gate
emits its `allow` result. This is safe — it cannot produce false denials — but
"strict mode" is currently decorative in the IDE, and the rule file shipped in
`rules/oma-strict.md` describes enforcement that does not happen. Fixing this
requires the same missing input as L1: the workspace, from the host.

## Remediation committed with this report

1. `DoctorReport.workspace` reports the governed root, how it was chosen
   (`OMA_WORKSPACE_ROOT` / `argument` / `process.cwd`), and whether a silent
   fallback landed on an editor installation tree. Detection is limited to an
   unambiguous install signature (`Antigravity.exe`, `resources/app`,
   `chrome_100_percent.pak`): a real workspace may carry no marker at all — Symap
   is an aggregate of two repositories with no `.git`, no `.gitmodules` and no
   `package.json` at its root — so a "does this look like a project" test would
   condemn the correct target.
2. `oma doctor --attest` exits 1 when the fallback governs the editor install, and
   `requireRuntime` refuses to start a mission in that state:
   `OMA governs the editor installation directory, not a project: …`
   Verified: run from `%LOCALAPPDATA%\Programs\antigravity`, exit 1 with that
   message; the same command from the checkout is unaffected.
3. Both deployed MCP definitions (global `~/.gemini/config/mcp_config.json` and the
   plugin's own) are pinned to `OMA_WORKSPACE_ROOT`/`cwd` = the Symap workspace,
   with `.prepin-bak` backups beside each.

## Residual risk — read before relying on the pin

The pin is a hand-applied workaround on this machine, not a property of the
product:

- It is **global**. Every project now resolves to Symap until it is removed.
- `oma install --global` erases it, because `install.ts` rewrites
  `plugins/oma/mcp_config.json` without a workspace by design.
- It makes one workspace work, not many.

The correct fix is for the broker to discover the workspace from the host through
MCP `roots/list` — present in the AGY 1.2.1 binary beside `tools/list` — and to
fail loudly when neither an explicit root nor a root from the host is available.
The single-project pin then comes out.

## Reproduction

```sh
cd C:/Users/User/Documents/Repos/plugins/ohmyagy
npm run build
node docs/audits/2026-09-11-oma-ide-live-run/probe-workspace.mjs
cd "$LOCALAPPDATA/Programs/antigravity" && node <checkout>/dist/bin/oma.js doctor --attest   # exit 1
```
