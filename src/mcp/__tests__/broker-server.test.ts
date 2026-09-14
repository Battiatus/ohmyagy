import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "bun:test";
import { contentHash } from "../../broker/transaction.js";
import { isRecord } from "../../ledger/canonical.js";
import { installWorkspacePlugin } from "../../packaging/install.js";

test("installs Antigravity plugin, exposes complete 2PC MCP tools, and enforces 2-Phase Commit lifecycle", { timeout: 60000 }, () => {
  const fixture = createRepository(false);
  try {
    const installed = installWorkspacePlugin(fixture.root, {
      gates: [nodeGate("pass", "process.exit(0)")],
    });
    assert.equal(existsSync(join(installed.pluginDir, "plugin.json")), true);
    assert.equal(existsSync(join(installed.pluginDir, "hooks.json")), true);
    assert.equal(existsSync(join(installed.pluginDir, "mcp_config.json")), true);
    assert.equal(existsSync(join(installed.pluginDir, "commands", "start.md")), true);
    assert.equal(existsSync(join(installed.pluginDir, "commands", "run.md")), false);
    const combined = ["hooks.json", "mcp_config.json", "gates.json"]
      .map((name) => readFileSync(join(installed.pluginDir, name), "utf8"))
      .join("\n");
    assert.equal(combined.includes("__OMA_"), false);
    const hooks = JSON.parse(
      readFileSync(join(installed.pluginDir, "hooks.json"), "utf8"),
    ) as Record<string, { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }>;
    const hookCommand = hooks["oma-strict-write-gate"].PreToolUse[0].hooks[0].command;
    assert.equal(hookCommand.includes('"'), false);
    assert.equal(hookCommand.includes("\\"), false);
    assert.equal(isAbsolute(installed.hookPath), true);
    assert.equal(isAbsolute(installed.mcpServerPath), true);
    commitAll(fixture.root, "fixture with plugin");
    const parent = git(fixture.root, ["rev-parse", "HEAD"]);

    // 1. Initialize and list tools
    const responses1 = runMcp(fixture.root, [
      initializeRequest(1),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    const listed = resultFor(responses1, 2);
    assert.ok(Array.isArray(listed.tools));
    assert.equal(listed.tools.length, 26);
    const toolNames = listed.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(toolNames, [
      "attest_review",
      "brain_compact",
      "brain_query",
      "brain_store",
      "brain_summarize",
      "converge_status",
      "converge_step",
      "dispatch_node",
      "doctor",
      "graph_apply",
      "graph_init",
      "graph_inspect",
      "graph_mark_node",
      "graph_propose",
      "graph_ready_nodes",
      "graph_replan",
      "list_missions",
      "mission_inspect",
      "mission_status",
      "plan_route",
      "project_model",
      "promote_change",
      "propose_change",
      "record_interview",
      "resume_mission",
      "run_mission",
    ]);


    // 2. Propose change -> returns staged_pending_review without modifying HEAD
    const responses2 = runMcp(fixture.root, [
      initializeRequest(1),
      toolCall(2, "propose_change", {
        schemaVersion: 1,
        parentVersion: parent,
        operations: [
          { kind: "write", path: "a.txt", baseHash: contentHash("old"), content: "new" },
        ],
      }),
    ]);
    const proposeResult = resultFor(responses2, 2);
    assert.ok(isRecord(proposeResult.structuredContent));
    assert.equal(
      proposeResult.structuredContent.status,
      "staged_pending_review",
      JSON.stringify(proposeResult.structuredContent),
    );
    assert.equal(proposeResult.isError, false);
    const txId = String(proposeResult.structuredContent.transactionId);
    const stagedDiffDigest = String(proposeResult.structuredContent.stagedDiffDigest);
    assert.ok(txId);
    assert.ok(stagedDiffDigest);

    // Repository root is untouched after propose_change
    assert.equal(readFileSync(join(fixture.root, "a.txt"), "utf8"), "old");
    assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), parent);
    assert.equal(git(fixture.root, ["status", "--porcelain=v1"]), "");

    // 3. Full 2PC commit through stdio session: propose -> attest -> promote
    const responses3 = runMcp(fixture.root, [
      initializeRequest(1),
      toolCall(2, "propose_change", {
        schemaVersion: 1,
        parentVersion: parent,
        operations: [
          { kind: "write", path: "a.txt", baseHash: contentHash("old"), content: "new" },
        ],
      }),
      // Attempt unreviewed promotion -> must be rejected
      toolCall(3, "promote_change", {
        transactionId: txId,
      }),
      // Independent reviewer attestation (Author != Reviewer)
      toolCall(4, "attest_review", {
        transactionId: txId,
        stagedDiffDigest,
        reviewerRunKey: "run-reviewer-1",
        reviewerExpertId: "oma-reviewer",
        verdict: "approved",
      }),
      // Promotion after valid review -> must succeed
      toolCall(5, "promote_change", {
        transactionId: txId,
      }),
    ]);

    // Check unreviewed promotion rejection
    const unreviewedResult = resultFor(responses3, 3);
    assert.ok(isRecord(unreviewedResult.structuredContent));
    assert.equal(unreviewedResult.structuredContent.status, "rejected");
    assert.equal(unreviewedResult.isError, true);

    // Check review attestation
    const attestResult = resultFor(responses3, 4);
    assert.ok(isRecord(attestResult.structuredContent));
    assert.equal(attestResult.structuredContent.status, "review_attested");
    assert.equal(attestResult.structuredContent.reviewerVerdict, "approved");
    assert.equal(attestResult.isError, false);

    // Check promotion
    const promoteResult = resultFor(responses3, 5);
    assert.ok(isRecord(promoteResult.structuredContent));
    assert.equal(
      promoteResult.structuredContent.status,
      "promoted",
      JSON.stringify(promoteResult.structuredContent),
    );
    assert.equal(promoteResult.isError, false);

    // HEAD is now updated and content on disk is "new"
    assert.equal(readFileSync(join(fixture.root, "a.txt"), "utf8"), "new");
    assert.notEqual(git(fixture.root, ["rev-parse", "HEAD"]), parent);
    assert.equal(git(fixture.root, ["status", "--porcelain=v1"]), "");
  } finally {
    removeTree(fixture.container);
  }
});

