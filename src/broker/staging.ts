import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "../ledger/canonical.js";
import {
  ChangeProposal,
  ValidatedTransaction,
  WorkspaceState,
  validateProposal,
  workspaceStateFromContents,
} from "./transaction.js";
import { isGitTopLevel } from "./workspace-snapshot.js";

export type StagingErrorCode =
  | "not_git_repository"
  | "dirty_workspace"
  | "git_command_failed"
  | "symlink_forbidden"
  | "stage_apply_failed"
  | "stage_state_mismatch"
  | "unsafe_cleanup_target";

export class StagingError extends Error {
  constructor(
    public readonly code: StagingErrorCode,
    message: string,
    public readonly stagingPath?: string,
  ) {
    super(message);
    this.name = "StagingError";
  }
}

export interface GitWorkspaceState extends WorkspaceState {
  repositoryRoot: string;
}

export interface StagedTransaction {
  repositoryRoot: string;
  containerPath: string;
  worktreePath: string;
  transaction: ValidatedTransaction;
  canonicalDiff: string;
  stagedDiffDigest: string;
}

export function snapshotCleanGitWorkspace(repositoryRoot: string): GitWorkspaceState {
  const root = requireRepositoryRoot(repositoryRoot);
  const status = runGit(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).oma/**",
    ":(exclude).agents/plugins/oma/**",
    ":(exclude).omc/**",
    ":(exclude).omo/**",
  ]);
  if (status.length !== 0) {
    throw new StagingError(
      "dirty_workspace",
      "The broker only stages proposals from a clean committed workspace.",
    );
  }
  const head = runGit(root, ["rev-parse", "HEAD"]).trim();
  return {
    ...snapshotGitWorkingTree(root, head),
    repositoryRoot: root,
  };
}

export function stageProposal(
  repositoryRoot: string,
  proposal: ChangeProposal | unknown,
): StagedTransaction {
  const source = snapshotCleanGitWorkspace(repositoryRoot);
  const transaction = validateProposal(source, proposal);
  const containerPath = mkdtempSync(join(tmpdir(), "oma-stage-"));
  const worktreePath = join(containerPath, "worktree");

  try {
    runGit(source.repositoryRoot, [
      "worktree",
      "add",
      "--detach",
      worktreePath,
      transaction.parentVersion,
    ]);
    const stagedBase = snapshotCleanGitWorkspace(worktreePath);
    if (stagedBase.version !== transaction.parentVersion) {
      throw new StagingError(
        "stage_state_mismatch",
        "The detached worktree does not match the accepted parent version.",
        worktreePath,
      );
    }

    for (const operation of transaction.operations) {
      const target = resolveSafeTarget(worktreePath, operation.path);
      assertNoSymlinkAncestor(worktreePath, operation.path);
      if (operation.kind === "write") {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, operation.content, "utf8");
      } else {
        unlinkSync(target);
      }
    }

    runGit(worktreePath, ["add", "-A"]);
    const canonicalDiff = canonicalStagedDiff(worktreePath);

    const staged = {
      repositoryRoot: source.repositoryRoot,
      containerPath,
      worktreePath,
      transaction,
      canonicalDiff,
      stagedDiffDigest: sha256(canonicalDiff),
    };
    assertStagedTransactionState(staged);
    return staged;
  } catch (error) {
    cleanupFailedStage(source.repositoryRoot, containerPath, worktreePath);
    if (error instanceof StagingError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new StagingError(
      "stage_apply_failed",
      `Staging failed and the worktree was discarded: ${message}`,
      worktreePath,
    );
  }
}

export function refreshCanonicalStagedDiff(staged: StagedTransaction): string {
  assertOwnedStagingPaths(staged.containerPath, staged.worktreePath);
  runGit(staged.worktreePath, ["add", "-A"]);
  return canonicalStagedDiff(staged.worktreePath);
}

export function canonicalCommitDiff(
  repositoryRoot: string,
  parentVersion: string,
  commitSha: string,
): string {
  return runGit(repositoryRoot, [
    ...canonicalDiffOptions(),
    parentVersion,
    commitSha,
    "--",
  ]);
}

export function discardStagedTransaction(staged: StagedTransaction): void {
  assertOwnedStagingPaths(staged.containerPath, staged.worktreePath);
  const result = runGitAllowFailure(staged.repositoryRoot, [
    "worktree",
    "remove",
    "--force",
    staged.worktreePath,
  ]);
  if (result.status !== 0) {
    throw new StagingError(
      "git_command_failed",
      `Unable to remove staging worktree: ${result.stderr.trim()}`,
      staged.worktreePath,
    );
  }
  rmSync(staged.containerPath, { recursive: true, force: true });
  runGit(staged.repositoryRoot, ["worktree", "prune"]);
}

export function assertStagedTransactionState(staged: StagedTransaction): void {
  assertOwnedStagingPaths(staged.containerPath, staged.worktreePath);

  // A Git-free staging container is not a repository, so `git diff`/`ls-files` cannot describe
  // it. The exhaustive path-set check already ran when the container was built; what a gate
  // needs here is that each proposed path holds exactly what the transaction says.
  if (!isGitTopLevel(staged.worktreePath)) {
    for (const operation of staged.transaction.operations) {
      const target = resolveSafeTarget(staged.worktreePath, operation.path);
      if (operation.kind === "delete") {
        if (existsSync(target)) {
          throw new StagingError(
            "stage_state_mismatch",
            `Deleted path still exists in staging: ${operation.path}.`,
            staged.worktreePath,
          );
        }
        continue;
      }
      if (!existsSync(target) || readFileSync(target, "utf8") !== operation.content) {
        throw new StagingError(
          "stage_state_mismatch",
          `Staged content does not match proposal for ${operation.path}.`,
          staged.worktreePath,
        );
      }
    }
    return;
  }

  const changed = new Set(
    runGit(staged.worktreePath, ["diff", "--name-only", "-z", "HEAD", "--"])
      .split("\0")
      .filter(Boolean),
  );
  for (const path of runGit(staged.worktreePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .split("\0")
    .filter(Boolean)) {
    changed.add(path);
  }
  const expected = new Set(staged.transaction.operations.map((operation) => operation.path));
  const unexpected = [...changed].filter((path) => !expected.has(path));
  const missing = [...expected].filter((path) => !changed.has(path));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new StagingError(
      "stage_state_mismatch",
      `Staged path set mismatch; missing=[${missing.join(",")}], unexpected=[${unexpected.join(",")}].`,
      staged.worktreePath,
    );
  }
  for (const operation of staged.transaction.operations) {
    const target = resolveSafeTarget(staged.worktreePath, operation.path);
    if (operation.kind === "delete") {
      if (existsSync(target)) {
        throw new StagingError(
          "stage_state_mismatch",
          `Deleted path still exists in staging: ${operation.path}.`,
          staged.worktreePath,
        );
      }
      continue;
    }
    if (!existsSync(target) || readFileSync(target, "utf8") !== operation.content) {
      throw new StagingError(
        "stage_state_mismatch",
        `Staged content does not match proposal for ${operation.path}.`,
        staged.worktreePath,
      );
    }
  }
}

function snapshotGitWorkingTree(root: string, version?: string): WorkspaceState {
  const trackedPaths = runGit(root, [
    "ls-files",
    "-z",
    "--cached",
    "--",
    ".",
    ":(exclude).oma/**",
    ":(exclude).agents/plugins/oma/**",
    ":(exclude).omc/**",
    ":(exclude).omo/**",
  ]).split("\0").filter(Boolean);
  const untrackedPaths = runGit(root, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
    "--",
    ".",
    ":(exclude).oma/**",
    ":(exclude).agents/plugins/oma/**",
    ":(exclude).omc/**",
    ":(exclude).omo/**",
  ]).split("\0").filter(Boolean);
  const tracked = new Set(trackedPaths);
  const contents: Record<string, Buffer> = {};
  for (const path of [...new Set([...trackedPaths, ...untrackedPaths])].sort()) {
    const absolutePath = resolveSafeTarget(root, path);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new StagingError(
        "symlink_forbidden",
        `Git workspace contains forbidden symlink ${path}.`,
      );
    }
    if (!stat.isFile()) {
      continue;
    }
    contents[path] = tracked.has(path)
      ? readGitBlob(root, version ?? "HEAD", path)
      : readFileSync(absolutePath);
  }
  return workspaceStateFromContents(contents, version);
}

function readGitBlob(root: string, revision: string, path: string): Buffer {
  const result = spawnSync("git", ["-C", root, "show", `${revision}:${path}`], {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) {
    throw new StagingError(
      "git_command_failed",
      `git show ${revision}:${path} failed: ${String(result.stderr ?? "").trim()}`,
    );
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
}

function requireRepositoryRoot(inputRoot: string): string {
  const resolvedInput = resolve(inputRoot);
  const result = runGitAllowFailure(resolvedInput, ["rev-parse", "--show-toplevel"]);
  if (result.status !== 0) {
    throw new StagingError(
      "not_git_repository",
      `Not a Git repository: ${resolvedInput}`,
    );
  }
  const reportedRoot = resolve(result.stdout.trim());
  const canonicalInput = realpathSync(resolvedInput);
  const canonicalRoot = realpathSync(reportedRoot);
  if (canonicalInput.toLocaleLowerCase("en-US") !== canonicalRoot.toLocaleLowerCase("en-US")) {
    throw new StagingError(
      "not_git_repository",
      `Broker root must be the Git top-level directory: ${canonicalRoot}`,
    );
  }
  return canonicalRoot;
}

export function resolveSafeTarget(root: string, transactionPath: string): string {
  if (isAbsolute(transactionPath)) {
    throw new StagingError("stage_apply_failed", `Absolute path rejected: ${transactionPath}`);
  }
  const target = resolve(root, ...transactionPath.split("/"));
  const fromRoot = relative(resolve(root), target);
  if (fromRoot.length === 0 || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new StagingError(
      "stage_apply_failed",
      `Transaction path escapes staging root: ${transactionPath}`,
    );
  }
  return target;
}

export function assertNoSymlinkAncestor(root: string, transactionPath: string): void {
  let current = resolve(root);
  const segments = transactionPath.split("/");
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new StagingError(
        "symlink_forbidden",
        `Transaction path crosses symlink ${transactionPath}.`,
      );
    }
  }
}

function cleanupFailedStage(
  repositoryRoot: string,
  containerPath: string,
  worktreePath: string,
): void {
  assertOwnedStagingPaths(containerPath, worktreePath);
  runGitAllowFailure(repositoryRoot, ["worktree", "remove", "--force", worktreePath]);
  rmSync(containerPath, { recursive: true, force: true });
  runGitAllowFailure(repositoryRoot, ["worktree", "prune"]);
}

export function assertOwnedStagingPaths(containerPath: string, worktreePath: string): void {
  const resolvedContainer = resolve(containerPath);
  const resolvedTemp = resolve(tmpdir());
  const fromTemp = relative(resolvedTemp, resolvedContainer);
  if (
    fromTemp.length === 0 ||
    fromTemp.startsWith("..") ||
    isAbsolute(fromTemp) ||
    !basename(resolvedContainer).startsWith("oma-stage-") ||
    resolve(worktreePath) !== join(resolvedContainer, "worktree")
  ) {
    throw new StagingError(
      "unsafe_cleanup_target",
      `Refusing to clean unowned staging path ${resolvedContainer}.`,
      worktreePath,
    );
  }
}

function runGit(root: string, args: string[]): string {
  const result = runGitAllowFailure(root, args);
  if (result.status !== 0) {
    throw new StagingError(
      "git_command_failed",
      `git ${args.join(" ")} failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function canonicalStagedDiff(worktreePath: string): string {
  return runGit(worktreePath, [
    ...canonicalDiffOptions(),
    "--cached",
    "HEAD",
    "--",
  ]);
}

function canonicalDiffOptions(): string[] {
  return [
    "-c",
    "diff.algorithm=myers",
    "-c",
    "diff.renames=false",
    "-c",
    "core.quotePath=false",
    "diff",
    "--binary",
    "--full-index",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ];
}

function runGitAllowFailure(
  root: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
    timeout: 10000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}
