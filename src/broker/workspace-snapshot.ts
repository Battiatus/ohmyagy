import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { hashJson } from "../ledger/canonical.js";
import { workspaceStateFromContents, type WorkspaceState } from "./transaction.js";

/**
 * Snapshot a workspace by **content**, without Git.
 *
 * The whole two-phase-commit contract — `propose_change` → `attest_review` → gates →
 * `promote_change` — was reachable only from a Git top-level: staging ran `git worktree add`
 * and promotion ran `git commit-tree` + `merge --ff-only`. A project that is not a Git
 * repository, or is an aggregate of several repositories with no `.git` of its own (Symap is
 * exactly that), could not be proposed to at all.
 *
 * Nothing in the contract actually needs Git: `WorkspaceState` is `{version, files:
 * path → contentHash}`, and `workspaceStateFromContents` already derives the version from the
 * file hashes. Git was only ever used to *obtain* that state and to *apply* a transaction. This
 * module replaces the first half.
 */

/** Paths that are OMA's own state or are never part of a change proposal. */
export const DEFAULT_SNAPSHOT_EXCLUDES: readonly string[] = [
  ".git",
  ".oma",
  ".omc",
  ".omo",
  ".agents/plugins/oma",
  "node_modules",
];

export interface SnapshotOptions {
  /** Workspace-relative directories to leave out. Defaults to {@link DEFAULT_SNAPSHOT_EXCLUDES}. */
  excludes?: readonly string[];
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Exclusions match by **path segment** for single-segment rules.
 *
 * An aggregate project is the reason: Symap's two sub-repositories each carry their own `.git`,
 * and matching only the root-level `.git` walked straight into them — hashing Git's internals,
 * which churn on every command, into the workspace's content identity. A rule containing a
 * slash still matches as a prefix from the root.
 */
function isExcluded(relativePath: string, excludes: readonly string[]): boolean {
  const posix = toPosix(relativePath);
  const segments = posix.split("/");
  return excludes.some((exclude) =>
    exclude.includes("/")
      ? posix === exclude || posix.startsWith(`${exclude}/`)
      : segments.includes(exclude),
  );
}

export interface SnapshotResult {
  state: WorkspaceState;
  /** Workspace-relative paths that could not be read, with the reason. */
  problems: string[];
  /** Symbolic links encountered, which are never followed and never included. */
  symlinks: string[];
}

/**
 * Hash every regular file under `root`.
 *
 * Symbolic links are recorded and skipped rather than followed: a link is an escape from the
 * workspace, and the Git path refuses them in transaction paths for the same reason.
 */
export function snapshotWorkspace(root: string, options: SnapshotOptions = {}): SnapshotResult {
  const resolvedRoot = resolve(root);
  const excludes = options.excludes ?? DEFAULT_SNAPSHOT_EXCLUDES;
  const contents: Record<string, Buffer> = {};
  const problems: string[] = [];
  const symlinks: string[] = [];

  const walk = (directory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      problems.push(`${toPosix(relative(resolvedRoot, directory))}: ${messageOf(error)}`);
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      const relativePath = toPosix(relative(resolvedRoot, absolute));
      if (isExcluded(relativePath, excludes)) continue;

      let stats: ReturnType<typeof lstatSync>;
      try {
        stats = lstatSync(absolute);
      } catch (error) {
        problems.push(`${relativePath}: ${messageOf(error)}`);
        continue;
      }
      if (stats.isSymbolicLink()) {
        symlinks.push(relativePath);
        continue;
      }
      if (stats.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stats.isFile()) continue;
      try {
        contents[relativePath] = readFileSync(absolute);
      } catch (error) {
        problems.push(`${relativePath}: ${messageOf(error)}`);
      }
    }
  };

  walk(resolvedRoot);

  return {
    // `workspaceStateFromContents` derives the version from the file hashes, so the version is
    // the workspace's content identity — the equivalent of a commit SHA for a Git-free tree.
    state: workspaceStateFromContents(contents),
    problems,
    symlinks,
  };
}

/** Content-addressed state of a workspace, ignoring paths that are not part of a change. */
export function snapshotWorkspaceState(root: string, options?: SnapshotOptions): WorkspaceState {
  return snapshotWorkspace(root, options).state;
}

/** True when `root` is the top level of a Git repository. */
export function isGitTopLevel(root: string): boolean {
  const resolved = resolve(root);
  if (!existsSync(resolved)) return false;
  try {
    if (!statSync(resolved).isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(join(resolved, ".git"));
}

/** Identity of a file set, for comparing two snapshots without materialising either. */
export function hashSnapshotFiles(files: Readonly<Record<string, string>>): string {
  return hashJson(files);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
