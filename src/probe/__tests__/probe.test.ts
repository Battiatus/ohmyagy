import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "bun:test";
import { validateHooksDocument } from "../../packaging/hook-contract.js";
import { appendProbeRecord, readProbeRecords } from "../log.js";
import { installProbe, mcpConfigStatesWorkspace, probeStatus, uninstallProbe } from "../install.js";
import { buildProbePluginDocuments, probeHookCommand, resolveProbeCommands } from "../plugin.js";
import { buildProbeReport, formatProbeReport } from "../report.js";
import { probeHookLogDir, probeMcpLogDir } from "../paths.js";

/**
 * What these tests protect.
 *
 * The probe exists because the previous answer to "one project or many" was announced
 * from green tests rather than from a measurement of the real host. So the probe itself
 * is held to the same standard it imposes: its `hooks.json` must be a document the host's
 * parser accepts, its `mcp_config.json` must state no workspace (or the measurement is
 * void), it must never write a secret, and its verdict logic must be pinned against
 * synthetic journals rather than against whatever the machine happens to contain.
 */

const probeMcpSource = fileURLToPath(new URL("../mcp-probe-server.ts", import.meta.url));
const probeHookSource = fileURLToPath(new URL("../hook-probe.ts", import.meta.url));

function tempHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function cleanup(...dirs: readonly string[]): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may hold a transient lock.
    }
  }
}

// --- plugin contract ---------------------------------------------------------------------

describe("probe plugin contract", () => {
  const commands = { hookPath: "C:/oma/hook-probe.js", mcpServerPath: "C:/oma/mcp-probe-server.js", nodePath: "C:/node/node.exe" };

  it("emits a hooks.json the host's parser accepts, on both events", () => {
    const documents = buildProbePluginDocuments(commands);
    const verdict = validateHooksDocument(documents.hooksJson);
    assert.equal(verdict.valid, true, JSON.stringify(verdict.problems));
    assert.deepEqual(verdict.events.sort(), ["PostToolUse", "PreToolUse"]);
    assert.deepEqual(verdict.hookNames.sort(), ["oma-probe-posttool", "oma-probe-pretool"]);
  });

  it("states no workspace in mcp_config.json, so the measurement stays honest", () => {
    const documents = buildProbePluginDocuments(commands);
    const definition = (documents.mcpConfig.mcpServers as Record<string, Record<string, unknown>>)["oma-probe"];
    assert.equal(definition.cwd, undefined);
    assert.equal(definition.env, undefined);
    assert.equal(mcpConfigStatesWorkspace(documents.mcpConfig), false);
    assert.equal(JSON.stringify(documents.mcpConfig).includes("WORKSPACE"), false);
  });

  it("detects a workspace statement when one is present, so the guard cannot be decorative", () => {
    assert.equal(
      mcpConfigStatesWorkspace({ mcpServers: { oma: { command: "node", env: { OMA_WORKSPACE_ROOT: "C:/p" } } } }),
      true,
    );
    assert.equal(mcpConfigStatesWorkspace({ mcpServers: { oma: { command: "node", cwd: "C:/p" } } }), true);
  });

  it("refuses a hook command whose path contains a space, because the runner mangles quotes", () => {
    assert.throws(() => probeHookCommand(["C:/node/node.exe", "C:/Program Files/oma/hook.js"]), /space/u);
    assert.equal(probeHookCommand(["C:\\node\\node.exe", "C:\\oma\\hook.js"]), "C:/node/node.exe C:/oma/hook.js");
  });

  it("resolves the built probe scripts from this checkout", () => {
    const resolved = resolveProbeCommands();
    assert.equal(existsSync(resolved.hookPath), true);
    assert.equal(existsSync(resolved.mcpServerPath), true);
  });
});

// --- installer ---------------------------------------------------------------------------

