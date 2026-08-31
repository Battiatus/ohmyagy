import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { WorktreePool } from "../worktree-pool.js";
function initGitRepo(repoDir) {
    spawnSync("git", ["init"], { cwd: repoDir, encoding: "utf8", windowsHide: true });
    spawnSync("git", ["config", "user.email", "test@oma.dev"], {
        cwd: repoDir,
        encoding: "utf8",
        windowsHide: true,
    });
    spawnSync("git", ["config", "user.name", "OMA Tester"], {
        cwd: repoDir,
        encoding: "utf8",
        windowsHide: true,
    });
    writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf8");
    spawnSync("git", ["add", "."], { cwd: repoDir, encoding: "utf8", windowsHide: true });
    spawnSync("git", ["commit", "-m", "Initial commit"], {
        cwd: repoDir,
        encoding: "utf8",
        windowsHide: true,
    });
}
test("WorktreePool acquires and releases isolated git worktree in git repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "oma-wt-test-"));
    initGitRepo(root);
    try {
        const pool = new WorktreePool({ workspaceRoot: root });
        assert.equal(pool.isGitRepository(), true);
        const wtPath = await pool.acquire("task-1", "HEAD");
        assert.equal(existsSync(wtPath), true);
        assert.equal(pool.getWorktreePath("task-1"), wtPath);
        assert.equal(pool.getActiveWorktrees().size, 1);
        // Verify worktree has git files
        assert.equal(existsSync(join(wtPath, "README.md")), true);
        // Release worktree
        await pool.release("task-1", true);
        assert.equal(existsSync(wtPath), false);
        assert.equal(pool.getActiveWorktrees().size, 0);
        assert.equal(pool.getWorktreePath("task-1"), undefined);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("WorktreePool returns existing path on duplicate acquire", async () => {
    const root = mkdtempSync(join(tmpdir(), "oma-wt-dup-"));
    initGitRepo(root);
    try {
        const pool = new WorktreePool({ workspaceRoot: root });
        const path1 = await pool.acquire("task-dup");
        const path2 = await pool.acquire("task-dup");
        assert.equal(path1, path2);
        assert.equal(pool.getActiveWorktrees().size, 1);
        await pool.release("task-dup", true);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("WorktreePool operates as directory isolation in non-git directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "oma-wt-nongit-"));
    try {
        const pool = new WorktreePool({ workspaceRoot: root });
        assert.equal(pool.isGitRepository(), false);
        const wtPath = await pool.acquire("task-standalone");
        assert.equal(existsSync(wtPath), true);
        await pool.release("task-standalone", true);
        assert.equal(existsSync(wtPath), false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("WorktreePool purges orphaned worktree directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "oma-wt-purge-"));
    initGitRepo(root);
    try {
        const pool = new WorktreePool({ workspaceRoot: root });
        const worktreesDir = join(root, ".oma", "worktrees");
        mkdirSync(worktreesDir, { recursive: true });
        // Create an orphaned directory simulating crashed prior run
        const orphanPath = join(worktreesDir, "task-orphan-99");
        mkdirSync(orphanPath, { recursive: true });
        writeFileSync(join(orphanPath, "stale.txt"), "leftover", "utf8");
        // Also acquire an active task
        const activePath = await pool.acquire("task-active");
        assert.equal(existsSync(orphanPath), true);
        assert.equal(existsSync(activePath), true);
        const purged = await pool.purgeOrphans();
        assert.deepEqual(purged, ["task-orphan-99"]);
        assert.equal(existsSync(orphanPath), false);
        assert.equal(existsSync(activePath), true);
        await pool.release("task-active", true);
        assert.equal(existsSync(activePath), false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("WorktreePool removeDirectoryWithRetry cleans directories safely", async () => {
    const root = mkdtempSync(join(tmpdir(), "oma-wt-retry-"));
    try {
        const pool = new WorktreePool({ workspaceRoot: root });
        const testDir = join(root, "sub-dir", "nested");
        mkdirSync(testDir, { recursive: true });
        writeFileSync(join(testDir, "test.txt"), "hello", "utf8");
        assert.equal(existsSync(testDir), true);
        await pool.removeDirectoryWithRetry(join(root, "sub-dir"));
        assert.equal(existsSync(join(root, "sub-dir")), false);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