test("run_mission and resume_mission operate session-natively without detached processes", () => {
  const fixture = createRepository(false);
  try {
    installWorkspacePlugin(fixture.root, { gates: [nodeGate("pass", "process.exit(0)")] });
    commitAll(fixture.root, "fixture with plugin");

    const responses = runMcp(fixture.root, [
      initializeRequest(1),
      toolCall(2, "run_mission", { goal: "Start session-native mission." }),
      toolCall(3, "resume_mission", {}),
      toolCall(4, "resume_mission", { missionId: "nonexistent-mission" }),
    ]);
    const launched = resultFor(responses, 2);
    assert.equal(launched.isError, false);
    assert.ok(isRecord(launched.structuredContent));
    assert.equal(launched.structuredContent.status, "started");
    assert.equal(launched.structuredContent.mode, "session-native");
    assert.equal(launched.structuredContent.pid, undefined);
    const missionId = String(launched.structuredContent.missionId);
    assert.match(missionId, /^oma-\d+$/u);

    // Detached ghost processes eliminated: no launcher.log exists
    const launcherLog = join(fixture.root, ".oma", "missions", missionId, "launcher.log");
    assert.equal(existsSync(launcherLog), false);

    // Durable journal event initialized for in-session orchestration
    const eventsPath = join(fixture.root, ".oma", "missions", missionId, "events.jsonl");
    assert.equal(existsSync(eventsPath), true);

    // resume_mission confirms in-session resumption without detached spawn
    const resumed = resultFor(responses, 3);
    assert.equal(resumed.isError, false);
    assert.ok(isRecord(resumed.structuredContent));
    assert.equal(resumed.structuredContent.status, "resumed");
    assert.equal(resumed.structuredContent.mode, "session-native");
    assert.equal(resumed.structuredContent.missionId, missionId);

    // resume_mission rejects unknown mission id
    const nonExistent = resultFor(responses, 4);
    assert.equal(nonExistent.isError, true);
    assert.match(nonExistent.content?.[0]?.text ?? "", /Mission 'nonexistent-mission' was not found/);
  } finally {
    removeTree(fixture.container);
  }
});

