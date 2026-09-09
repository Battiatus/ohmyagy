import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { RealBenchmarkRunner } from "../real-benchmark.js";
import { sha256 } from "../../ledger/canonical.js";
import type { DriverExecutionResult, DriverInvocationOptions, IAgyDriver } from "../../runtime/agy-driver.js";

test("real benchmark preserves per-trial evidence before isolated worktrees are removed", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "oma-real-benchmark-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".oma/\n.agents/\n", "utf8");
    writeFileSync(join(root, "src", "value.txt"), "before\n", "utf8");
    git(root, ["init"]);
    git(root, ["config", "user.email", "oma-test@local.invalid"]);
    git(root, ["config", "user.name", "OMA Test"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "initial"]);
    const baselineCommitSha = git(root, ["rev-parse", "HEAD"]).trim();
    const pluginRoot = join(root, ".agents", "plugins", "oma");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, "plugin.json"), JSON.stringify({ name: "oma" }), "utf8");

    const result = await RealBenchmarkRunner.execute({
      workspaceRoot: root,
      driver: new BenchmarkDriver(),
      manifest: {
        schemaVersion: 1,
        baselineCommitSha,
        task: { id: "value-change", prompt: "Change src/value.txt from before to after." },
        model: "test-model",
        effort: "medium",
        timeoutMs: 30_000,
        trialsPerVariant: 3,
        maxDynamicWaves: 2,
        skillsOnlyPrompt: "Inspect the target and make the smallest correct change.",
        gates: [{ id: "runtime", program: process.execPath, args: ["--version"], timeoutMs: 30_000 }],
      },
    });

    assert.equal(result.rawResults.length, 12);
    assert.ok(result.rawResults.every((trial) => trial.evidencePath !== null));
    assert.ok(result.rawResults.every((trial) => existsSync(join(root, ...trial.evidencePath!.split("/")))));
    assert.ok(result.rawResults.some((trial) => trial.variant === "vanilla_agy" && trial.totalTokens === 42));
    assert.ok(result.rawResults.some((trial) => trial.variant === "oma_dynamic_workflow" && trial.commitShas.length === 1));
    assert.ok(existsSync(result.resultsFilePath));
    assert.ok(existsSync(result.reportFilePath));
  } finally {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(root, { recursive: true, force: true });
        if (!existsSync(root)) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  }
});

class BenchmarkDriver implements IAgyDriver {
  public async invoke(options: DriverInvocationOptions): Promise<DriverExecutionResult> {
    if (options.persona === "planner") {
      return result(options, {
        workItems: [{
          id: "change-value",
          title: "Change target value",
          scope: ["src/value.txt"],
          dependsOn: [],
          persona: "executor",
          acceptance: ["Target value is after."],
        }],
      });
    }
    if (options.persona === "reviewer") {
      return result(options, { verdict: "approved", observations: ["Exact staged diff accepted."] });
    }
    writeFileSync(join(options.worktreeDir, "src", "value.txt"), "after\n", "utf8");
    return result(options, { totalTokens: 42, changedFiles: ["src/value.txt"] });
  }
}

function result(options: DriverInvocationOptions, parsedOutput: unknown): DriverExecutionResult {
  const stdout = JSON.stringify(parsedOutput);
  const stdoutHash = sha256(stdout);
  const runId = options.runId ?? "benchmark-test";
  return {
    exitCode: 0,
    status: "success",
    timedOut: false,
    parsedOutput,
    rawStdout: stdout,
    rawStderr: "",
    scrubbedStdout: stdout,
    scrubbedStderr: "",
    stdoutHash,
    scrubbedStdoutHash: stdoutHash,
    durationMs: 1,
    receipt: {
      runId,
      expertId: typeof options.persona === "string" ? options.persona : options.persona.id,
      model: options.modelOverride ?? "test-model",
      effort: options.reasoningEffort ?? "medium",
      sandbox: "workspace-write",
      durationMs: 1,
      exitCode: 0,
      status: "success",
      stdoutHash,
      scrubbedStdoutHash: stdoutHash,
      receiptHash: sha256(`${runId}:${stdoutHash}`),
    },
  };
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr ?? "").trim()}`);
  return result.stdout ?? "";
}
