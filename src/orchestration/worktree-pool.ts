import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export interface IWorktreePool {
  acquire(taskId: string, baseRef?: string): Promise<string>;
  release(taskId: string, cleanup?: boolean): Promise<void>;
  purgeOrphans(): Promise<string[]>;
}

export interface WorktreePoolOptions {
  workspaceRoot: string;
  worktreesDir?: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface WorktreeEntry {
  taskId: string;
  path: string;
  branch?: string;
  acquiredAt: number;
}

export class WorktreePool implements IWorktreePool {
  public readonly workspaceRoot: string;
  public readonly worktreesDir: string;
  public readonly maxRetries: number;
  public readonly retryDelayMs: number;

  private readonly activeWorktrees = new Map<string, WorktreeEntry>();

  constructor(options: WorktreePoolOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.worktreesDir = options.worktreesDir
      ? resolve(options.worktreesDir)
      : join(this.workspaceRoot, ".oma", "worktrees");
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 20;
  }

  public getActiveWorktrees(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [taskId, entry] of this.activeWorktrees.entries()) {
      result.set(taskId, entry.path);
    }
    return result;
  }

  public getWorktreePath(taskId: string): string | undefined {
    return this.activeWorktrees.get(taskId)?.path;
  }

  public isGitRepository(): boolean {
    return existsSync(join(this.workspaceRoot, ".git"));
  }

  public async acquire(taskId: string, baseRef: string = "HEAD"): Promise<string> {
    const existing = this.activeWorktrees.get(taskId);
    if (existing && existsSync(existing.path)) {
      return existing.path;
    }

    if (!existsSync(this.worktreesDir)) {
      mkdirSync(this.worktreesDir, { recursive: true });
    }

    const safeTaskId = taskId.replace(/[/\\:?*"<>|]/g, "_");
    const targetPath = join(this.worktreesDir, `task-${safeTaskId}`);

    // If target directory already exists from previous unclean run, remove it
    if (existsSync(targetPath)) {
      await this.cleanupSingleWorktree(targetPath);
    }

    const isGit = this.isGitRepository();
    let branchName: string | undefined;

    if (isGit) {
      branchName = `oma/task-${safeTaskId}-${Date.now()}`;
      let addResult = spawnSync(
        "git",
        ["-C", this.workspaceRoot, "worktree", "add", "-b", branchName, targetPath, baseRef],
        {
          encoding: "utf8",
          windowsHide: true,
        },
      );

      if (addResult.status !== 0) {
        // Prune stale worktree metadata in git and retry with fallback
        spawnSync("git", ["-C", this.workspaceRoot, "worktree", "prune"], {
          encoding: "utf8",
          windowsHide: true,
        });

        addResult = spawnSync(
          "git",
          ["-C", this.workspaceRoot, "worktree", "add", "--detach", targetPath, baseRef],
          {
            encoding: "utf8",
            windowsHide: true,
          },
        );
        branchName = undefined;

        if (addResult.status !== 0) {
          // If worktree add still failed (e.g. non-fatal git repo or subfolder), create directory fallback
          if (!existsSync(targetPath)) {
            mkdirSync(targetPath, { recursive: true });
          }
        }
      }
    } else {
      if (!existsSync(targetPath)) {
        mkdirSync(targetPath, { recursive: true });
      }
    }

    const entry: WorktreeEntry = {
      taskId,
      path: targetPath,
      branch: branchName,
      acquiredAt: Date.now(),
    };

    this.activeWorktrees.set(taskId, entry);
    return targetPath;
  }

  public async release(taskId: string, cleanup: boolean = true): Promise<void> {
    const entry = this.activeWorktrees.get(taskId);
    const targetPath = entry?.path ?? join(this.worktreesDir, `task-${taskId.replace(/[/\\:?*"<>|]/g, "_")}`);

    this.activeWorktrees.delete(taskId);

    if (cleanup) {
      await this.cleanupSingleWorktree(targetPath, entry?.branch);
    }
  }

  public async purgeOrphans(): Promise<string[]> {
    if (!existsSync(this.worktreesDir)) {
      return [];
    }

    const purged: string[] = [];
    const entries = readdirSync(this.worktreesDir);
    const activePaths = new Set(Array.from(this.activeWorktrees.values()).map((e) => e.path));

    for (const entryName of entries) {
      const fullPath = join(this.worktreesDir, entryName);
      if (!activePaths.has(fullPath)) {
        await this.cleanupSingleWorktree(fullPath);
        purged.push(entryName);
      }
    }

    if (this.isGitRepository()) {
      spawnSync("git", ["-C", this.workspaceRoot, "worktree", "prune"], {
        encoding: "utf8",
        windowsHide: true,
      });
    }

    return purged;
  }

  private async cleanupSingleWorktree(targetPath: string, branchName?: string): Promise<void> {
    if (this.isGitRepository()) {
      let gitRemoveSuccess = false;
      for (let attempt = 0; attempt < this.maxRetries; attempt++) {
        const removeResult = spawnSync(
          "git",
          ["-C", this.workspaceRoot, "worktree", "remove", "--force", targetPath],
          {
            encoding: "utf8",
            windowsHide: true,
          },
        );

        if (removeResult.status === 0) {
          gitRemoveSuccess = true;
          break;
        }

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * (attempt + 1)));
      }

      if (branchName) {
        spawnSync("git", ["-C", this.workspaceRoot, "branch", "-D", branchName], {
          encoding: "utf8",
          windowsHide: true,
        });
      }

      spawnSync("git", ["-C", this.workspaceRoot, "worktree", "prune"], {
        encoding: "utf8",
        windowsHide: true,
      });
    }

    // Always ensure the directory on disk is removed with Windows file lock retries
    if (existsSync(targetPath)) {
      await this.removeDirectoryWithRetry(targetPath, this.maxRetries, this.retryDelayMs);
    }
  }

  public async removeDirectoryWithRetry(
    dirPath: string,
    maxRetries: number = this.maxRetries,
    delayMs: number = this.retryDelayMs,
  ): Promise<void> {
    if (!existsSync(dirPath)) return;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        rmSync(dirPath, { recursive: true, force: true });
        if (!existsSync(dirPath)) {
          return;
        }
      } catch (err: any) {
        const isLockError =
          err?.code === "EBUSY" ||
          err?.code === "EPERM" ||
          err?.code === "EACCES" ||
          err?.code === "ENOTEMPTY";

        if (!isLockError && attempt === maxRetries - 1) {
          throw err;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }

    // Final attempt if still exists
    if (existsSync(dirPath)) {
      try {
        rmSync(dirPath, { recursive: true, force: true });
      } catch {
        // Safe skip if OS process holds lock indefinitely
      }
    }
  }
}