test("observability tools report workspace state without an active mission", () => {
  const fixture = createRepository(false);
  try {
    installWorkspacePlugin(fixture.root, { gates: [nodeGate("pass", "process.exit(0)")] });

    const responses = runMcp(fixture.root, [
      initializeRequest(1),
      toolCall(2, "list_missions", {}),
      toolCall(3, "doctor", {}),
      toolCall(4, "mission_status", {}),
    ]);

    // list_missions succeeds and returns an (empty) array on a fresh workspace.
    const listed = resultFor(responses, 2);
    assert.ok(isRecord(listed.structuredContent));
    assert.equal(listed.structuredContent.status, "reported");
    assert.equal(listed.isError, false);
    assert.ok(Array.isArray(listed.structuredContent.missions));
    assert.equal((listed.structuredContent.missions as unknown[]).length, 0);

    // doctor succeeds and carries a diagnostic report.
    const doctor = resultFor(responses, 3);
    assert.ok(isRecord(doctor.structuredContent));
    assert.equal(doctor.structuredContent.status, "reported");
    assert.equal(doctor.isError, false);
    assert.ok(isRecord(doctor.structuredContent.report));

    // mission_status with no mission is a clean, non-crashing error.
    const status = resultFor(responses, 4);
    assert.ok(isRecord(status.structuredContent));
    assert.equal(status.isError, true);
    assert.match(String(status.structuredContent.reason), /No active mission/u);
  } finally {
    removeTree(fixture.container);
  }
});

test("negotiates AGY's MCP protocol version during initialization", () => {
  const fixture = createRepository(false);
  try {
    installWorkspacePlugin(fixture.root, { gates: [nodeGate("pass", "process.exit(0)")] });
    const responses = runMcp(fixture.root, [initializeRequest(1, "2024-11-05")]);
    const initialized = resultFor(responses, 1);
    assert.equal(initialized.protocolVersion, "2024-11-05");
  } finally {
    removeTree(fixture.container);
  }
});

test("T2.3: broker exposes and executes plan_route through MCP stdio protocol", () => {
  const fixture = createRepository(false);
  try {
    installWorkspacePlugin(fixture.root, { gates: [nodeGate("pass", "process.exit(0)")] });
    const responses = runMcp(fixture.root, [
      initializeRequest(1),
      toolCall(2, "plan_route", { mode: "bugfix" }),
      toolCall(3, "plan_route", { mode: "diagnostic" }),
      toolCall(4, "plan_route", { mode: "" }),
    ]);

    const bugfixResult = resultFor(responses, 2);
    assert.ok(isRecord(bugfixResult.structuredContent));
    assert.equal(bugfixResult.isError, false);
    assert.equal(bugfixResult.structuredContent.status, "routed");
    assert.equal(bugfixResult.structuredContent.mode, "bugfix");
    assert.deepEqual(bugfixResult.structuredContent.roles, ["planner", "executor", "verifier"]);

    const diagResult = resultFor(responses, 3);
    assert.ok(isRecord(diagResult.structuredContent));
    assert.equal(diagResult.isError, false);
    assert.equal(diagResult.structuredContent.status, "routed");
    assert.equal(diagResult.structuredContent.mode, "diagnostic");
    assert.deepEqual(diagResult.structuredContent.roles, ["explorer", "reviewer"]);

    const invalidResult = resultFor(responses, 4);
    assert.ok(isRecord(invalidResult.structuredContent));
    assert.equal(invalidResult.isError, true);
    assert.equal(invalidResult.structuredContent.status, "rejected");
    assert.ok(String(invalidResult.structuredContent.reason).includes("plan_route requires a non-empty 'mode' string"));
  } finally {
    removeTree(fixture.container);
  }
});

test("self-review (Author == Reviewer) is rejected during promote_change", { timeout: 30000 }, () => {
  const fixture = createRepository(false);
  try {
    installWorkspacePlugin(fixture.root, {
      gates: [nodeGate("pass", "process.exit(0)")],
    });
    commitAll(fixture.root, "fixture with plugin");
    const parent = git(fixture.root, ["rev-parse", "HEAD"]);

    const responses1 = runMcp(fixture.root, [
      initializeRequest(1),
      toolCall(2, "propose_change", {
        schemaVersion: 1,
        parentVersion: parent,
        operations: [
          { kind: "write", path: "a.txt", baseHash: contentHash("old"), content: "new" },
        ],
      }),
    ]);

    const proposed = resultFor(responses1, 2);
    assert.ok(isRecord(proposed.structuredContent));
    const content = proposed.structuredContent as Record<string, unknown>;
    const txId = String(content.transactionId);
    const diffDigest = String(content.stagedDiffDigest);

    // Now run self-review test with exact transactionId
    const responsesSelf = runMcp(fixture.root, [
      initializeRequest(1),
      toolCall(2, "propose_change", {
        schemaVersion: 1,
        parentVersion: parent,
        operations: [
          { kind: "write", path: "a.txt", baseHash: contentHash("old"), content: "new" },
        ],
      }),
      toolCall(3, "attest_review", {
        transactionId: txId,
        stagedDiffDigest: diffDigest,
        reviewerRunKey: "run-self-reviewer",
        reviewerExpertId: "oma-executor", // SAME as author
        verdict: "approved",
      }),
      toolCall(4, "promote_change", {
        transactionId: txId,
      }),
    ]);

    const promoteResult = resultFor(responsesSelf, 4);
    assert.ok(isRecord(promoteResult.structuredContent));
    const promoteContent = promoteResult.structuredContent as Record<string, unknown>;
    assert.equal(promoteContent.status, "rejected");
    assert.equal(promoteResult.isError, true);
    assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), parent);
    assert.equal(readFileSync(join(fixture.root, "a.txt"), "utf8"), "old");
  } finally {
    removeTree(fixture.container);
  }
});

