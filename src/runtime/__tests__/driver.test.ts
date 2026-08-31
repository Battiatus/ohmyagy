import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgyDriver } from "../agy-driver.js";
import { SecretScrubber } from "../secret-scrubber.js";

describe("WP-3 AgyDriver Unit & Integration Test Suite", () => {
  it("builds canonical CLI arguments with correct parameter mapping", () => {
    const driver = new AgyDriver({ executablePath: "agy.cmd" });
    const args = driver.buildCliArguments({
      contractPrompt: "Implement feature X according to spec",
      persona: "oma-executor",
      worktreeDir: "C:\\Projects\\repo\\.oma\\worktrees\\task_01",
      timeoutMs: 60000,
      reasoningEffort: "high",
      sandboxMode: "workspace-write",
      jsonSchemaPath: "schemas/task-result.json",
      extraArgs: ["--custom-flag", "value"],
    });

    assert.deepEqual(args, [
      "-p",
      "Implement feature X according to spec",
      "--agent",
      "oma-executor",
      "--model",
      "gemini-3.7-flash",
      "--output-format",
      "json",
      "--add-dir",
      "C:\\Projects\\repo\\.oma\\worktrees\\task_01",
      "--effort",
      "high",
      "--sandbox",
      "workspace-write",
      "--json-schema",
      "schemas/task-result.json",
      "--custom-flag",
      "value",
    ]);
  });

  it("handles Windows paths with spaces and complex prompt strings safely", () => {
    const driver = new AgyDriver();
    const args = driver.buildCliArguments({
      contractPrompt: 'Line 1\nLine 2 with "double quotes" & symbols $ % ^',
      persona: "oma-planner",
      worktreeDir: "C:\\Program Files\\My Workspace\\sub dir",
      timeoutMs: 30000,
    });

    assert.equal(args[1], 'Line 1\nLine 2 with "double quotes" & symbols $ % ^');
    assert.equal(args[9], "C:\\Program Files\\My Workspace\\sub dir");
  });

  it("extracts pure single JSON object from standard stdout", () => {
    const driver = new AgyDriver();
    const stdout = JSON.stringify({ status: "success", summary: "Task done", exitCode: 0 });
    const { parsed, parseError } = driver.extractStructuredOutput(stdout);

    assert.equal(parseError, undefined);
    assert.deepEqual(parsed, { status: "success", summary: "Task done", exitCode: 0 });
  });

  it("extracts terminal result event from incremental NDJSON stream", () => {
    const driver = new AgyDriver();
    const ndjson = [
      '{"type":"init","sessionId":"sess_123"}',
      '{"type":"delta","text":"Analyzing..."}',
      '{"type":"tool_call","tool":"read_file","file":"foo.ts"}',
      '{"type":"result","status":"success","summary":"All gates passed","filesModified":["foo.ts"]}',
    ].join("\n");

    const { parsed } = driver.extractStructuredOutput(ndjson);
    assert.ok(parsed);
    assert.equal((parsed as Record<string, unknown>).type, "result");
    assert.equal((parsed as Record<string, unknown>).status, "success");
    assert.equal((parsed as Record<string, unknown>).summary, "All gates passed");
  });

  it("extracts JSON embedded inside markdown code fence", () => {
    const driver = new AgyDriver();
    const fenced = [
      "Here is the execution report:",
      "```json",
      "{",
      '  "status": "success",',
      '  "verdict": "approved"',
      "}",
      "```",
      "End of report.",
    ].join("\n");

    const { parsed } = driver.extractStructuredOutput(fenced);
    assert.deepEqual(parsed, { status: "success", verdict: "approved" });
  });

  it("extracts JSON amidst mixed diagnostic log output and ANSI escape sequences", () => {
    const driver = new AgyDriver();
    const mixed = [
      "\u001b[33m[WARN] Cache miss on model weights\u001b[0m",
      "[INFO] Spawning subagent...",
      '{"status":"success","summary":"Completed with warnings"}',
      "[INFO] Process teardown completed.",
    ].join("\n");

    const { parsed } = driver.extractStructuredOutput(mixed);
    assert.deepEqual(parsed, { status: "success", summary: "Completed with warnings" });
  });

  it("maps exit code 0 with malformed JSON to status failed with OUTPUT_SCHEMA_INVALID error", async () => {
    const mockProcessRunner = {
      execute: async () => ({
        exitCode: 0,
        stdout: "Fatal corruption: not a json { [",
        stderr: "",
        durationMs: 100,
        timedOut: false,
        killed: false,
      }),
    };

    const driver = new AgyDriver({ processRunner: mockProcessRunner as any });
    const result = await driver.invoke({
      contractPrompt: "Test prompt",
      persona: "oma-executor",
      worktreeDir: "C:\\worktree",
      timeoutMs: 5000,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.parsedOutput, undefined);
    assert.match(result.error ?? "", /failed to provide valid JSON output/i);
  });

  it("maps exit codes 124 and 143 to status timed_out", async () => {
    const mockProcessRunner = {
      execute: async () => ({
        exitCode: 124,
        stdout: "",
        stderr: "Watchdog timer expired",
        durationMs: 5000,
        timedOut: true,
        killed: true,
      }),
    };

    const driver = new AgyDriver({ processRunner: mockProcessRunner as any });
    const result = await driver.invoke({
      contractPrompt: "Test timeout",
      persona: "oma-executor",
      worktreeDir: "C:\\worktree",
      timeoutMs: 5000,
    });

    assert.equal(result.status, "timed_out");
    assert.equal(result.timedOut, true);
  });

  it("integrates SecretScrubber to redact API tokens in stdout and stderr", async () => {
    const mockProcessRunner = {
      execute: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ key: "AIzaSyD9vF09a8Zk1mN2pQ3rS4tU5vW6xY7zA1b", status: "success" }),
        stderr: "Error sending token: sk-proj-123456789012345678901234567890123456789012345678",
        durationMs: 50,
        timedOut: false,
        killed: false,
      }),
    };

    const driver = new AgyDriver({
      processRunner: mockProcessRunner as any,
      secretScrubber: new SecretScrubber({ genericMask: true }),
    });

    const result = await driver.invoke({
      contractPrompt: "Test secrets",
      persona: "oma-executor",
      worktreeDir: "C:\\worktree",
      timeoutMs: 5000,
    });

    assert.equal(result.status, "success");
    assert.ok(!result.scrubbedStdout.includes("AIzaSyD9vF09a8Zk1mN2pQ3rS4tU5vW6xY7zA1b"));
    assert.ok(result.scrubbedStdout.includes("[REDACTED_SECRET]"));
    assert.ok(!result.scrubbedStderr.includes("sk-proj-123456789012345678901234567890123456789012345678"));
    assert.ok(result.scrubbedStderr.includes("[REDACTED_SECRET]"));
  });
});
