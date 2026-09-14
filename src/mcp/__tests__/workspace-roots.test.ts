import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "bun:test";
import { openDatabase } from "../../brain/sqlite-adapter.js";
import { appendStagedRecord } from "../../brain/agy-capture.js";
import { bindConversation, readRegisteredWorkspaces } from "../../brain/workspace-registry.js";

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
  options: { home?: string; env?: Record<string, string> } = {},
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
  Object.assign(env, options.env ?? {});
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

interface BrainSummary {
  projects: number;
  sessions: number;
  roots: string[];
  sessionIds: string[];
}

/** Read a Brain through the cross-runtime adapter: `node:sqlite` is not resolvable under `bun test --isolate`. */
function readBrain(brainPath: string): BrainSummary {
  const db = openDatabase(brainPath);
  try {
    const roots = db
      .prepare("SELECT root_path FROM projects")
      .all<{ root_path: string }>()
      .map((row) => row.root_path);
    const sessionIds = db
      .prepare("SELECT id FROM sessions")
      .all<{ id: string }>()
      .map((row) => row.id);
    return { projects: roots.length, sessions: sessionIds.length, roots, sessionIds };
  } finally {
    db.close();
  }
}

/** Wait until the automatic drain has persisted `expected` sessions in this project. */
async function waitForSessions(
  brainPath: string,
  expected: number,
  stderr: () => string,
): Promise<BrainSummary> {
  const deadline = Date.now() + 120_000;
  let last: BrainSummary = { projects: 0, sessions: 0, roots: [], sessionIds: [] };
  while (Date.now() < deadline) {
    if (existsSync(brainPath)) {
      try {
        last = readBrain(brainPath);
        if (last.sessions >= expected) return last;
      } catch {
        // The file exists but is not yet readable as a database.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(
    `expected ${expected} session(s) in ${brainPath}, saw ${last.sessions}; stderr: ${stderr()}`,
  );
}

/**
 * Capture one exchange for `project` under a throwaway home, bound to that project.
 * This is the state the drain has to work from in production.
 */
function stageBoundConversation(
  home: string,
  project: string,
  conversationId: string,
): void {
  const transcriptPath = join(project, "transcript_full.jsonl");
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "USER_INPUT", step_index: 1, content: "Quel est le statut ?" }),
      JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 2, thinking: "j'inspecte les bases" }),
    ].join("\n") + "\n",
    "utf8",
  );
  appendStagedRecord(
    {
      at: new Date().toISOString(),
      conversationId,
      stepIdx: 2,
      tool: "view_file",
      failed: false,
      paths: [join(project, "a.ts")],
      workspacePaths: [],
      transcriptPath,
    },
    home,
  );
  bindConversation({
    conversationId,
    workspaceRoot: project,
    source: "test",
    homeDirectory: home,
  });
}

/** A deliberately unknown model keeps these tests free of a real model call. */
const NO_MODEL: Record<string, string> = { OMA_FLASH_MODEL: "definitely-not-a-model" };

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
    const registry = readRegisteredWorkspaces(home);
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
    assert.deepEqual(readRegisteredWorkspaces(home), []);

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

test("the capture journal is folded into the project automatically once roots bind", { timeout: 180_000 }, async () => {
  const editorInstall = makeEditorInstall();
  const project = makeProject();
  const home = mkdtempSync(join(tmpdir(), "oma-home-"));
  stageBoundConversation(home, project, "conv-autodrain");

  const broker = startBroker(editorInstall, [project], { home, env: NO_MODEL });
  try {
    await broker.request(1, "initialize", initializeParams());
    const summary = await waitForSessions(
      join(project, ".oma", "brain.sqlite"),
      1,
      broker.stderr,
    );
    assert.equal(summary.projects, 1, `expected one project; stderr: ${broker.stderr()}`);
    assert.equal(summary.roots.length, 1, `project root: ${summary.roots.join(", ")}`);
  } finally {
    broker.close();
    cleanup(project, editorInstall, home);
  }
});

test("two projects each get their own brain and never share a session", { timeout: 240_000 }, async () => {
  const editorInstall = makeEditorInstall();
  const home = mkdtempSync(join(tmpdir(), "oma-home-"));
  const projectA = makeProject();
  const projectB = makeProject();
  stageBoundConversation(home, projectA, "conv-project-a");
  stageBoundConversation(home, projectB, "conv-project-b");

  const brokerA = startBroker(editorInstall, [projectA], { home, env: NO_MODEL });
  const brokerB = startBroker(editorInstall, [projectB], { home, env: NO_MODEL });
  const brainA = join(projectA, ".oma", "brain.sqlite");
  const brainB = join(projectB, ".oma", "brain.sqlite");
  try {
    await brokerA.request(1, "initialize", initializeParams());
    await brokerB.request(1, "initialize", initializeParams());

    const summaryA = await waitForSessions(brainA, 1, brokerA.stderr);
    const summaryB = await waitForSessions(brainB, 1, brokerB.stderr);

    // Each project owns exactly one project row, pointing at its own root.
    assert.equal(summaryA.projects, 1);
    assert.equal(summaryB.projects, 1);
    assert.equal(samePath(summaryA.roots[0], projectA), true, summaryA.roots.join(", "));
    assert.equal(samePath(summaryB.roots[0], projectB), true, summaryB.roots.join(", "));

    // And no session is shared: this is the isolation the whole Brain design rests on.
    assert.equal(summaryA.sessionIds.length, 1);
    assert.equal(summaryB.sessionIds.length, 1);
    assert.notEqual(summaryA.sessionIds[0], summaryB.sessionIds[0]);
    assert.equal(existsSync(brainA), true);
    assert.equal(existsSync(brainB), true);

    // The registry knows both projects, so later attribution has a bounded set to
    // decide against instead of "does this touch my root". Two brokers publish
    // concurrently, which is why each root gets its own file.
    const registry = readRegisteredWorkspaces(home);
    assert.equal(registry.length, 2, JSON.stringify(registry));
    assert.deepEqual(
      registry.map((entry) => entry.source),
      ["roots/list", "roots/list"],
    );
  } finally {
    brokerA.close();
    brokerB.close();
    cleanup(projectA, projectB, editorInstall, home);
  }
});

function samePath(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const normalize = (value: string): string =>
    process.platform === "win32" ? resolve(value).toLocaleLowerCase("en-US") : resolve(value);
  return normalize(left) === normalize(right);
}
