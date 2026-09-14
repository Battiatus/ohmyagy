import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "bun:test";

/**
 * The invariant this file exists to protect: **a session's project identity comes
 * from the host, never from the directory the editor happened to spawn us in.**
 *
 * Measured failure, 2026-09-14: AntiGravity spawns stdio MCP servers with cwd set
 * to its own installation directory. The broker's `OMA_WORKSPACE_ROOT || cwd`
 * fallback therefore gave every project one workspace, and the brain ended up with
 * a single `projects` row named "antigravity" holding both a Symap mission and an
 * unrelated session. These tests assert the replacement behaviour at the transport
 * level, where the fallback used to be decided.
 */

const brokerSource = fileURLToPath(new URL("../broker-server.ts", import.meta.url));

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

interface InteractiveBroker {
  request(id: number, method: string, params?: Record<string, unknown>): Promise<JsonRpcMessage>;
  stderr(): string;
  close(): void;
}

function makeEditorInstall(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-editor-install-"));
  mkdirSync(join(dir, "resources", "app"), { recursive: true });
  writeFileSync(join(dir, "Antigravity.exe"), "", "utf8");
  return dir;
}

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "oma-project-"));
}

/** Spawn the broker as the editor would, and answer the roots request as the host must. */
function startBroker(
  cwd: string,
  roots: readonly string[],
  options: { home?: string } = {},
): InteractiveBroker {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "OMA_WORKSPACE_ROOT" && value !== undefined) env[key] = value;
  }
  if (options.home !== undefined) {
    // `os.homedir()` follows USERPROFILE on Windows and HOME elsewhere; the broker
    // publishes its project into the registry under there.
    env.USERPROFILE = options.home;
    env.HOME = options.home;
  }
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [brokerSource], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const waiters = new Map<string | number, (message: JsonRpcMessage) => void>();
  const stderrLines: string[] = [];

  createInterface({ input: child.stderr }).on("line", (line) => stderrLines.push(line));
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.trim().length === 0) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.method === "roots/list" && message.id !== undefined) {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            roots: roots.map((root) => ({ uri: pathToFileURL(root).href, name: basename(root) })),
          },
        })}\n`,
      );
      return;
    }
    const waiter = message.id !== undefined ? waiters.get(message.id) : undefined;
    if (waiter !== undefined) {
      waiters.delete(message.id as string | number);
      waiter(message);
    }
  });

  return {
    request(id, method, params) {
      return new Promise<JsonRpcMessage>((settle) => {
        waiters.set(id, settle);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    stderr: () => stderrLines.join("\n"),
    close: () => child.kill(),
  };
}

function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: "2025-06-18",
    capabilities: { roots: { listChanged: false } },
    clientInfo: { name: "oma-roots-test", version: "1" },
  };
}

function cleanup(...dirs: readonly string[]): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may hold a short-lived lock on the SQLite file.
    }
  }
}

test("the host's roots decide the project, not the directory the editor used as cwd", { timeout: 120_000 }, async () => {
  const editorInstall = makeEditorInstall();
  const project = makeProject();
  const home = mkdtempSync(join(tmpdir(), "oma-home-"));
  const broker = startBroker(editorInstall, [project], { home });
  try {
    await broker.request(1, "initialize", initializeParams());
    // Sent immediately after initialize on purpose: the transport must not let a
    // tool call overtake the asynchronous workspace binding.
    const response = await broker.request(2, "tools/call", {
      name: "graph_init",
      arguments: { goal: "roots binding" },
    });
    assert.equal(
      response.error,
      undefined,
      `graph_init failed: ${response.error?.message ?? ""} :: ${broker.stderr()}`,
    );
    assert.equal(existsSync(join(project, ".oma", "graph", "execution-graph.json")), true);
    assert.equal(existsSync(join(editorInstall, ".oma")), false);

    // The resolved project must be published: capture attribution is decided against
    // the workspaces that really bound, so a silent bind would leave memory stuck.
    const registry = JSON.parse(
      readFileSync(join(home, ".oma", "workspaces.json"), "utf8"),
    ) as Array<{ root: string; source: string }>;
    assert.equal(registry.length, 1, `registry: ${JSON.stringify(registry)}`);
    assert.equal(registry[0].root, project);
    assert.equal(registry[0].source, "roots/list");
  } finally {
    broker.close();
    cleanup(project, editorInstall, home);
  }
});

test("an editor-install workspace with no host roots is refused, not silently used", { timeout: 120_000 }, async () => {
  const editorInstall = makeEditorInstall();
  const home = mkdtempSync(join(tmpdir(), "oma-home-"));
  const broker = startBroker(editorInstall, [], { home });
  try {
    await broker.request(1, "initialize", initializeParams());
    const refused = await broker.request(2, "tools/call", {
      name: "graph_init",
      arguments: { goal: "must not run" },
    });
    assert.equal(refused.error?.code, -32002);
    assert.match(refused.error?.message ?? "", /editor installation directory/u);
    assert.equal(existsSync(join(editorInstall, ".oma")), false);
    // A broker that only guessed its cwd has no project to publish. Registering the
    // install tree would put it into the set attribution is decided against.
    assert.equal(existsSync(join(home, ".oma", "workspaces.json")), false);

    // The escape hatch stays open: the cause must stay diagnosable.
    const doctor = await broker.request(3, "tools/call", { name: "doctor", arguments: {} });
    assert.equal(doctor.error, undefined, doctor.error?.message ?? "");
  } finally {
    broker.close();
    cleanup(editorInstall, home);
  }
});

test("several host roots are never resolved by guessing", { timeout: 120_000 }, async () => {
  const editorInstall = makeEditorInstall();
  const first = makeProject();
  const second = makeProject();
  const broker = startBroker(editorInstall, [first, second]);
  try {
    await broker.request(1, "initialize", initializeParams());
    const refused = await broker.request(2, "tools/call", {
      name: "graph_init",
      arguments: { goal: "ambiguous" },
    });
    assert.match(refused.error?.message ?? "", /editor installation directory/u);
    assert.match(broker.stderr(), /refusing to guess/u);
    assert.equal(existsSync(join(first, ".oma")), false);
    assert.equal(existsSync(join(second, ".oma")), false);
  } finally {
    broker.close();
    cleanup(first, second, editorInstall);
  }
});
