import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "../ledger/canonical.js";
import {
  StagingError,
  assertNoSymlinkAncestor,
  assertOwnedStagingPaths,
  resolveSafeTarget,
  type StagedTransaction,
} from "./staging.js";
import { validateProposal, contentHash, type ChangeProposal } from "./transaction.js";
import {
  DEFAULT_SNAPSHOT_EXCLUDES,
  isGitTopLevel,
  snapshotWorkspace,
  snapshotWorkspaceState,
} from "./workspace-snapshot.js";

/**
 * The two-phase-commit contract for a workspace that is not a Git repository.
 *
 * Same shape as the Git path — `StagedTransaction` in, gates and reviews in between, a promoted
 * version out — with content hashes playing the role of commits:
 *
 *  * the **parent version** is the content identity of the workspace, not `HEAD`;
 *  * staging copies the tree into a container instead of `git worktree add --detach`;
 *  * the **canonical diff** is rendered from the proposal's operations instead of `git diff`;
 *  * promotion re-snapshots the workspace and refuses if it moved since staging — the check
 *    `git merge --ff-only` performs — then applies the operations in place.
 *
 * That is what lets OMA work on a project like Symap: an aggregate of two repositories with no
 * `.git` at its root, where the Git path refuses everything with `not_git_repository`.
 */

/** True when `root` should take the Git-free path. */
export function usesGitFreeStaging(root: string): boolean {
  return !isGitTopLevel(root);
}

/**
 * Copy a workspace into a container, applying the same exclusions the snapshot uses.
 *
 * Exported because a writer expert must be dispatched into an isolated copy rather than into the
 * live tree: `dispatch_node` for a writer uses this to give the expert somewhere to work whose
 * output is a change set for the reviewed path, not an edit to the project.
 */
export function copyWorkspaceTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (entry) => {
      const relative = entry.slice(source.length).replace(/^[\\/]+/u, "").split(/[\\/]/u).join("/");
      if (relative.length === 0) return true;
      return !DEFAULT_SNAPSHOT_EXCLUDES.some(
        (exclude) => relative === exclude || relative.startsWith(`${exclude}/`),
      );
    },
  });
}

