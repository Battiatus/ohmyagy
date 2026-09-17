import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { isRecord } from "../../ledger/canonical.js";
import { installWorkspacePlugin } from "../../packaging/install.js";
import { RealMissionExecutor } from "../real-mission.js";
import type { OracleGate } from "../../oracle/executor.js";

/**
 * Full real end-to-end proof: a genuine multi-agent OMA mission driven by the
 * installed AntiGravity binary, then read back through the SAME MCP broker the
 * `/oma:status`, `/oma:inspect` and `/oma:list` conversation commands use.
 *
 * This spends real tokens across several agy calls and can take many minutes,
 * so it is opt-in:
 *
 *   OMA_REAL_AGY=1 bun test src/orchestration/__tests__/real-mission.e2e.test.ts
 *
 * Assertions are robust to LLM non-determinism: they prove the palette faithfully
 * reflects whatever terminal state the real mission reached, not a forced verdict.
 */
const REAL_AGY_ENABLED = process.env.OMA_REAL_AGY === "1";
const E2E_TIMEOUT_MS = 900_000;
const MISSION_ID = "e2e-real-mission";
const TERMINAL_REPORT_STATUSES = new Set(["succeeded", "failed", "budget_exhausted"]);

test.skipIf(!REAL_AGY_ENABLED)(
  "a real agy mission is observable through the MCP broker palette (status/inspect/list)",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "oma-e2e-real-"));
    try {
      // 1. A real git workspace with a trivial, well-scoped task.
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "value.txt"), "before\n", "utf8");
      git(root, ["init"]);
      git(root, ["config", "user.email", "oma-test@local.invalid"]);
      git(root, ["config", "user.name", "OMA Test"]);
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "initial"]);
      mkdirSync(join(root, ".omc", "state"), { recursive: true });
      mkdirSync(join(root, ".omo", "run-continuation"), { recursive: true });
      writeFileSync(join(root, ".omc", "state", "session.json"), "{}\n", "utf8");
      writeFileSync(join(root, ".omo", "run-continuation", "session.json"), "{}\n", "utf8");

      const passGate: OracleGate = {
        id: "always-pass",
        program: process.execPath,
        args: ["-e", "process.exit(0)"],
        timeoutMs: 30_000,
      };

      // Install the plugin so the MCP broker config exists exactly as AGY sees it.
      installWorkspacePlugin(root, { gates: [passGate] });

      // installWorkspacePlugin writes a root .gitignore (adds `.oma/`). Commit it so the
      // mission's clean-workspace guard sees a clean tree — the guard excludes OMA's own
      // dirs but not a freshly written .gitignore, and a dirty tree is a legitimate refusal.
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "install oma plugin", "--allow-empty"]);

      // 2. Run a genuine multi-agent mission against the real agy binary.
      const report = await RealMissionExecutor.execute({
        workspaceRoot: root,
        missionId: MISSION_ID,
        goal: 'Edit src/value.txt so its only contents become the single line "after".',
        gates: [passGate],
        timeoutMs: 180_000,
        maxConcurrency: 1,
        maxWaves: 1,
      });

      // The mission must reach a terminal state and leave a durable journal.
      assert.ok(
        TERMINAL_REPORT_STATUSES.has(report.status),
        `mission did not reach a terminal state: ${report.status}`,
      );
      const eventsPath = join(root, ".oma", "missions", MISSION_ID, "events.jsonl");
      const events = readFileSync(eventsPath, "utf8");
      assert.ok(events.includes("mission_started"), "journal must record mission_started");

      // 3. Read the mission back through the REAL MCP broker, over stdio.
      const responses = runMcp(root, [
        initializeRequest(1),
        toolCall(2, "mission_status", { missionId: MISSION_ID }),
        toolCall(3, "mission_inspect", { missionId: MISSION_ID }),
        toolCall(4, "list_missions", {}),
      ]);

      // mission_status reflects the same mission and a coherent terminal state.
      // The projection enum differs from the report enum, so we assert a mapping,
      // not identity: success maps to success, everything else stays non-success
      // and, either way, the palette must never still report the run in progress.
      const status = resultFor(responses, 2);
      assert.equal(status.isError, false, JSON.stringify(status.structuredContent));
      assert.ok(isRecord(status.structuredContent));
      assert.equal(status.structuredContent.status, "reported");
      assert.equal(status.structuredContent.missionId, MISSION_ID);
      const missionStatus = String(status.structuredContent.missionStatus);
      assert.notEqual(missionStatus, "in_progress");
      if (report.status === "succeeded") {
        assert.equal(missionStatus, "succeeded");
      } else {
        assert.notEqual(missionStatus, "succeeded");
      }

      // mission_inspect returns the provenance chain for the same mission.
      const inspect = resultFor(responses, 3);
      assert.equal(inspect.isError, false);
      assert.ok(isRecord(inspect.structuredContent));
      assert.equal(inspect.structuredContent.missionId, MISSION_ID);
      assert.ok(isRecord(inspect.structuredContent.provenance));

      // list_missions surfaces the mission to the palette.
      const listed = resultFor(responses, 4);
      assert.equal(listed.isError, false);
      assert.ok(isRecord(listed.structuredContent));
      const missions = listed.structuredContent.missions;
      assert.ok(Array.isArray(missions));
      assert.ok(
        missions.some((m) => isRecord(m) && m.missionId === MISSION_ID),
        "list_missions must include the mission",
      );

      // Surface the real outcome so an opt-in run is legible in the log.
      console.error(
        `[E2E] real mission outcome: report=${report.status} palette=${missionStatus} ` +
          `commits=${report.commitShas.length} value.txt=${JSON.stringify(
            readFileSync(join(root, "src", "value.txt"), "utf8").trim(),
          )}`,
      );

      // If the real agents did converge, the palette must agree with the tree.
      if (report.status === "succeeded") {
        assert.equal(readFileSync(join(root, "src", "value.txt"), "utf8").trim(), "after");
        assert.equal((status.structuredContent.accepted as unknown[]).length > 0, true);
      }
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // agy may hold a transient Windows lock; the assertions already ran.
      }
    }
  },
  E2E_TIMEOUT_MS,
);

