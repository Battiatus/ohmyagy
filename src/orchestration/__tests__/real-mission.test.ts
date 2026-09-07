import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { sha256 } from "../../ledger/canonical.js";
import type { DriverExecutionResult, DriverInvocationOptions, IAgyDriver } from "../../runtime/agy-driver.js";
import { RealMissionExecutor } from "../real-mission.js";

test("real mission promotes only a worker diff that passed review and external gate", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "oma-real-mission-"));
  try {
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

    const report = await RealMissionExecutor.execute({
      workspaceRoot: root,
      missionId: "verified-change",
      goal: "Change src/value.txt through the real graph path.",
      driver: new DeterministicDriver(),
      timeoutMs: 30_000,
      maxWaves: 1,
    });

    assert.equal(report.status, "succeeded", JSON.stringify(report));
    assert.equal(report.commitShas.length, 1);
    assert.ok(report.graphRevision > 1);
    assert.equal(readFileSync(join(root, "src", "value.txt"), "utf8").trim(), "after");
    assert.match(git(root, ["show", "--format=", "--name-only", "HEAD"]), /src\/value\.txt/);
    const events = readFileSync(join(root, ".oma", "missions", "verified-change", "events.jsonl"), "utf8");
    assert.match(events, /"review_attested"/);
    assert.match(events, /"gate_evaluated"/);
    assert.match(events, /"integration_attempted"/);
    assert.equal(readFileSync(join(root, ".omc", "state", "session.json"), "utf8"), "{}\n");
    assert.equal(readFileSync(join(root, ".omo", "run-continuation", "session.json"), "utf8"), "{}\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class DeterministicDriver implements IAgyDriver {
  public async invoke(options: DriverInvocationOptions): Promise<DriverExecutionResult> {
    if (options.persona === "planner") {
      return result(options, {
        workItems: [
          {
            id: "change-value",
            title: "Change the target value",
            scope: ["src/value.txt"],
            dependsOn: [],
            persona: "worker",
            acceptance: ["src/value.txt contains after"],
          },
        ],
      });
    }
    if (options.persona === "worker") {
      writeFileSync(join(options.worktreeDir, "src", "value.txt"), "after\n", "utf8");
      return result(options, { changedFiles: ["src/value.txt"], checks: ["git diff --check"] });
    }
    if (options.persona === "reviewer") {
      return result(options, { verdict: "approved", observations: ["Exact staged diff is scoped and valid."] });
    }
    throw new Error(`Unexpected test persona: ${String(options.persona)}`);
  }
}

function result(options: DriverInvocationOptions, parsedOutput: unknown): DriverExecutionResult {
  const stdout = JSON.stringify(parsedOutput);
  const runId = options.runId ?? "test-run";
  const stdoutHash = sha256(stdout);
  const receipt = {
    runId,
    expertId: typeof options.persona === "string" ? options.persona : options.persona.id,
    model: options.modelOverride ?? "test-model",
    effort: options.reasoningEffort ?? "medium",
    sandbox: "workspace-write",
    durationMs: 1,
    exitCode: 0,
    status: "success" as const,
    stdoutHash,
    scrubbedStdoutHash: stdoutHash,
    receiptHash: sha256(`${runId}:${stdoutHash}`),
  };
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
    receipt,
  };
}

function git(root: string, args: string[]): string {
  const command = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  if (command.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(command.stderr ?? "").trim()}`);
  }
  return command.stdout ?? "";
}
