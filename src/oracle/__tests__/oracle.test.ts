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
import { join } from "node:path";
import { test } from "bun:test";
import {
  discardStagedTransaction,
  snapshotCleanGitWorkspace,
  stageProposal,
} from "../../broker/staging.js";
import { contentHash } from "../../broker/transaction.js";
import { evaluateStagedTransaction } from "../executor.js";

test("a failing gate discards staging and cannot yield an approval", { timeout: 30000 }, () => {
  const repo = createRepository();
  try {
    const source = snapshotCleanGitWorkspace(repo.root);
    const sourceHead = git(repo.root, ["rev-parse", "HEAD"]);
    const staged = stageUpdate(repo.root, source.version);
    const worktreePath = staged.worktreePath;
    const evaluation = evaluateStagedTransaction(staged, [
      nodeGate("pass", "process.stdout.write('checked')"),
      nodeGate("fail", "process.stderr.write('rejected'); process.exit(7)"),
      nodeGate("must-not-run", "process.exit(0)"),
    ]);

    assert.equal(evaluation.status, "rejected");
    if (evaluation.status !== "rejected") {
      assert.fail("Expected rejected evaluation");
    }
    assert.equal(evaluation.reason, "gate_failed");
    assert.equal(evaluation.failedGateId, "fail");
    assert.equal(evaluation.observations.length, 2);
    assert.equal(evaluation.observations[1]?.exitCode, 7);
    assert.equal("approval" in evaluation, false);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(git(repo.root, ["rev-parse", "HEAD"]), sourceHead);
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "old");
    assert.equal(git(repo.root, ["status", "--porcelain=v1"]), "");
  } finally {
    rmSync(repo.container, { recursive: true, force: true });
  }
});

test("a gate that mutates staging is rejected even with exit code zero", { timeout: 30000 }, () => {
  const repo = createRepository();
  try {
    const source = snapshotCleanGitWorkspace(repo.root);
    const staged = stageUpdate(repo.root, source.version);
    const worktreePath = staged.worktreePath;
    const evaluation = evaluateStagedTransaction(staged, [
      nodeGate("mutator", "require('node:fs').writeFileSync('a.txt', 'tampered')"),
    ]);

    assert.equal(evaluation.status, "rejected");
    if (evaluation.status !== "rejected") {
      assert.fail("Expected rejected evaluation");
    }
    assert.equal(evaluation.reason, "stage_mutated");
    assert.equal(existsSync(worktreePath), false);
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "old");
  } finally {
    rmSync(repo.container, { recursive: true, force: true });
  }
});

test("all passing immutable gates yield an opaque approval", { timeout: 30000 }, () => {
  const repo = createRepository();
  try {
    const source = snapshotCleanGitWorkspace(repo.root);
    const staged = stageUpdate(repo.root, source.version);
    const evaluation = evaluateStagedTransaction(staged, [
      nodeGate("one", "process.stdout.write('one')"),
      nodeGate("two", "process.stdout.write('two')"),
    ]);

    assert.equal(evaluation.status, "approved");
    if (evaluation.status !== "approved") {
      assert.fail("Expected approved evaluation");
    }
    assert.match(evaluation.approval.verdictHash, /^[a-f0-9]{64}$/);
    assert.equal(evaluation.approval.transactionId, staged.transaction.transactionId);
    assert.equal(existsSync(staged.worktreePath), true);
    discardStagedTransaction(staged);
    assert.equal(existsSync(staged.worktreePath), false);
  } finally {
    rmSync(repo.container, { recursive: true, force: true });
  }
});

function stageUpdate(root: string, parentVersion: string) {
  return stageProposal(root, {
    schemaVersion: 1,
    parentVersion,
    operations: [
      { kind: "write", path: "a.txt", baseHash: contentHash("old"), content: "new" },
    ],
  });
}

function nodeGate(id: string, code: string) {
  return { id, program: process.execPath, args: ["-e", code], timeoutMs: 10_000 };
}

function createRepository(): { container: string; root: string } {
  const container = mkdtempSync(join(tmpdir(), "oma-oracle-test-"));
  const root = join(container, "repo");
  mkdirSync(root);
  git(root, ["init"]);
  git(root, ["config", "user.email", "oma-test@example.invalid"]);
  git(root, ["config", "user.name", "OMA Test"]);
  writeFileSync(join(root, "a.txt"), "old", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  return { container, root };
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr ?? result.error?.message);
  return (result.stdout ?? "").trim();
}