function runMcp(root: string, messages: unknown[]): unknown[] {
  const rawConfig = JSON.parse(
    readFileSync(join(root, ".agents", "plugins", "oma", "mcp_config.json"), "utf8"),
  ) as unknown;
  assert.ok(isRecord(rawConfig) && isRecord(rawConfig.mcpServers));
  const server = rawConfig.mcpServers["oma-broker"];
  assert.ok(isRecord(server) && typeof server.command === "string" && Array.isArray(server.args));
  const env: Record<string, string> = {};
  if (isRecord(server.env)) {
    for (const [key, value] of Object.entries(server.env)) env[key] = String(value);
  }
  const input = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
  const result = spawnSync(String(server.command), server.args.map(String), {
    cwd: typeof server.cwd === "string" ? server.cwd : root,
    // A read-only palette query must not kick off the memory drain: with a populated
    // staging journal the broker's autoDrain fires a live Flash (agy) call that keeps the
    // stdio server alive well past this probe's timeout. Draining is fire-and-forget in
    // production; here we only want to read the mission back.
    env: { ...process.env, ...env, OMA_AUTO_DRAIN: "off" },
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr ?? result.error?.message);
  return (result.stdout ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function resultFor(responses: unknown[], id: number): Record<string, unknown> {
  const response = responses.find((candidate) => isRecord(candidate) && candidate.id === id);
  assert.ok(isRecord(response) && isRecord(response.result));
  return response.result;
}

function initializeRequest(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oma-e2e", version: "1" } },
  };
}

function toolCall(id: number, name: string, args: unknown) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr ?? result.error?.message);
  return (result.stdout ?? "").trim();
}