describe("probe installer", () => {
  it("installs, reports, backs up the files it overwrites, and removes only its own directory", () => {
    const pluginsRoot = tempHome("oma-probe-plugins");
    const home = tempHome("oma-probe-home");
    const commands = { hookPath: "C:/oma/hook-probe.js", mcpServerPath: "C:/oma/mcp-probe-server.js", nodePath: "C:/node/node.exe" };
    try {
      const sibling = join(pluginsRoot, "oma");
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, "hooks.json"), "{}\n", "utf8");

      const first = installProbe({ pluginsRoot, commands });
      assert.equal(existsSync(join(first.pluginDir, "hooks.json")), true);
      assert.equal(existsSync(join(first.pluginDir, "mcp_config.json")), true);
      assert.equal(first.hooksValid, true);
      assert.equal(first.mcpConfigStatesWorkspace, false);
      assert.deepEqual(first.backedUpFiles, [], "a first install overwrites nothing");

      // A second install must preserve what it replaces. The editor holds this directory
      // open while running, so renaming it aside fails with EBUSY: per-file backups are
      // the only shape that works on a live host.
      const before = readFileSync(join(first.pluginDir, "hooks.json"), "utf8");
      const second = installProbe({ pluginsRoot, commands });
      assert.equal(second.backedUpFiles.length, 3);
      assert.equal(readFileSync(`${join(second.pluginDir, "hooks.json")}.bak`, "utf8"), before);
      assert.equal(existsSync(join(sibling, "hooks.json")), true, "the real OMA plugin must be untouched");

      const status = probeStatus({ pluginsRoot, homeDirectory: home });
      assert.equal(status.installed, true);
      assert.equal(status.hooksValid, true);
      assert.equal(status.mcpConfigStatesWorkspace, false);

      const removed = uninstallProbe({ pluginsRoot, homeDirectory: home });
      assert.equal(removed.removed, true);
      assert.equal(existsSync(join(pluginsRoot, "oma-probe")), false);
      assert.equal(existsSync(sibling), true);
    } finally {
      cleanup(pluginsRoot, home);
    }
  });
});

// --- MCP probe over the real transport ---------------------------------------------------

interface ProbeOutcome {
  initialize: Record<string, unknown>;
  requestedRoots: boolean;
  pingResult: Record<string, unknown> | undefined;
  logs: ReturnType<typeof readProbeRecords>;
}

async function runProbeMcp(home: string, options: { advertiseRoots: boolean; roots: string[] }): Promise<ProbeOutcome> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [probeMcpSource], {
    cwd: tmpdir(),
    env: { ...process.env, OMA_PROBE_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const waiters = new Map<string | number, (message: Record<string, unknown>) => void>();
  let requestedRoots = false;
  let initialize: Record<string, unknown> = {};
  let pingResult: Record<string, unknown> | undefined;

  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.trim().length === 0) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.method === "roots/list" && message.id !== undefined) {
      requestedRoots = true;
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { roots: options.roots.map((root) => ({ uri: pathToFileURL(root).href, name: "root" })) },
        })}\n`,
      );
      return;
    }
    const id = message.id;
    const waiter = id !== undefined ? waiters.get(id as string | number) : undefined;
    if (waiter !== undefined) {
      waiters.delete(id as string | number);
      waiter(message);
    }
  });

  const request = (id: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((settle) => {
      waiters.set(id, settle);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: options.advertiseRoots ? { roots: { listChanged: false } } : {},
      clientInfo: { name: "oma-probe-test", version: "1" },
    });
    initialize = (initialized.result as Record<string, unknown>) ?? {};
    if (options.advertiseRoots) {
      // Give the server's own roots/list request time to be answered before the ping.
      await new Promise((settle) => setTimeout(settle, 300));
    }
    const pinged = await request(2, "tools/call", { name: "oma_probe_ping", arguments: {} });
    const result = (pinged.result as Record<string, unknown>) ?? {};
    pingResult = (result.structuredContent as Record<string, unknown>) ?? undefined;
    await new Promise((settle) => setTimeout(settle, 150));
  } finally {
    child.kill();
  }

  return { initialize, requestedRoots, pingResult, logs: readProbeRecords(probeMcpLogDir(home)) };
}

describe("probe MCP server", () => {
  it("records its own identity, asks roots/list, and survives the host answering", async () => {
    const home = tempHome("oma-probe-mcp");
    const project = tempHome("oma-probe-project");
    try {
      const outcome = await runProbeMcp(home, { advertiseRoots: true, roots: [project] });
      assert.equal((outcome.initialize.serverInfo as Record<string, unknown>).name, "oma-probe");
      assert.equal(outcome.requestedRoots, true);

      const start = outcome.logs.find((record) => record.kind === "process_start");
      assert.ok(start, "a process_start record must exist");
      assert.equal(typeof start?.data.pid, "number");
      assert.equal(String(start?.data.cwd).length > 0, true);
      assert.ok(Array.isArray(start?.data.envKeys));

      const reply = outcome.logs.find((record) => record.kind === "roots_reply");
      assert.ok(reply, "the host's answer must be recorded");
      assert.equal(reply?.data.answered, true);
      assert.equal(reply?.data.rootCount, 1);
      assert.equal(outcome.pingResult?.rootsSeen instanceof Array, true);
    } finally {
      cleanup(home, project);
    }
  });

  it("records that no roots capability was advertised instead of pretending to ask", async () => {
    const home = tempHome("oma-probe-mcp-noroots");
    try {
      const outcome = await runProbeMcp(home, { advertiseRoots: false, roots: [] });
      assert.equal(outcome.requestedRoots, false);
      assert.ok(outcome.logs.some((record) => record.kind === "roots_skipped"));
      assert.equal(outcome.logs.some((record) => record.kind === "roots_request"), false);
    } finally {
      cleanup(home);
    }
  });

  it("never writes a forwarded secret to its journal", async () => {
    const home = tempHome("oma-probe-secrets");
    const child = spawn(process.execPath, [probeMcpSource], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        OMA_PROBE_HOME: home,
        GEMINI_API_KEY: "AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    try {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } })}\n`,
      );
      await new Promise((settle) => setTimeout(settle, 400));
    } finally {
      child.kill();
    }
    const raw = readdirSync(probeMcpLogDir(home))
      .map((name) => readFileSync(join(probeMcpLogDir(home), name), "utf8"))
      .join("\n");
    assert.equal(raw.includes("AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), false);
    assert.equal(raw.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), false);
    cleanup(home);
  });
});

