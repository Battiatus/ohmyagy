import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { validateHooksDocument } from "../packaging/hook-contract.js";
import { globalPluginsDir, probeHookLogDir, probeHomeDir, probeMcpLogDir, probePluginDir, probeReportPath, PROBE_PLUGIN_NAME } from "./paths.js";
import { buildProbePluginDocuments, resolveProbeCommands, type ProbeCommands } from "./plugin.js";

/**
 * Installer for the measurement plugin.
 *
 * Three properties it must have, each because the previous session's installer lacked it:
 *
 *  * **Non-destructive.** The plugin store is shared by the whole machine. An existing
 *    probe install is renamed aside, never `rmSync`'d, and nothing outside
 *    `<plugins>/oma-probe` is ever written or deleted.
 *  * **Idempotent.** Re-running produces the same documents; the backup carries a
 *    timestamp so repeated installs never collide.
 *  * **Unpinned.** The generated `mcp_config.json` states no workspace (see `plugin.ts`).
 */

export interface ProbeInstallOptions {
  /** Overridable for tests; defaults to `~/.gemini/config/plugins`. */
  pluginsRoot?: string;
  commands?: ProbeCommands;
}

export interface ProbeInstallResult {
  pluginDir: string;
  /** Per-file backups written before overwriting a previous install. */
  backedUpFiles: string[];
  hooksValid: boolean;
  mcpConfigStatesWorkspace: boolean;
}

/**
 * Install by overwriting the three documents **in place**, backing each one up first.
 *
 * An earlier version renamed the whole plugin directory aside. That fails with
 * `EBUSY` on Windows whenever the editor is running: the host holds the plugin
 * directory open while it watches it, and a running editor is exactly the situation
 * the probe has to be installable in. Per-file backups have no such failure mode and
 * stay non-destructive.
 */
export function installProbe(options: ProbeInstallOptions = {}): ProbeInstallResult {
  const pluginsRoot = options.pluginsRoot ?? globalPluginsDir();
  if (pluginsRoot === undefined) {
    throw new Error(
      "Cannot locate the plugin store: neither USERPROFILE nor HOME is set. AntiGravity only loads plugins from ~/.gemini/config/plugins, so there is nowhere to install the probe.",
    );
  }
  const commands = options.commands ?? resolveProbeCommands();
  const documents = buildProbePluginDocuments(commands);
  const pluginDir = probePluginDir(pluginsRoot);
  mkdirSync(pluginDir, { recursive: true });

  const backedUpFiles: string[] = [];
  const documents$ = [
    ["plugin.json", documents.pluginJson],
    ["hooks.json", documents.hooksJson],
    ["mcp_config.json", documents.mcpConfig],
  ] as const;

  for (const [name, value] of documents$) {
    const path = join(pluginDir, name);
    if (existsSync(path)) {
      const backupPath = `${path}.bak`;
      try {
        cpSync(path, backupPath, { force: true });
        backedUpFiles.push(backupPath);
      } catch {
        // A backup that cannot be written is reported by its absence, never fatal.
      }
    }
    writeJson(path, value);
  }

  return {
    pluginDir,
    backedUpFiles,
    hooksValid: validateHooksDocument(documents.hooksJson).valid,
    mcpConfigStatesWorkspace: mcpConfigStatesWorkspace(documents.mcpConfig),
  };
}

export interface ProbeUninstallOptions {
  pluginsRoot?: string;
  /** Also delete the measurements. Off by default: the report needs them. */
  purge?: boolean;
  homeDirectory?: string;
}

/** Delete the measurements, keeping the plugin installed. */
export function resetProbeLogs(options: { homeDirectory?: string } = {}): { removed: string[] } {
  const removed: string[] = [];
  for (const dir of [probeMcpLogDir(options.homeDirectory), probeHookLogDir(options.homeDirectory)]) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }
  const reportPath = probeReportPath(options.homeDirectory);
  if (existsSync(reportPath)) {
    rmSync(reportPath, { force: true });
    removed.push(reportPath);
  }
  return { removed };
}

