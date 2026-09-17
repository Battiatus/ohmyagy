import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the session-identity probe writes.
 *
 * `OMA_PROBE_HOME` redirects the whole probe the way `OMA_HOME` redirects OMA's
 * machine-wide state, so a test never writes into the developer's real home.
 *
 * The probe is deliberately *outside* `.oma/`: it must not be readable as OMA state,
 * and it must survive deleting the OMA plugin while the measurement is in progress.
 */
export function probeHomeDir(override?: string): string {
  const value = override ?? process.env.OMA_PROBE_HOME;
  const base = value !== undefined && value.length > 0 ? value : homedir();
  return join(base, ".oma-probe");
}

/** One file per probe MCP server process, named after its pid. */
export function probeMcpLogDir(homeDirectory?: string): string {
  return join(probeHomeDir(homeDirectory), "mcp");
}

/** One file per probe hook invocation. */
export function probeHookLogDir(homeDirectory?: string): string {
  return join(probeHomeDir(homeDirectory), "hooks");
}

export function probeReportPath(homeDirectory?: string): string {
  return join(probeHomeDir(homeDirectory), "report.json");
}

/** The user's real profile: the plugin store lives here, never under `OMA_PROBE_HOME`. */
export function userHomeDir(): string | undefined {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  return home !== undefined && home.length > 0 ? home : undefined;
}

/**
 * The only directory AntiGravity loads plugins from.
 *
 * Measured 2026-09-11 (`docs/audits/2026-09-11-oma-host-contract`): plugins under
 * `<workspace>/.agents/plugins/<name>` were never loaded, six probes and zero log
 * mentions. The probe therefore has to live exactly here.
 */
export function globalPluginsDir(override?: string): string | undefined {
  if (override !== undefined && override.length > 0) return override;
  const home = userHomeDir();
  return home === undefined ? undefined : join(home, ".gemini", "config", "plugins");
}

export const PROBE_PLUGIN_NAME = "oma-probe";

export function probePluginDir(pluginsRoot: string): string {
  return join(pluginsRoot, PROBE_PLUGIN_NAME);
}