// --- hook probe --------------------------------------------------------------------------

async function runHookSubprocess(event: string, payload: unknown, home: string): Promise<{ stdout: string }> {
  const child = spawn(process.execPath, [probeHookSource, event], {
    cwd: tmpdir(),
    env: { ...process.env, OMA_PROBE_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
  await new Promise<void>((settle) => child.on("close", () => settle()));
  return { stdout };
}

describe("probe hook", () => {
  const payload = {
    conversationId: "conv-probe-1",
    stepIdx: 4,
    toolCall: { name: "view_file", args: { AbsolutePath: "C:/p/src/a.ts" } },
    workspacePaths: ["C:/p"],
  };

  it("emits the exact per-event output shapes the host accepts", async () => {
    const home = tempHome("oma-probe-hook");
    try {
      const pre = await runHookSubprocess("PreToolUse", payload, home);
      const preDecoded = JSON.parse(pre.stdout.trim()) as Record<string, unknown>;
      assert.equal(preDecoded.decision, "allow");
      assert.match(String(preDecoded.reason), /observation only/u);

      const post = await runHookSubprocess("PostToolUse", payload, home);
      assert.equal(post.stdout.trim(), "{}");

      const records = readProbeRecords(probeHookLogDir(home));
      assert.equal(records.length, 2);
      const invocation = records[0].data;
      assert.equal(invocation.conversationId, "conv-probe-1");
      assert.deepEqual(invocation.workspacePaths, ["C:/p"]);
      assert.equal(invocation.hasWorkspacePaths, true);
      assert.equal(invocation.toolName, "view_file");
      assert.equal(invocation.event, "PreToolUse");
      assert.deepEqual(invocation.payloadKeys, ["conversationId", "stepIdx", "toolCall", "workspacePaths"]);
    } finally {
      cleanup(home);
    }
  });
});

// --- report ------------------------------------------------------------------------------

function writeFakeInstance(
  home: string,
  options: {
    file: string;
    pid: number;
    cwd: string;
    env?: Record<string, string>;
    roots?: string[];
    answered?: boolean;
    parentCommandLine?: string;
    startedAt: string;
    exitedAt?: string;
  },
): void {
  const target = { dir: probeMcpLogDir(home), file: options.file };
  const start = new Date(options.startedAt);
  const at = (offsetMs: number): Date => new Date(start.getTime() + offsetMs);
  appendProbeRecord(
    target,
    "process_start",
    {
      pid: options.pid,
      ppid: options.pid + 1,
      cwd: options.cwd,
      argv: ["node", "mcp-probe-server.js"],
      envKeys: ["PATH"],
      env: options.env ?? { PATH: "C:/bin" },
    },
    start,
  );
  if (options.parentCommandLine !== undefined) {
    appendProbeRecord(
      target,
      "parent_process",
      { pid: options.pid + 1, commandLine: options.parentCommandLine },
      at(10),
    );
  }
  if (options.roots !== undefined) {
    appendProbeRecord(target, "roots_request", { id: "r1", reason: "after-initialize" }, at(1_000));
    appendProbeRecord(
      target,
      "roots_reply",
      {
        id: "r1",
        reason: "after-initialize",
        answered: options.answered ?? true,
        elapsedMs: 5,
        rootCount: options.roots.length,
        roots: options.roots,
      },
      at(1_100),
    );
  }
  appendProbeRecord(target, "heartbeat", { pid: options.pid }, at(2_000));
  if (options.exitedAt !== undefined) {
    appendProbeRecord(target, "process_exit", { pid: options.pid, uptimeMs: 1_000 }, new Date(options.exitedAt));
  }
}

function writeFakeHook(home: string, options: { file: string; event: string; workspacePaths: string[]; conversationId?: string }): void {
  appendProbeRecord(
    { dir: probeHookLogDir(home), file: options.file },
    "hook_invocation",
    {
      pid: 900,
      ppid: 901,
      cwd: "C:/Users/x/.gemini/config/plugins/oma-probe",
      event: options.event,
      workspacePaths: options.workspacePaths,
      conversationId: options.conversationId ?? "conv-1",
      payloadKeys: ["conversationId", "toolCall", "workspacePaths"],
    },
  );
}

describe("probe report", () => {
  it("concludes host-roots when the handshake answered with a root", () => {
    const home = tempHome("oma-probe-report-roots");
    try {
      writeFakeInstance(home, {
        file: "100.jsonl",
        pid: 100,
        cwd: "C:/Users/x/AppData/Local/Programs/Antigravity IDE",
        roots: ["file:///C:/p"],
        startedAt: "2026-09-16T10:00:00.000Z",
      });
      const report = buildProbeReport({ homeDirectory: home });
      assert.equal(report.verdict.channel, "host-roots");
      assert.equal(report.mcp.instanceCount, 1);
      assert.equal(report.mcp.spawnModel, "single-shared");
      assert.equal(report.mcp.rootsAnswered, 1);
      assert.ok(formatProbeReport(report).includes("host-roots"));
    } finally {
      cleanup(home);
    }
  });

  it("concludes host-environment when an instance carries a project signal of its own", () => {
    const home = tempHome("oma-probe-report-env");
    try {
      writeFakeInstance(home, {
        file: "101.jsonl",
        pid: 101,
        cwd: "C:/ide",
        env: { WORKSPACE_ROOT: "C:/project-a" },
        answered: false,
        roots: [],
        startedAt: "2026-09-16T10:00:00.000Z",
      });
      const report = buildProbeReport({ homeDirectory: home });
      assert.equal(report.verdict.channel, "host-environment");
      assert.equal(report.mcp.rootsAnswered, 0);
    } finally {
      cleanup(home);
    }
  });

  it("never reads OMA's own OMA_WORKSPACE_ROOT as a host statement", () => {
    const home = tempHome("oma-probe-report-selfpin");
    try {
      // Measured: one broker-test fixture left `OMA_WORKSPACE_ROOT` in the environment of a
      // probe server, and an earlier verdict read it as the host naming a project. It is
      // OMA's own pin — the defect under measurement, not evidence against it.
      writeFakeInstance(home, {
        file: "107.jsonl",
        pid: 107,
        cwd: "C:/ide",
        env: { OMA_WORKSPACE_ROOT: "C:/Users/x/AppData/Local/Temp/oma-mcp-test-fixture/repo" },
        roots: [],
        answered: false,
        startedAt: "2026-09-16T10:00:00.000Z",
      });
      writeFakeHook(home, { file: "h1.jsonl", event: "PreToolUse", workspacePaths: ["C:/project-a"] });
      const report = buildProbeReport({ homeDirectory: home });
      assert.deepEqual(report.mcp.projectEnvSignals, []);
      assert.equal(report.mcp.selfInflictedEnvSignals.length, 1);
      assert.equal(report.verdict.channel, "hook-channel-only");
    } finally {
      cleanup(home);
    }
  });

  it("concludes hook-channel-only when the hooks state the workspace and the server is given nothing", () => {
    const home = tempHome("oma-probe-report-hooks");
    try {
      writeFakeInstance(home, {
        file: "102.jsonl",
        pid: 102,
        cwd: "C:/ide",
        roots: [],
        answered: false,
        startedAt: "2026-09-16T10:00:00.000Z",
      });
      writeFakeHook(home, { file: "h1.jsonl", event: "PostToolUse", workspacePaths: ["C:/project-a"] });
      writeFakeHook(home, { file: "h2.jsonl", event: "PreToolUse", workspacePaths: ["C:/project-a"] });
      writeFakeHook(home, { file: "h3.jsonl", event: "PreToolUse", workspacePaths: [] });
      const report = buildProbeReport({ homeDirectory: home });
      assert.equal(report.verdict.channel, "hook-channel-only");
      assert.equal(report.hooks.invocationCount, 3);
      assert.equal(report.hooks.withWorkspacePaths, 2);
      assert.equal(report.hooks.byEvent.PreToolUse?.withWorkspacePaths, 1);
      assert.equal(report.hooks.distinctWorkspaces[0], "C:/project-a");
      assert.equal(report.correlation.intersection.length, 0);
    } finally {
      cleanup(home);
    }
  });

  it("concludes no-channel when nothing anywhere states a project", () => {
    const home = tempHome("oma-probe-report-none");
    try {
      writeFakeInstance(home, {
        file: "103.jsonl",
        pid: 103,
        cwd: "C:/ide",
        roots: [],
        answered: false,
        startedAt: "2026-09-16T10:00:00.000Z",
      });
      writeFakeHook(home, { file: "h1.jsonl", event: "PreToolUse", workspacePaths: [] });
      const report = buildProbeReport({ homeDirectory: home });
      assert.equal(report.verdict.channel, "no-channel");
      assert.equal(report.verdict.multiplexingRequired, true);
    } finally {
      cleanup(home);
    }
  });

  it("refuses to read a project out of an unrelated parent-command-line path", () => {
    const home = tempHome("oma-probe-report-parent");
    try {
      writeFakeInstance(home, {
        file: "104.jsonl",
        pid: 104,
        cwd: "C:/ide",
        roots: [],
        answered: false,
        // An editor command line carries plenty of absolute paths. None of them is a project.
        parentCommandLine: "C:/ide/Antigravity.exe --extensions-dir C:/ide/extensions --log C:/logs",
        startedAt: "2026-09-16T10:00:00.000Z",
      });
      writeFakeHook(home, { file: "h1.jsonl", event: "PreToolUse", workspacePaths: ["C:/project-a"] });
      const report = buildProbeReport({ homeDirectory: home });
      assert.equal(report.verdict.channel, "hook-channel-only");
      assert.ok(report.mcp.instances[0].parentPaths.length > 0, "the paths are still evidence, just not a verdict");
    } finally {
      cleanup(home);
    }
  });

  it("accepts a parent-command-line path only when the hooks state the same workspace", () => {
    const home = tempHome("oma-probe-report-parent-match");
    try {
      writeFakeInstance(home, {
        file: "105.jsonl",
        pid: 105,
        cwd: "C:/ide",
        roots: [],
        answered: false,
        parentCommandLine: "C:/ide/Antigravity.exe --folder C:/project-a",
        startedAt: "2026-09-16T10:00:00.000Z",
      });
      writeFakeHook(home, { file: "h1.jsonl", event: "PreToolUse", workspacePaths: ["C:/project-a"] });
      const report = buildProbeReport({ homeDirectory: home });
      assert.equal(report.verdict.channel, "host-environment");
      assert.match(report.verdict.statement, /parent command line/u);
      assert.deepEqual(report.correlation.intersection, ["C:/project-a"]);
    } finally {
      cleanup(home);
    }
  });

  it("does not mistake an environment key that merely contains ROOT for project identity", () => {
    const home = tempHome("oma-probe-report-envnoise");
    try {
      // Observed verbatim on the real host: these keys are identical in every instance and
      // name nothing. An earlier version of this verdict read them as a project signal and
      // announced `host-environment` — the exact class of guess that produced the pin.
      writeFakeInstance(home, {
        file: "106.jsonl",
        pid: 106,
        cwd: "C:/Users/x/.gemini/config/plugins/oma-probe",
        env: {
          COREPACK_ROOT: "C:/Users/x/AppData/Local/nvm/v24.16.0/node_modules/corepack",
          PLUGIN_ROOT: "C:/Users/x/.gemini/config/plugins/oma-probe",
          INIT_CWD: "C:/Users/x/Documents/Repos/plugins/ohmyagy",
          SESSIONNAME: "Console",
        },
        roots: [],
        answered: false,
        startedAt: "2026-09-16T10:00:00.000Z",
      });
      writeFakeHook(home, { file: "h1.jsonl", event: "PreToolUse", workspacePaths: ["C:/project-a"] });
      const report = buildProbeReport({ homeDirectory: home });
      assert.deepEqual(report.mcp.projectEnvSignals, []);
      assert.equal(report.verdict.channel, "hook-channel-only");
      assert.ok(
        report.mcp.instances[0].envWorkspaceHints.some((hint) => hint.key === "COREPACK_ROOT"),
        "the raw evidence is still recorded — it just does not decide the verdict",
      );
    } finally {
      cleanup(home);
    }
  });

  it("distinguishes per-window spawns from a shared server, and diffs their environments", () => {
    const home = tempHome("oma-probe-report-spawn");
    try {
      writeFakeInstance(home, {
        file: "200.jsonl",
        pid: 200,
        cwd: "C:/window-a",
        env: { OMA_TEST_MARKER: "a" },
        startedAt: "2026-09-16T10:00:00.000Z",
        exitedAt: "2026-09-16T10:10:00.000Z",
      });
      writeFakeInstance(home, {
        file: "201.jsonl",
        pid: 201,
        cwd: "C:/window-b",
        env: { OMA_TEST_MARKER: "b" },
        startedAt: "2026-09-16T10:05:00.000Z",
        exitedAt: "2026-09-16T10:20:00.000Z",
      });
      const report = buildProbeReport({ homeDirectory: home });
      assert.equal(report.mcp.instanceCount, 2);
      assert.equal(report.mcp.spawnModel, "per-window-with-cwd");
      assert.equal(report.verdict.multiplexingRequired, false);
      assert.deepEqual(report.mcp.distinctCwds, ["C:/window-a", "C:/window-b"]);
      assert.equal(report.mcp.overlappingLifetimes, true);
      assert.equal(report.mcp.concurrentPeak, 2);
      const diff = report.mcp.perInstanceEnvKeys.find((entry) => entry.key === "OMA_TEST_MARKER");
      assert.deepEqual(diff?.values, ["a", "b"]);
    } finally {
      cleanup(home);
    }
  });

  it("recognises a cold spawn per query, where no process outlives a single request", () => {
    const home = tempHome("oma-probe-report-cold");
    try {
      // The measured shape on this host: one short-lived server per discovery, two seconds
      // each, one handoff at most. This is neither a shared server nor one per window.
      for (let index = 0; index < 5; index += 1) {
        const startedAt = new Date(Date.parse("2026-09-16T10:00:00.000Z") + index * 30_000);
        writeFakeInstance(home, {
          file: `40${index}.jsonl`,
          pid: 400 + index,
          cwd: "C:/Users/x/.gemini/config/plugins/oma-probe",
          roots: [],
          answered: false,
          startedAt: startedAt.toISOString(),
          exitedAt: new Date(startedAt.getTime() + 2_000).toISOString(),
        });
      }
      const report = buildProbeReport({ homeDirectory: home });
      assert.equal(report.mcp.spawnModel, "per-query-cold-spawn");
      assert.equal(report.mcp.medianLifetimeMs, 2_000);
      assert.equal(report.verdict.multiplexingRequired, true);
    } finally {
      cleanup(home);
    }
  });

  it("reports per-instance indistinguishable spawns as still requiring multiplexing", () => {
    const home = tempHome("oma-probe-report-identical");
    try {
      for (const pid of [300, 301]) {
        writeFakeInstance(home, {
          file: `${pid}.jsonl`,
          pid,
          cwd: "C:/Users/x/AppData/Local/Programs/Antigravity IDE",
          roots: [],
          answered: false,
          startedAt: `2026-09-16T10:0${pid - 300}:00.000Z`,
        });
      }
      const report = buildProbeReport({ homeDirectory: home });
      assert.equal(report.mcp.spawnModel, "per-window-indistinguishable");
      assert.equal(report.verdict.multiplexingRequired, true);
      assert.match(report.mcp.spawnModelEvidence, /nothing distinguishes/u);
    } finally {
      cleanup(home);
    }
  });
});