export interface ProbeUninstallResult {
  pluginDir: string;
  removed: boolean;
  purgedLogs: boolean;
}

export function uninstallProbe(options: ProbeUninstallOptions = {}): ProbeUninstallResult {
  const pluginsRoot = options.pluginsRoot ?? globalPluginsDir();
  if (pluginsRoot === undefined) {
    throw new Error("Cannot locate the plugin store: neither USERPROFILE nor HOME is set.");
  }
  const pluginDir = probePluginDir(pluginsRoot);
  const removed = existsSync(pluginDir);
  if (removed) rmSync(pluginDir, { recursive: true, force: true });
  let purgedLogs = false;
  if (options.purge === true) {
    const home = probeHomeDir(options.homeDirectory);
    if (existsSync(home)) {
      rmSync(home, { recursive: true, force: true });
      purgedLogs = true;
    }
  }
  return { pluginDir, removed, purgedLogs };
}

export interface ProbeStatus {
  pluginDir: string;
  installed: boolean;
  hooksValid: boolean | undefined;
  mcpConfigStatesWorkspace: boolean | undefined;
  mcpCommand: unknown;
  logDirectory: string;
  mcpLogFiles: number;
  hookLogFiles: number;
}

export function probeStatus(options: { pluginsRoot?: string; homeDirectory?: string } = {}): ProbeStatus {
  const pluginsRoot = options.pluginsRoot ?? globalPluginsDir();
  const pluginDir = pluginsRoot === undefined ? join("<unresolved>", PROBE_PLUGIN_NAME) : probePluginDir(pluginsRoot);
  const hooksPath = join(pluginDir, "hooks.json");
  const mcpConfigPath = join(pluginDir, "mcp_config.json");
  const installed = existsSync(hooksPath) && existsSync(mcpConfigPath);

  let hooksValid: boolean | undefined;
  let statesWorkspace: boolean | undefined;
  let mcpCommand: unknown;
  if (installed) {
    try {
      hooksValid = validateHooksDocument(JSON.parse(readFileSync(hooksPath, "utf8"))).valid;
    } catch {
      hooksValid = false;
    }
    try {
      const config = JSON.parse(readFileSync(mcpConfigPath, "utf8")) as Record<string, unknown>;
      statesWorkspace = mcpConfigStatesWorkspace(config);
      const servers = config.mcpServers;
      mcpCommand =
        typeof servers === "object" && servers !== null && !Array.isArray(servers)
          ? (servers as Record<string, unknown>)["oma-probe"]
          : undefined;
    } catch {
      statesWorkspace = undefined;
    }
  }

  return {
    pluginDir,
    installed,
    hooksValid,
    mcpConfigStatesWorkspace: statesWorkspace,
    mcpCommand,
    logDirectory: probeHomeDir(options.homeDirectory),
    mcpLogFiles: countJsonl(probeMcpLogDir(options.homeDirectory)),
    hookLogFiles: countJsonl(probeHookLogDir(options.homeDirectory)),
  };
}

/**
 * Does this MCP definition state a workspace?
 *
 * The measurement is void if it does, so the installer reports it and a test forbids it.
 */
export function mcpConfigStatesWorkspace(config: Record<string, unknown>): boolean {
  const servers = config.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return false;
  for (const definition of Object.values(servers as Record<string, unknown>)) {
    if (typeof definition !== "object" || definition === null || Array.isArray(definition)) continue;
    const entry = definition as Record<string, unknown>;
    if (entry.cwd !== undefined) return true;
    if (typeof entry.serverUrl === "string") continue;
    const env = entry.env;
    if (typeof env !== "object" || env === null || Array.isArray(env)) continue;
    for (const key of Object.keys(env as Record<string, unknown>)) {
      if (/WORKSPACE|PROJECT_ROOT|REPO_ROOT/i.test(key)) return true;
    }
  }
  return false;
}

function countJsonl(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
