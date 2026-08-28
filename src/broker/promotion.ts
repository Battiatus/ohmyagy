import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hashJson } from "../control/canonical.js";
import { OracleError, claimApproval } from "../oracle/executor.js";
import {
  StagedTransaction,
  assertStagedTransactionState,
  discardStagedTransaction,
  snapshotCleanGitWorkspace,
} from "./staging.js";

export type PromotionErrorCode =
  | "not_approved"
  | "detached_source"
  | "stale_parent"
  | "git_command_failed"
  | "promotion_failed"
  | "postcondition_failed";

export class PromotionError extends Error {
  constructor(
    public readonly code: PromotionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PromotionError";
  }
}

export interface PromotionResult {
  transactionId: string;
  verdictHash: string;
  parentVersion: string;
  promotedVersion: string;
  targetRef: string;
}

export function promoteApprovedTransaction(approval: unknown): PromotionResult {
  let claimed;
  try {
    claimed = claimApproval(approval);
  } catch (error) {
    if (error instanceof OracleError) {
      throw new PromotionError("not_approved", error.message);
    }
    throw error;
  }

  const { staged, verdictHash } = claimed;
  try {
    assertStagedTransactionState(staged);
    const source = snapshotCleanGitWorkspace(staged.repositoryRoot);
    if (source.version !== staged.transaction.parentVersion) {
      throw new PromotionError(
        "stale_parent",
        `Source HEAD ${source.version} no longer matches ${staged.transaction.parentVersion}.`,
      );
    }
    const targetRefResult = runGitAllowFailure(staged.repositoryRoot, [
      "symbolic-ref",
      "-q",
      "HEAD",
    ]);
    if (targetRefResult.status !== 0) {
      throw new PromotionError(
        "detached_source",
        "Atomic promotion requires the source workspace to be on a branch.",
      );
    }
    const targetRef = targetRefResult.stdout.trim();

    runGit(staged.worktreePath, ["add", "-A"]);
    assertStagedTransactionState(staged);
    const treeHash = runGit(staged.worktreePath, ["write-tree"]).trim();
    const commitMessage = [
      `OMA transaction ${staged.transaction.transactionId}`,
      "",
      `Oracle-Verdict: ${verdictHash}`,
      "",
    ].join("\n");
    const commitResult = runGitAllowFailure(
      staged.worktreePath,
      ["commit-tree", treeHash, "-p", staged.transaction.parentVersion],
      {
        input: commitMessage,
        env: {
          GIT_AUTHOR_NAME: "OMA Broker",
          GIT_AUTHOR_EMAIL: "oma-broker@local.invalid",
          GIT_COMMITTER_NAME: "OMA Broker",
          GIT_COMMITTER_EMAIL: "oma-broker@local.invalid",
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        },
      },
    );
    if (commitResult.status !== 0) {
      throw new PromotionError(
        "git_command_failed",
        `git commit-tree failed: ${commitResult.stderr.trim()}`,
      );
    }
    const promotedVersion = commitResult.stdout.trim();
    const hooksPath = join(staged.containerPath, "empty-hooks");
    mkdirSync(hooksPath);
    const mergeResult = runGitAllowFailure(staged.repositoryRoot, [
      "-c",
      `core.hooksPath=${hooksPath}`,
      "merge",
      "--ff-only",
      "--no-edit",
      promotedVersion,
    ]);
    if (mergeResult.status !== 0) {
      throw new PromotionError(
        "promotion_failed",
        `Fast-forward promotion failed: ${mergeResult.stderr.trim()}`,
      );
    }

    const promoted = snapshotCleanGitWorkspace(staged.repositoryRoot);
    if (
      promoted.version !== promotedVersion ||
      hashJson(promoted.files) !== staged.transaction.nextVersion
    ) {
      throw new PromotionError(
        "postcondition_failed",
        "Promoted Git state does not match the accepted transaction state.",
      );
    }
    discardStagedTransaction(staged);
    return {
      transactionId: staged.transaction.transactionId,
      verdictHash,
      parentVersion: staged.transaction.parentVersion,
      promotedVersion,
      targetRef,
    };
  } catch (error) {
    discardIfPresent(staged);
    if (error instanceof PromotionError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new PromotionError("promotion_failed", message);
  }
}

function discardIfPresent(staged: StagedTransaction): void {
  if (existsSync(staged.containerPath)) {
    discardStagedTransaction(staged);
  }
}

function runGit(root: string, args: string[]): string {
  const result = runGitAllowFailure(root, args);
  if (result.status !== 0) {
    throw new PromotionError(
      "git_command_failed",
      `git ${args.join(" ")} failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function runGitAllowFailure(
  root: string,
  args: string[],
  options: {
    input?: string;
    env?: Record<string, string>;
  } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    input: options.input,
    env: { ...process.env, ...options.env },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}