test("a failing fixed gate prevents MCP promotion and leaves source unchanged", { timeout: 30000 }, () => {
  const fixture = createRepository(false);
  try {
    installWorkspacePlugin(fixture.root, {
      gates: [nodeGate("fail", "process.stderr.write('no'); process.exit(9)")],
    });
    commitAll(fixture.root, "fixture with failing gate");
    const parent = git(fixture.root, ["rev-parse", "HEAD"]);
    const responses = runMcp(fixture.root, [
      initializeRequest(1),
      toolCall(2, "propose_change", {
        schemaVersion: 1,
        parentVersion: parent,
        operations: [
          { kind: "write", path: "a.txt", baseHash: contentHash("old"), content: "new" },
        ],
      }),
    ]);
    const called = resultFor(responses, 2);
    assert.ok(isRecord(called.structuredContent));
    assert.equal(called.structuredContent.status, "rejected");
    assert.equal(
      called.structuredContent.failedGateId,
      "fail",
      JSON.stringify(called.structuredContent),
    );
    assert.equal(called.isError, true);
    assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), parent);
    assert.equal(readFileSync(join(fixture.root, "a.txt"), "utf8"), "old");
  } finally {
    removeTree(fixture.container);
  }
});

test("the MCP broker rejects proposals targeting plugin and graph authority files", () => {
  const fixture = createRepository(false);
  try {
    installWorkspacePlugin(fixture.root, {
      gates: [nodeGate("pass", "process.exit(0)")],
    });
    const graphPath = ".oma/graph/execution-graph.json";
    mkdirSync(join(fixture.root, ".oma", "graph"), { recursive: true });
    writeFileSync(join(fixture.root, ...graphPath.split("/")), "{}\n", "utf8");
    commitAll(fixture.root, "fixture with protected plugin");
    const parent = git(fixture.root, ["rev-parse", "HEAD"]);
    const protectedPath = ".agents/plugins/oma/hooks.json";
    const existing = readFileSync(join(fixture.root, ...protectedPath.split("/")), "utf8");
    const responses = runMcp(fixture.root, [
      initializeRequest(1),
      toolCall(2, "propose_change", {
        schemaVersion: 1,
        parentVersion: parent,
        operations: [
          {
            kind: "write",
            path: protectedPath,
            baseHash: contentHash(existing),
            content: "{}",
          },
        ],
      }),
      toolCall(3, "propose_change", {
        schemaVersion: 1,
        parentVersion: parent,
        operations: [
          {
            kind: "write",
            path: graphPath,
            baseHash: contentHash("{}\n"),
            content: "{\"loop\":true}\n",
          },
        ],
      }),
    ]);
    const called = resultFor(responses, 2);
    assert.ok(isRecord(called.structuredContent));
    assert.equal(called.structuredContent.status, "rejected");
    assert.match(String(called.structuredContent.reason), /protected OMA control path/u);
    const graphCall = resultFor(responses, 3);
    assert.ok(isRecord(graphCall.structuredContent));
    assert.equal(graphCall.structuredContent.status, "rejected");
    assert.match(String(graphCall.structuredContent.reason), /protected OMA control path/u);
    assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), parent);
    assert.equal(readFileSync(join(fixture.root, ...protectedPath.split("/")), "utf8"), existing);
    assert.equal(readFileSync(join(fixture.root, ...graphPath.split("/")), "utf8"), "{}\n");
  } finally {
    removeTree(fixture.container);
  }
});

