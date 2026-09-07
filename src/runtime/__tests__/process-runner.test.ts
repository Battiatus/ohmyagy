import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { ProcessRunner } from "../process-runner.js";
import { SecretScrubber } from "../secret-scrubber.js";

describe("WP-3 ProcessRunner & Confinement Test Suite", () => {
  it("executes standard command capturing stdout and durationMs", async () => {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? "cmd.exe" : "sh";
    const args = isWindows ? ["/C", "echo hello world"] : ["-c", "echo hello world"];

    const result = await ProcessRunner.execute({
      executable,
      args,
      cwd: process.cwd(),
      timeoutMs: 5000,
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /hello world/);
    assert.equal(result.timedOut, false);
    assert.ok(result.durationMs >= 0);
  });

  it("terminates long-running process when timeout expires and returns code 124", async () => {
    const executable = process.execPath;
    const args = ["-e", "setTimeout(() => {}, 5000)"];

    const startTime = Date.now();
    const result = await ProcessRunner.execute({
      executable,
      args,
      cwd: process.cwd(),
      timeoutMs: 200,
    });

    const elapsed = Date.now() - startTime;
    assert.equal(result.timedOut, true);
    assert.equal(result.killed, true);
    assert.equal(result.exitCode, 124);
    assert.ok(elapsed < 4000, `Process took ${elapsed}ms, expected timeout termination in < 4000ms`);
  });

  it("propagates exit code from non-zero terminating processes", async () => {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? "cmd.exe" : "sh";
    const args = isWindows ? ["/C", "exit /B 42"] : ["-c", "exit 42"];

    const result = await ProcessRunner.execute({
      executable,
      args,
      cwd: process.cwd(),
      timeoutMs: 5000,
    });

    assert.equal(result.exitCode, 42);
    assert.equal(result.timedOut, false);
  });

  it("passes environment variables correctly to spawned process", async () => {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? "cmd.exe" : "sh";
    const args = isWindows
      ? ["/C", "echo %OMA_TEST_VAR%"]
      : ["-c", 'echo "$OMA_TEST_VAR"'];

    const result = await ProcessRunner.execute({
      executable,
      args,
      cwd: process.cwd(),
      env: { OMA_TEST_VAR: "OMA_CONFINEMENT_VALIDATED" },
      timeoutMs: 5000,
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /OMA_CONFINEMENT_VALIDATED/);
  });

  it("pipes stdinInput properly to child process stdin", async () => {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? "powershell.exe" : "cat";
    const args = isWindows
      ? ["-NoProfile", "-NonInteractive", "-Command", "$input | Out-String"]
      : [];

    const result = await ProcessRunner.execute({
      executable,
      args,
      cwd: process.cwd(),
      stdinInput: "PING_TEST_STDIN_PAYLOAD\n",
      timeoutMs: 5000,
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /PING_TEST_STDIN_PAYLOAD/);
  });

  it("truncates output when exceeding maxBufferBytes without memory crash", async () => {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? "powershell.exe" : "node";
    const args = isWindows
      ? ["-NoProfile", "-NonInteractive", "-Command", "1..5000 | ForEach-Object { 'LONG_LINE_CONTENT_REPETITION_1234567890' }"]
      : ["-e", "for(let i=0;i<5000;i++) console.log('LONG_LINE_CONTENT_REPETITION_1234567890');"];

    const result = await ProcessRunner.execute({
      executable,
      args,
      cwd: process.cwd(),
      maxBufferBytes: 1024, // 1KB limit
      timeoutMs: 5000,
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /stdout truncated at max buffer limit/);
  });

  it("streams stdout chunks in real-time and applies live scrubber", async () => {
    const chunks: string[] = [];
    const scrubber = new SecretScrubber();

    const isWindows = process.platform === "win32";
    const executable = isWindows ? "cmd.exe" : "sh";
    const args = isWindows
      ? ["/C", "echo Token AIzaSyD9vF09a8Zk1mN2pQ3rS4tU5vW6xY7zA1b"]
      : ["-c", "echo 'Token AIzaSyD9vF09a8Zk1mN2pQ3rS4tU5vW6xY7zA1b'"];

    const result = await ProcessRunner.execute({
      executable,
      args,
      cwd: process.cwd(),
      scrubber,
      onStdoutChunk: (chunk) => chunks.push(chunk),
      timeoutMs: 5000,
    });

    assert.equal(result.exitCode, 0);
    assert.ok(chunks.length > 0);
    assert.ok(!result.stdout.includes("AIzaSyD9vF09a8Zk1mN2pQ3rS4tU5vW6xY7zA1b"));
    assert.ok(result.stdout.includes("[REDACTED_GEMINI_KEY]"));
  });

  it("returns exit code 255 with explicit error when spawning non-existent binary", async () => {
    const result = await ProcessRunner.execute({
      executable: "non_existent_binary_xyz_987654321",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 5000,
    });

    assert.equal(result.exitCode, 255);
    assert.equal(result.killed, true);
    assert.match(result.stderr, /Failed to spawn process/);
  });
});
