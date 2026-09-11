// Probe: does the deployed broker know which workspace it governs?
//
// AntiGravity spawns stdio MCP servers with cwd set to its own installation
// directory, so `OMA_WORKSPACE_ROOT || process.cwd()` silently made the editor
// install tree the governed workspace during the live run of 2026-09-11. This
// probe reproduces that fallback and then shows whether an explicit
// OMA_WORKSPACE_ROOT neutralizes it.
//
// Run: node docs/audits/2026-09-11-oma-ide-live-run/probe-workspace.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const BROKER = "C:\\Users\\User\\Documents\\Repos\\plugins\\ohmyagy\\dist\\src\\mcp\\broker-server.js";
const EDITOR_INSTALL_CWD = "C:\\Users\\User\\AppData\\Local\\Programs\\antigravity";
const PROJECT_ROOT = "C:\\Users\\User\\Documents\\Repos\\Symap";
const CALL_TIMEOUT_MS = 60_000;

function probe({ label, workspaceRoot, deployed }) {
  return new Promise((resolveProbe) => {
    const env = { ...process.env };
    delete env.OMA_WORKSPACE_ROOT;
    let command = process.execPath;
    let args = [BROKER];
    let cwd = EDITOR_INSTALL_CWD;
    if (deployed !== undefined) {
      command = deployed.command;
      args = deployed.args;
      cwd = deployed.cwd ?? EDITOR_INSTALL_CWD;
      Object.assign(env, deployed.env ?? {});
    } else if (workspaceRoot !== undefined) {
      env.OMA_WORKSPACE_ROOT = workspaceRoot;
    }

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const pending = new Map();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolveProbe(value);
    };
    const timer = setTimeout(() => finish({ label, error: "timeout" }), CALL_TIMEOUT_MS);

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (id, method, params) =>
      new Promise((resolveRequest) => {
        pending.set(id, resolveRequest);
        send({ jsonrpc: "2.0", id, method, params });
      });

    createInterface({ input: child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method !== undefined && message.id !== undefined) {
        // Server -> client request (roots/list, sampling, ...): the probe has no
        // answer to give, and the broker must survive that.
        send({ jsonrpc: "2.0", id: message.id, result: {} });
        return;
      }
      const waiter = message.id !== undefined ? pending.get(message.id) : undefined;
      if (waiter !== undefined) {
        pending.delete(message.id);
        waiter(message);
      }
    });

    void (async () => {
      const initialized = await request(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "oma-workspace-probe", version: "1.0.0" },
      });
      if (initialized.error !== undefined) {
        finish({ label, error: initialized.error });
        return;
      }
      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      const called = await request(2, "tools/call", { name: "doctor", arguments: {} });
      if (called.error !== undefined) {
        finish({ label, error: called.error });
        return;
      }
      const payload = JSON.parse(called.result.content[0].text);
      finish({ label, workspace: payload.report.workspace });
    })();
  });
}

function probeFromDeployedConfig() {
  const configPath = join(homedir(), ".gemini", "config", "plugins", "oma", "mcp_config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return probe({
    label: `deployed plugin config verbatim (${configPath})`,
    deployed: config.mcpServers["oma-broker"],
  });
}

const results = [];
results.push(await probe({ label: "no OMA_WORKSPACE_ROOT (the live run's configuration)" }));
results.push(await probe({ label: "OMA_WORKSPACE_ROOT stated", workspaceRoot: PROJECT_ROOT }));
results.push(await probeFromDeployedConfig());

for (const result of results) {
  console.log(JSON.stringify(result, null, 2));
}
