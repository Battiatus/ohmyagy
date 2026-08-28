import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { contentHash } from "../../broker/transaction.js";
import { isRecord } from "../../control/model.js";
import { installWorkspacePlugin } from "../../packaging/install.js";
test("installs a placeholder-free Antigravity plugin and promotes through its only MCP tool", () => {
    const fixture = createRepository(false);
    try {
        const installed = installWorkspacePlugin(fixture.root, {
            gates: [nodeGate("pass", "process.exit(0)")],
        });
        assert.equal(existsSync(join(installed.pluginDir, "plugin.json")), true);
        assert.equal(existsSync(join(installed.pluginDir, "hooks.json")), true);
        assert.equal(existsSync(join(installed.pluginDir, "mcp_config.json")), true);
        const combined = ["hooks.json", "mcp_config.json", "gates.json"]
            .map((name) => readFileSync(join(installed.pluginDir, name), "utf8"))
            .join("\n");
        assert.equal(combined.includes("__OMA_"), false);
        const hooks = JSON.parse(readFileSync(join(installed.pluginDir, "hooks.json"), "utf8"));
        const hookCommand = hooks["oma-strict-write-gate"].PreToolUse[0].hooks[0].command;
        assert.equal(hookCommand.includes('"'), false);
        assert.equal(hookCommand.includes("\\"), false);
        assert.equal(isAbsolute(installed.hookPath), true);
        assert.equal(isAbsolute(installed.mcpServerPath), true);
        commitAll(fixture.root, "fixture with plugin");
        const parent = git(fixture.root, ["rev-parse", "HEAD"]);
        const responses = runMcp(fixture.root, [
            initializeRequest(1),
            { jsonrpc: "2.0", method: "notifications/initialized" },
            { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
            toolCall(3, {
                schemaVersion: 1,
                parentVersion: parent,
                operations: [
                    { kind: "write", path: "a.txt", baseHash: contentHash("old"), content: "new" },
                ],
            }),
        ]);
        assert.equal(responses.length, 3);
        const listed = resultFor(responses, 2);
        assert.ok(Array.isArray(listed.tools));
        assert.equal(listed.tools.length, 1);
        assert.ok(isRecord(listed.tools[0]));
        assert.equal(listed.tools[0].name, "propose_change");
        const called = resultFor(responses, 3);
        assert.ok(isRecord(called.structuredContent));
        assert.equal(called.structuredContent.status, "promoted", JSON.stringify(called.structuredContent));
        assert.equal(called.isError, false);
        assert.equal(readFileSync(join(fixture.root, "a.txt"), "utf8"), "new");
        assert.notEqual(git(fixture.root, ["rev-parse", "HEAD"]), parent);
        assert.equal(git(fixture.root, ["status", "--porcelain=v1"]), "");
    }
    finally {
        rmSync(fixture.container, { recursive: true, force: true });
    }
});
test("a failing fixed gate prevents MCP promotion and leaves source unchanged", () => {
    const fixture = createRepository(false);
    try {
        installWorkspacePlugin(fixture.root, {
            gates: [nodeGate("fail", "process.stderr.write('no'); process.exit(9)")],
        });
        commitAll(fixture.root, "fixture with failing gate");
        const parent = git(fixture.root, ["rev-parse", "HEAD"]);
        const responses = runMcp(fixture.root, [
            initializeRequest(1),
            toolCall(2, {
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
        assert.equal(called.structuredContent.failedGateId, "fail", JSON.stringify(called.structuredContent));
        assert.equal(called.isError, true);
        assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), parent);
        assert.equal(readFileSync(join(fixture.root, "a.txt"), "utf8"), "old");
    }
    finally {
        rmSync(fixture.container, { recursive: true, force: true });
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
            toolCall(2, {
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
            toolCall(3, {
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
    }
    finally {
        rmSync(fixture.container, { recursive: true, force: true });
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
            toolCall(2, {
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
    }
    finally {
        rmSync(container, { recursive: true, force: true });
    }
});
function runMcp(root, messages) {
    const rawConfig = JSON.parse(readFileSync(join(root, ".agents", "plugins", "oma", "mcp_config.json"), "utf8"));
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
    const args = [];
    for (const arg of rawArgs) {
        assert.equal(typeof arg, "string");
        if (typeof arg === "string")
            args.push(arg);
    }
    assert.ok(isRecord(server.env));
    const env = {};
    for (const [key, value] of Object.entries(server.env)) {
        assert.equal(typeof value, "string");
        env[key] = String(value);
    }
    const input = `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
    const result = spawnSync(command, args, {
        cwd,
        env: { ...process.env, ...env },
        input,
        encoding: "utf8",
        windowsHide: true,
        timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr ?? result.error?.message);
    return (result.stdout ?? "")
        .split(/\r?\n/u)
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
}
function resultFor(responses, id) {
    const response = responses.find((candidate) => isRecord(candidate) && candidate.id === id);
    assert.ok(isRecord(response));
    assert.ok(isRecord(response.result));
    return response.result;
}
function initializeRequest(id) {
    return {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "oma-test", version: "1" },
        },
    };
}
function toolCall(id, args) {
    return {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "propose_change", arguments: args },
    };
}
function nodeGate(id, code) {
    return { id, program: process.execPath, args: ["-e", code], timeoutMs: 10_000 };
}
function createRepository(withInitialCommit) {
    const container = mkdtempSync(join(tmpdir(), "oma-mcp-test-"));
    const root = join(container, "repo");
    mkdirSync(root);
    git(root, ["init"]);
    git(root, ["config", "user.email", "oma-test@example.invalid"]);
    git(root, ["config", "user.name", "OMA Test"]);
    writeFileSync(join(root, "a.txt"), "old", "utf8");
    if (withInitialCommit)
        commitAll(root, "fixture");
    return { container, root };
}
function commitAll(root, message) {
    git(root, ["add", "."]);
    git(root, ["commit", "-m", message]);
}
function git(root, args) {
    const result = spawnSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr ?? result.error?.message);
    return (result.stdout ?? "").trim();
}
