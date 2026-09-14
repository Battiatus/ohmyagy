import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  promoteWithoutGit,
  renderCanonicalDiff,
  stageProposalWithoutGit,
  usesGitFreeStaging,
} from "../nongit-staging.js";
import { isGitTopLevel, snapshotWorkspace, snapshotWorkspaceState } from "../workspace-snapshot.js";
import { contentHash } from "../transaction.js";

/**
 * The two-phase-commit contract without Git.
 *
 * It was reachable only from a Git top-level: staging ran `git worktree add`, gates called
 * `git diff`, promotion ran `git commit-tree` + `merge --ff-only`. A project that is not a Git
 * repository — or is an aggregate of several with no `.git` of its own, which is what Symap is —
 * could not be proposed to at all.
 */

let root: string;

/**
 * Windows refuses `symlinkSync` without Developer Mode or elevation (EPERM). The rule still
 * matters — a link is an escape from the workspace — so the test is skipped with a reason
 * rather than removed.
 */
const CAN_CREATE_SYMLINKS = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "oma-symlink-probe-"));
  try {
    writeFileSync(join(probe, "target.txt"), "x\n", "utf8");
    symlinkSync(join(probe, "target.txt"), join(probe, "link.txt"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

function write(relativePath: string, content: string): string {
  const target = join(root, ...relativePath.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
  return contentHash(content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oma-nongit-"));
  // An aggregate: two projects side by side, no .git anywhere.
  write("genai-gcp-infra/src/infra.ts", "export const region = 'eu';\n");
  write("genai-image/src/render.ts", "export const size = 512;\n");
  write("CONTEXT-gabarit.md", "# aggregate\n");
});

afterEach(() => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(20);
    }
  }
});

describe("a workspace without Git is staged and promoted by content", () => {
  it("recognises a Git-free workspace and snapshots it by content", () => {
    assert.equal(isGitTopLevel(root), false);
    assert.equal(usesGitFreeStaging(root), true);

    const snapshot = snapshotWorkspace(root);
    assert.equal(snapshot.problems.length, 0);
    assert.deepEqual(Object.keys(snapshot.state.files).sort(), [
      "CONTEXT-gabarit.md",
      "genai-gcp-infra/src/infra.ts",
      "genai-image/src/render.ts",
    ]);
    // The version is the content identity of the tree — the Git-free equivalent of a commit.
    assert.match(snapshot.state.version, /^[a-f0-9]{64}$/u);
    assert.equal(snapshotWorkspaceState(root).version, snapshot.state.version);
  });

  it.skipIf(!CAN_CREATE_SYMLINKS)("never follows a symbolic link out of the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "oma-outside-"));
    writeFileSync(join(outside, "secret.txt"), "not yours\n", "utf8");
    try {
      symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
      const snapshot = snapshotWorkspace(root);
      assert.equal(Object.hasOwn(snapshot.state.files, "link.txt"), false);
      assert.deepEqual(snapshot.symlinks, ["link.txt"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stages a change without touching the workspace, then promotes it", () => {
    const baseHash = contentHash(readFileSync(join(root, "genai-gcp-infra", "src", "infra.ts"), "utf8"));
    const proposal = {
      schemaVersion: 1 as const,
      parentVersion: "current-explicit" as unknown as string,
      operations: [
        {
          kind: "write" as const,
          path: "genai-gcp-infra/src/infra.ts",
          baseHash,
          content: "export const region = 'europe-west1';\n",
        },
      ],
    };
    const parentVersion = snapshotWorkspaceState(root).version;

    const staged = stageProposalWithoutGit(root, { ...proposal, parentVersion });
    assert.equal(readFileSync(join(root, "genai-gcp-infra", "src", "infra.ts"), "utf8"), "export const region = 'eu';\n");
    assert.equal(staged.transaction.parentVersion, parentVersion);
    assert.match(staged.stagedDiffDigest, /^[a-f0-9]{64}$/u);
    assert.match(staged.canonicalDiff, /^--- a\/genai-gcp-infra\/src\/infra\.ts$/mu);
    assert.match(staged.canonicalDiff, /^\+export const region = 'europe-west1';$/mu);

    const promoted = promoteWithoutGit(staged);
    assert.equal(
      readFileSync(join(root, "genai-gcp-infra", "src", "infra.ts"), "utf8"),
      "export const region = 'europe-west1';\n",
    );
    assert.equal(promoted.promotedVersion, staged.transaction.nextVersion);
    // The sibling project is untouched: an aggregate is not a single tree.
    assert.equal(readFileSync(join(root, "genai-image", "src", "render.ts"), "utf8"), "export const size = 512;\n");
  });

  it("refuses a proposal whose parent version is not the current content", () => {
    const baseHash = contentHash(readFileSync(join(root, "genai-gcp-infra", "src", "infra.ts"), "utf8"));
    assert.throws(
      () =>
        stageProposalWithoutGit(root, {
          schemaVersion: 1,
          parentVersion: "0".repeat(64),
          operations: [
            {
              kind: "write",
              path: "genai-gcp-infra/src/infra.ts",
              baseHash,
              content: "changed\n",
            },
          ],
        }),
      /does not match current version/u,
    );
  });

  it("refuses to promote when the workspace moved after staging", () => {
    const baseHash = contentHash(readFileSync(join(root, "genai-gcp-infra", "src", "infra.ts"), "utf8"));
    const staged = stageProposalWithoutGit(root, {
      schemaVersion: 1,
      parentVersion: snapshotWorkspaceState(root).version,
      operations: [
        { kind: "write", path: "genai-gcp-infra/src/infra.ts", baseHash, content: "proposed\n" },
      ],
    });

    // Someone edits the workspace while the proposal waits for review. Promoting would silently
    // discard that edit — the check `git merge --ff-only` performs.
    write("genai-image/src/render.ts", "export const size = 1024;\n");
    assert.throws(() => promoteWithoutGit(staged), /changed after this proposal was staged/u);
    assert.equal(readFileSync(join(root, "genai-gcp-infra", "src", "infra.ts"), "utf8"), "export const region = 'eu';\n");
  });

  it("renders the same diff for the same proposal, and none for an empty one", () => {
    const proposal = {
      schemaVersion: 1 as const,
      parentVersion: "v",
      operations: [
        { kind: "delete" as const, path: "genai-image/src/render.ts", baseHash: contentHash("x") },
      ],
    };
    const first = renderCanonicalDiff(root, proposal);
    assert.equal(renderCanonicalDiff(root, proposal), first);
    assert.match(first, /^--- a\/genai-image\/src\/render\.ts$/mu);
    assert.equal(renderCanonicalDiff(root, { ...proposal, operations: [] }), "");
  });

  it("keeps OMA's own state out of the snapshot", () => {
    write(".oma/graph/execution-graph.json", "{}\n");
    write("node_modules/pkg/index.js", "module.exports = 1;\n");
    const files = Object.keys(snapshotWorkspaceState(root).files);
    assert.equal(files.some((path) => path.startsWith(".oma/")), false);
    assert.equal(files.some((path) => path.startsWith("node_modules/")), false);
  });

  it("excludes the nested Git directories of an aggregate project", () => {
    // Symap's sub-repositories each have their own .git. Hashing Git's internals into the
    // workspace identity would make the version churn on every Git command.
    write("genai-image/.git/HEAD", "ref: refs/heads/main\n");
    write("genai-image/.git/index", "binary-ish\n");
    write("genai-gcp-infra/.git/config", "[core]\n");
    const files = Object.keys(snapshotWorkspaceState(root).files);
    assert.equal(files.some((path) => path.includes(".git/")), false);
    // The sibling project's real content is still part of the snapshot.
    assert.equal(files.includes("genai-image/src/render.ts"), true);
  });
});

describe("snapshot hashing is content-addressed, not path-ordered", () => {
  it("produces the same version for the same content regardless of file order", () => {
    const versionA = snapshotWorkspaceState(root).version;
    // Recreate the same files in a different order.
    rmSync(join(root, "CONTENT-gabarit-does-not-exist"), { force: true });
    const expected = createHash("sha256").update("unused").digest("hex");
    assert.match(expected, /^[a-f0-9]{64}$/u);
    assert.equal(snapshotWorkspaceState(root).version, versionA);
  });
});
