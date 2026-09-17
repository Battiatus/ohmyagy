import { buildProbeReport, formatProbeReport, writeProbeReport } from "./report.js";
import { installProbe, probeStatus, resetProbeLogs, uninstallProbe } from "./install.js";
import { resolveProbeCommands } from "./plugin.js";

/**
 * `oma probe ...` — the session-identity measurement, driven from the CLI.
 *
 * Kept as a subcommand of the real CLI rather than a loose script so the probe cannot
 * drift from the code it measures, and so the host-contract validation that OMA's own
 * installer uses (`validateHooksDocument`) is applied to the probe's `hooks.json` too.
 */
export function runProbeCli(args: readonly string[]): number {
  const command = args[0];

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printProbeHelp();
    return 0;
  }

  if (command === "status") {
    const status = probeStatus();
    console.log(JSON.stringify(status, null, 2));
    if (!status.installed) {
      console.log("\nThe probe plugin is not installed. Run: oma probe install");
    } else if (status.hooksValid !== true) {
      console.log("\nThe installed hooks.json is not a document the host would accept.");
    }
    return 0;
  }

  if (command === "install") {
    const commands = resolveProbeCommands();
    const result = installProbe({ commands });
    console.log("[OMA probe] measurement plugin installed.");
    console.log(`  plugin      ${result.pluginDir}`);
    if (result.backedUpFiles.length > 0) {
      console.log(`  backups     ${result.backedUpFiles.length} file(s) preserved beside the new ones (.bak)`);
    }
    console.log(`  hook        ${commands.hookPath}`);
    console.log(`  mcp server  ${commands.mcpServerPath}`);
    console.log(`  hooks.json accepted by the host parser: ${result.hooksValid ? "yes" : "NO"}`);
    console.log(
      `  mcp_config.json states a workspace: ${result.mcpConfigStatesWorkspace ? "YES (measurement would be void)" : "no — by design"}`,
    );
    console.log("");
    console.log("Next:");
    console.log("  1. Quit AntiGravity completely (every window), then relaunch it.");
    console.log("  2. Open project A, send a prompt that triggers at least one tool call, then a second one.");
    console.log("  3. Open project B in a second window, keeping A open, and do the same.");
    console.log("  4. Quit AntiGravity, then run: oma probe report");
    return 0;
  }

  if (command === "reset") {
    const result = resetProbeLogs();
    console.log(`[OMA probe] measurements cleared: ${result.removed.length} path(s) removed`);
    for (const path of result.removed) console.log(`  ${path}`);
    console.log("The plugin stays installed. Every measurement from now on belongs to the run you are about to do.");
    return 0;
  }

  if (command === "uninstall") {
    const result = uninstallProbe({ purge: args.includes("--purge") });
    console.log(`[OMA probe] plugin removed: ${result.removed ? "yes" : "nothing to remove"}`);
    console.log(`  ${result.pluginDir}`);
    if (result.purgedLogs) console.log("  measurements deleted (--purge)");
    else console.log("  measurements kept: run 'oma probe report' before --purge");
    return 0;
  }

  if (command === "report") {
    const report = buildProbeReport();
    const path = writeProbeReport(report);
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatProbeReport(report));
    }
    console.log(`\nfull evidence: ${path}`);
    return report.mcp.instanceCount === 0 && report.hooks.invocationCount === 0 ? 1 : 0;
  }

  console.error(`Unknown probe command: ${command}`);
  printProbeHelp();
  return 2;
}

function printProbeHelp(): void {
  console.log(
    [
      "oma probe — measure what AntiGravity hands a plugin's MCP server and hooks",
      "",
      "  oma probe install      install the temporary measurement plugin (~/.gemini/config/plugins/oma-probe)",
      "  oma probe status       show whether the probe is installed and whether its hooks.json is valid",
      "  oma probe reset        delete the measurements, keeping the plugin installed",
      "  oma probe report       analyse the measurements (--json for the raw report)",
      "  oma probe uninstall    remove the plugin (--purge also deletes the measurements)",
      "",
      "The probe never pins a workspace: that is exactly what it measures.",
    ].join("\n"),
  );
}