test("graph authority protection runs before Git repository discovery", () => {
  const container = mkdtempSync(join(tmpdir(), "oma-mcp-nongit-"));
  const root = join(container, "workspace");
  mkdirSync(root);
  try {
    installWorkspacePlugin(root, {
      gates: [nodeGate("pass", "process.exit(0)")],
    });
    const responses = runMcp(root, [
      initializeRequest(1),
      toolCall(2, "propose_change", {
        schemaVersion: 1,
        parentVersion: "not-a-git-head",
        operations: [
          {
            kind: "write",
            path: ".oma/graph/execution-graph.json",
            baseHash: null,
            content: "{\"loopUntilDone\":true}\n",
          },
        ],
      }),
    ]);
    const called = resultFor(responses, 2);
    assert.ok(isRecord(called.structuredContent));
    assert.equal(called.structuredContent.status, "rejected");
    assert.match(String(called.structuredContent.reason), /protected OMA control path/iu);
    assert.doesNotMatch(String(called.structuredContent.reason), /Not a Git repository/iu);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

function runMcp(root: string, messages: unknown[], _options?: unknown): unknown[] {
  const rawConfig = JSON.parse(
    readFileSync(join(root, ".agents", "plugins", "oma", "mcp_config.json"), "utf8"),
  ) as unknown;
  assert.ok(isRecord(rawConfig));
  assert.ok(isRecord(rawConfig.mcpServers));
  const server = rawConfig.mcpServers["oma-broker"];
  assert.ok(isRecord(server));
  const command = server.command;
  const rawArgs = server.args;
  const cwd = server.cwd;
  assert.equal(typeof command, "string");
  assert.ok(Array.isArray(rawArgs));
  assert.equal(typeof cwd, "string");
  if (typeof command !== "string" || !Array.isArray(rawArgs) || typeof cwd !== "string") {
    assert.fail("Malformed stdio MCP command configuration");
  }
  const args: string[] = [];
  for (const arg of rawArgs) {
    assert.equal(typeof arg, "string");
    if (typeof arg === "string") args.push(arg);
  }
  assert.ok(isRecord(server.env));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.env)) {
    assert.equal(typeof value, "string");
    env[key] = String(value);
  }
  const input = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
  // Redirect OMA's machine-wide state (capture journal, workspace registry) out of the
  // developer's real ~/.oma: the broker drains the journal automatically at session
  // start, so without this the suite would read and write the user's own capture store.
  const omaHome = mkdtempSync(join(tmpdir(), "oma-broker-home-"));
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env, OMA_HOME: omaHome },
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr ?? result.error?.message);
  return (result.stdout ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function resultFor(responses: unknown[], id: number): Record<string, unknown> {
  const response = responses.find((candidate) => isRecord(candidate) && candidate.id === id);
  assert.ok(isRecord(response));
  assert.ok(isRecord(response.result));
  return response.result;
}

function initializeRequest(id: number, protocolVersion = "2025-06-18") {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "oma-test", version: "1" },
    },
  };
}

function toolCall(id: number, name: string, args: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

function nodeGate(id: string, code: string) {
  return { id, program: process.execPath, args: ["-e", code], timeoutMs: 10_000 };
}

/**
 * Remove a fixture tree, retrying a transient Windows lock.
 *
 * The broker writes OMA's state (brain, graph, missions) into the fixture, and the
 * database file can still be held for a moment after the process exits. A bare `rmSync`
 * surfaces that as `EBUSY: resource busy or locked` in teardown — a failure about timing,
 * not about the behaviour under test. The rest of the suite retries the same way.
 */
function removeTree(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      Bun.sleepSync(25 * (attempt + 1));
    }
  }
}

function createRepository(withInitialCommit: boolean) {
  const container = mkdtempSync(join(tmpdir(), "oma-mcp-test-"));
  const root = join(container, "repo");
  mkdirSync(root);
  git(root, ["init"]);
  git(root, ["config", "user.email", "oma-test@example.invalid"]);
  git(root, ["config", "user.name", "OMA Test"]);
  writeFileSync(join(root, "a.txt"), "old", "utf8");
  if (withInitialCommit) commitAll(root, "fixture");
  return { container, root };
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "."]);
  git(root, ["commit", "-m", message]);
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr ?? result.error?.message);
  return (result.stdout ?? "").trim();
}
