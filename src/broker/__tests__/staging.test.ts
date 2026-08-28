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
import test from "node:test";
import {
  StagingError,
  discardStagedTransaction,
  snapshotCleanGitWorkspace,
  stageProposal,
} from "../staging.js";
import { contentHash } from "../transaction.js";

interface TestRepository {
  container: string;
  root: string;
}

test("applies a multifile transaction only in a detached Git worktree", () => {
  const repo = createRepository({
    "a.txt": "old",
    "remove.txt": "delete-me",
  });
  try {
    const source = snapshotCleanGitWorkspace(repo.root);
    const staged = stageProposal(repo.root, {
      schemaVersion: 1,
      parentVersion: source.version,
      operations: [
        { kind: "write", path: "a.txt", baseHash: contentHash("old"), content: "new" },
        { kind: "write", path: "nested/new.txt", baseHash: null, content: "created" },
        { kind: "delete", path: "remove.txt", baseHash: contentHash("delete-me") },
      ],
    });

    assert.notEqual(staged.worktreePath, repo.root);
    assert.equal(readFileSync(join(staged.worktreePath, "a.txt"), "utf8"), "new");
    assert.equal(readFileSync(join(staged.worktreePath, "nested", "new.txt"), "utf8"), "created");
    assert.equal(existsSync(join(staged.worktreePath, "remove.txt")), false);
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "old");
    assert.equal(readFileSync(join(repo.root, "remove.txt"), "utf8"), "delete-me");
    assert.equal(git(repo.root, ["status", "--porcelain=v1"]), "");

    discardStagedTransaction(staged);
    assert.equal(existsSync(staged.containerPath), false);
    assert.equal(git(repo.root, ["worktree", "list", "--porcelain"]).includes(staged.worktreePath), false);
  } finally {
    rmSync(repo.container, { recursive: true, force: true });
  }
});

test("discards every staged write when a later operation fails", () => {
  const repo = createRepository({
    "a.txt": "old",
    "blocked/child.txt": "keeps-directory-present",
  });
  try {
    const source = snapshotCleanGitWorkspace(repo.root);
    let stagingPath = "";
    assert.throws(
      () =>
        stageProposal(repo.root, {
          schemaVersion: 1,
          parentVersion: source.version,
          operations: [
            { kind: "write", path: "a.txt", baseHash: contentHash("old"), content: "new" },
            { kind: "write", path: "blocked", baseHash: null, content: "cannot-replace-dir" },
          ],
        }),
      (error: unknown) => {
        assert.ok(error instanceof StagingError);
        assert.equal(error.code, "stage_apply_failed");
        stagingPath = error.stagingPath ?? "";
        return true;
      },
    );
    assert.notEqual(stagingPath, "");
    assert.equal(existsSync(stagingPath), false);
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "old");
    assert.equal(readFileSync(join(repo.root, "blocked", "child.txt"), "utf8"), "keeps-directory-present");
    assert.equal(git(repo.root, ["status", "--porcelain=v1"]), "");
    assert.equal(git(repo.root, ["worktree", "list", "--porcelain"]).includes(stagingPath), false);
  } finally {
    rmSync(repo.container, { recursive: true, force: true });
  }
});

test("rejects a dirty source before creating a worktree", () => {
  const repo = createRepository({ "a.txt": "old" });
  try {
    const source = snapshotCleanGitWorkspace(repo.root);
    writeFileSync(join(repo.root, "a.txt"), "uncommitted", "utf8");
    assert.throws(
      () =>
        stageProposal(repo.root, {
          schemaVersion: 1,
          parentVersion: source.version,
          operations: [
            { kind: "write", path: "a.txt", baseHash: contentHash("old"), content: "new" },
          ],
        }),
      (error: unknown) => error instanceof StagingError && error.code === "dirty_workspace",
    );
    assert.equal(git(repo.root, ["worktree", "list", "--porcelain"]).split("worktree ").length, 2);
  } finally {
    rmSync(repo.container, { recursive: true, force: true });
  }
});

function createRepository(files: Record<string, string>): TestRepository {
  const container = mkdtempSync(join(tmpdir(), "oma-broker-test-"));
  const root = join(container, "repo");
  mkdirSync(root);
  git(root, ["init"]);
  git(root, ["config", "user.email", "oma-test@example.invalid"]);
  git(root, ["config", "user.name", "OMA Test"]);
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(root, ...path.split("/"));
    mkdirSync(join(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }
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