/** A deterministic, reviewable rendering of the proposal. */
export function renderCanonicalDiff(
  root: string,
  proposal: ChangeProposal,
): string {
  const lines: string[] = [];
  for (const operation of [...proposal.operations].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const target = resolveSafeTarget(root, operation.path);
    const before =
      operation.kind === "delete"
        ? (existsSync(target) ? readFileSync(target, "utf8") : "")
        : existsSync(target)
          ? readFileSync(target, "utf8")
          : "";
    const after = operation.kind === "write" ? operation.content : "";
    lines.push(`--- a/${operation.path}`);
    lines.push(`+++ b/${operation.path}`);
    lines.push(...renderHunk(before, after));
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Trim the unchanged head and tail, then emit the changed block.
 *
 * Not a minimal diff — a canonical one. Reviewers attest to `sha256(canonicalDiff)`, so what
 * matters is that the same proposal always renders the same text, and that no change is hidden.
 */
function renderHunk(before: string, after: string): string[] {
  const beforeLines = before.length === 0 ? [] : before.split(/\r?\n/u);
  const afterLines = after.length === 0 ? [] : after.split(/\r?\n/u);
  let head = 0;
  while (
    head < beforeLines.length &&
    head < afterLines.length &&
    beforeLines[head] === afterLines[head]
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const removed = beforeLines.slice(head, beforeLines.length - tail);
  const added = afterLines.slice(head, afterLines.length - tail);
  if (removed.length === 0 && added.length === 0) return ["@@ no change @@"];
  const hunk = [`@@ -${head + 1},${removed.length} +${head + 1},${added.length} @@`];
  hunk.push(...removed.map((line) => `-${line}`));
  hunk.push(...added.map((line) => `+${line}`));
  return hunk;
}

/** Expected file hashes after the proposal is applied. */
function expectedFiles(
  base: Readonly<Record<string, string>>,
  proposal: ChangeProposal,
): Record<string, string> {
  const next: Record<string, string> = { ...base };
  for (const operation of proposal.operations) {
    if (operation.kind === "delete") delete next[operation.path];
    else next[operation.path] = contentHash(operation.content);
  }
  return next;
}

export function stageProposalWithoutGit(
  workspaceRoot: string,
  proposal: ChangeProposal | unknown,
): StagedTransaction {
  const snapshot = snapshotWorkspace(workspaceRoot);
  if (snapshot.problems.length > 0) {
    // A partial snapshot yields a version that does not describe the workspace, and every later
    // comparison would be against a lie. Refuse instead of proceeding.
    throw new StagingError(
      "stage_state_mismatch",
      `Cannot snapshot workspace ${workspaceRoot}: ${snapshot.problems.join("; ")}`,
    );
  }
  const transaction = validateProposal(snapshot.state, proposal);
  const containerPath = mkdtempSync(join(tmpdir(), "oma-stage-"));
  const worktreePath = join(containerPath, "worktree");

  try {
    copyWorkspaceTree(workspaceRoot, worktreePath);

    for (const operation of transaction.operations) {
      const target = resolveSafeTarget(worktreePath, operation.path);
      assertNoSymlinkAncestor(worktreePath, operation.path);
      if (operation.kind === "write") {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, operation.content, "utf8");
      } else if (existsSync(target)) {
        unlinkSync(target);
      }
    }

    // The staged tree must describe exactly the transaction, no more and no less.
    const stagedState = snapshotWorkspaceState(worktreePath);
    const expected = expectedFiles(snapshot.state.files, transaction);
    const mismatched = Object.keys({ ...expected, ...stagedState.files }).filter(
      (path) => expected[path] !== stagedState.files[path],
    );
    if (mismatched.length > 0) {
      throw new StagingError(
        "stage_state_mismatch",
        `Staged tree does not match the proposal for: ${mismatched.join(", ")}.`,
        worktreePath,
      );
    }

    const canonicalDiff = renderCanonicalDiff(workspaceRoot, transaction);
    return {
      repositoryRoot: workspaceRoot,
      containerPath,
      worktreePath,
      transaction,
      canonicalDiff,
      stagedDiffDigest: sha256(canonicalDiff),
    };
  } catch (error) {
    rmSync(containerPath, { recursive: true, force: true });
    if (error instanceof StagingError) throw error;
    throw new StagingError(
      "stage_apply_failed",
      `Staging failed and the container was discarded: ${error instanceof Error ? error.message : String(error)}`,
      worktreePath,
    );
  }
}

export interface GitFreePromotion {
  promotedVersion: string;
  diff: string;
}

/**
 * Apply an approved transaction to the workspace.
 *
 * The re-snapshot before writing is the git-free equivalent of `merge --ff-only`: if the
 * workspace moved since the proposal was staged, the staging is stale and promoting it would
 * silently discard whatever moved.
 */
export function promoteWithoutGit(staged: StagedTransaction): GitFreePromotion {
  assertOwnedStagingPaths(staged.containerPath, staged.worktreePath);

  const current = snapshotWorkspaceState(staged.repositoryRoot);
  if (current.version !== staged.transaction.parentVersion) {
    throw new StagingError(
      "stage_state_mismatch",
      `The workspace changed after this proposal was staged (expected ${staged.transaction.parentVersion}, found ${current.version}). Re-propose against the current content.`,
      staged.worktreePath,
    );
  }

  for (const operation of staged.transaction.operations) {
    const target = resolveSafeTarget(staged.repositoryRoot, operation.path);
    assertNoSymlinkAncestor(staged.repositoryRoot, operation.path);
    if (operation.kind === "write") {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, operation.content, "utf8");
    } else if (existsSync(target)) {
      unlinkSync(target);
    }
  }

  const promoted = snapshotWorkspaceState(staged.repositoryRoot);
  if (promoted.version !== staged.transaction.nextVersion) {
    throw new StagingError(
      "stage_apply_failed",
      `Promoted workspace does not match the expected version (expected ${staged.transaction.nextVersion}, found ${promoted.version}).`,
    );
  }

  return { promotedVersion: promoted.version, diff: staged.canonicalDiff };
}

/** Remove a staging container. */
export function discardGitFreeStage(staged: StagedTransaction): void {
  assertOwnedStagingPaths(staged.containerPath, staged.worktreePath);
  rmSync(staged.containerPath, { recursive: true, force: true });
}
