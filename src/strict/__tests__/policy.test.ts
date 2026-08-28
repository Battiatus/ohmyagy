import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateStrictToolUse } from "../policy.js";

function payload(name: string, args: Record<string, unknown> = {}): unknown {
  return { toolCall: { name, args }, workspacePaths: [process.cwd()] };
}

test("denies every direct file mutation tool", () => {
  for (const tool of [
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
  ]) {
    assert.equal(evaluateStrictToolUse(payload(tool)).decision, "deny", tool);
  }
});

test("denies shell execution even when the command looks harmless", () => {
  const decision = evaluateStrictToolUse(
    payload("run_command", { CommandLine: "echo harmless" }),
  );
  assert.equal(decision.decision, "deny");
});

test("allows only the OMA broker through the generic MCP wrapper", () => {
  assert.equal(
    evaluateStrictToolUse(
      payload("call_mcp_tool", {
        ServerName: "oma-broker",
        ToolName: "propose_change",
      }),
    ).decision,
    "allow",
  );
  assert.equal(
    evaluateStrictToolUse(
      payload("call_mcp_tool", {
        ServerName: "untrusted-server",
        ToolName: "propose_change",
      }),
    ).decision,
    "deny",
  );
  assert.equal(
    evaluateStrictToolUse(
      payload("call_mcp_tool", { ToolName: "oma-broker/propose_change" }),
    ).decision,
    "allow",
  );
  assert.equal(
    evaluateStrictToolUse(
      payload("call_mcp_tool", { ToolName: "filesystem/write_file" }),
    ).decision,
    "deny",
  );
  for (const directName of [
    "mcp__oma-broker__propose_change",
    "mcp__oma_broker__propose_change",
    "mcp_oma-broker_propose_change",
  ]) {
    assert.equal(evaluateStrictToolUse(payload(directName)).decision, "allow", directName);
  }
});

test("allows known read tools and denies unknown tools", () => {
  assert.equal(
    evaluateStrictToolUse(
      payload("view_file", { AbsolutePath: fileURLToPath(import.meta.url) }),
    ).decision,
    "allow",
  );
  assert.equal(evaluateStrictToolUse(payload("mystery_tool")).decision, "deny");
});

test("denies filesystem reads outside mounted workspaces", () => {
  const input = {
    toolCall: { name: "view_file", args: { AbsolutePath: process.execPath } },
    workspacePaths: [process.cwd()],
  };
  assert.equal(evaluateStrictToolUse(input).decision, "deny");
});

test("fails closed on malformed hook input", () => {
  assert.equal(evaluateStrictToolUse({}).decision, "deny");
  assert.equal(evaluateStrictToolUse(null).decision, "deny");
});

test("gates the official Antigravity PreToolUse payload over stdin/stdout", () => {
  const hookPath = fileURLToPath(new URL("../hook.js", import.meta.url));
  const common = {
    stepIdx: 1,
    conversationId: "strict-integration-test",
    workspacePaths: [process.cwd()],
    transcriptPath: "transcript.jsonl",
    artifactDirectoryPath: "artifacts",
    modelName: "test-model",
  };

  const writeResult = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      ...common,
      toolCall: { name: "write_to_file", args: { TargetFile: "x.ts" } },
    }),
    encoding: "utf8",
  });
  assert.equal(writeResult.status, 0, writeResult.stderr);
  assert.equal(JSON.parse(writeResult.stdout).decision, "deny");

  const readResult = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      ...common,
      toolCall: {
        name: "view_file",
        args: { AbsolutePath: fileURLToPath(import.meta.url) },
      },
    }),
    encoding: "utf8",
  });
  assert.equal(readResult.status, 0, readResult.stderr);
  assert.equal(JSON.parse(readResult.stdout).decision, "allow");
});
