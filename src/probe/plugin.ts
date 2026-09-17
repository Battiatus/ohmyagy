import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateHooksDocument } from "../packaging/hook-contract.js";
import { antigravityCommand } from "../packaging/install.js";

/**
 * The probe's plugin documents.
 *
 * Two invariants, both asserted by tests:
 *
 *  1. `hooks.json` must be a document the host's parser accepts. The host validates
 *     `hooks.json` all-or-nothing: a single unsupported event name discards the WHOLE
 *     file, which is how an earlier `Stop` event silently disabled the strict write gate
 *     *and* the memory hook.
 *  2. `mcp_config.json` must carry **no workspace statement at all** — no `cwd`, no
 *     `env`, no `OMA_WORKSPACE_ROOT`. That is the entire point: the probe measures what
 *     the host provides on its own. A pin here would make the measurement worthless and
 *     would be the very defect the probe exists to remove.
 */

export interface ProbePluginDocuments {
  pluginJson: Record<string, unknown>;
  hooksJson: Record<string, unknown>;
  mcpConfig: Record<string, unknown>;
}

export interface ProbeCommands {
  /** Absolute path to the compiled probe hook script. */
  hookPath: string;
  /** Absolute path to the compiled probe MCP server script. */
  mcpServerPath: string;
  /** Node binary, forward-slashed the way the host's hook runner expects. */
  nodePath?: string;
}

/**
 * Resolve the built probe scripts.
 *
 * Built artefacts win; the TypeScript sources are a fallback so a checkout works before
 * `npm run build`. The host's hook runner is a plain command string, so a fallback to
 * `.ts` would only work under bun — hence the explicit preference order.
 */
export function resolveProbeCommands(fromUrl = import.meta.url): ProbeCommands {
  const here = dirname(fileURLToPath(fromUrl));
  const hookPath = firstExisting([
    resolve(here, "hook-probe.js"),
    resolve(here, "../../dist/src/probe/hook-probe.js"),
    resolve(here, "hook-probe.ts"),
  ]);
  const mcpServerPath = firstExisting([
    resolve(here, "mcp-probe-server.js"),
    resolve(here, "../../dist/src/probe/mcp-probe-server.js"),
    resolve(here, "mcp-probe-server.ts"),
  ]);
  if (hookPath === undefined || mcpServerPath === undefined) {
    throw new Error(
      `Probe build artefacts are missing: hookPath=${hookPath ?? "<none>"}, mcpServerPath=${mcpServerPath ?? "<none>"}. Run 'npm run build' first.`,
    );
  }
  return { hookPath, mcpServerPath, nodePath: slash(process.execPath) };
}

function firstExisting(candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

function slash(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * A hook command the Windows runner can actually execute.
 *
 * Measured 2026-09-11: the host's Windows hook runner does not strip quotes from paths,
 * so OMA emits forward-slashed paths without quotes and refuses paths that contain a
 * space. A probe whose command is silently mangled would register a hook that never
 * runs, which is indistinguishable from "the hook never fires" — the exact confusion
 * this measurement cannot afford.
 */
export function probeHookCommand(parts: readonly string[]): string {
  const normalized = parts.map(slash);
  const withSpaces = normalized.find((part) => /\s/u.test(part));
  if (withSpaces !== undefined) {
    throw new Error(
      `Probe hook command contains a path with a space ('${withSpaces}'). The host's Windows hook runner mishandles quoted paths (measured 2026-09-11), so the hook would register and never run. Install from a path without spaces, or run the CLI with a space-free node.`,
    );
  }
  return antigravityCommand(normalized);
}

export function buildProbePluginDocuments(commands: ProbeCommands): ProbePluginDocuments {
  const hookPath = slash(commands.hookPath);
  const nodePath = slash(commands.nodePath ?? process.execPath);
  const preToolUse = probeHookCommand([nodePath, hookPath, "PreToolUse"]);
  const postToolUse = probeHookCommand([nodePath, hookPath, "PostToolUse"]);

  const hooksJson: Record<string, unknown> = {
    "oma-probe-pretool": {
      enabled: true,
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: preToolUse, timeout: 10 }] }],
    },
    "oma-probe-posttool": {
      enabled: true,
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: postToolUse, timeout: 10 }] }],
    },
  };

  const verdict = validateHooksDocument(hooksJson);
  if (!verdict.valid) {
    throw new Error(
      `Refusing to install a probe hooks.json the host would reject (it would register zero hooks): ${verdict.problems
        .map((problem) => `${problem.path || "<root>"}: ${problem.message}`)
        .join("; ")}`,
    );
  }

  return {
    pluginJson: {
      $schema: "https://antigravity.google/schemas/v1/plugin.json",
      name: "oma-probe",
      description:
        "OMA session-identity probe. Measures what AntiGravity hands a plugin's MCP server and hooks. Temporary; remove with 'oma probe uninstall'.",
    },
    hooksJson,
    // No cwd, no env, no workspace. Deliberate, and asserted by a test.
    //
    // The command is an absolute node path rather than bare `node`: a probe that failed to
    // start would read as "the host never spawns a server for this plugin", and that is a
    // conclusion the measurement must not reach by accident.
    mcpConfig: {
      mcpServers: {
        "oma-probe": {
          command: nodePath,
          args: [slash(commands.mcpServerPath)],
        },
      },
    },
  };
}
