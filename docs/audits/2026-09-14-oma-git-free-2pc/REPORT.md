# 2026-09-14 — the two-phase commit without Git

Layer 5 requires OMA to work with or without Git. The whole mutation path — `propose_change` →
`attest_review` → gates → `promote_change` — was reachable only from a Git top-level.

## What was Git-only

| Step | Git mechanism | Why it blocked |
| --- | --- | --- |
| Discovering the workspace | `git rev-parse --show-toplevel` | `not_git_repository` |
| Snapshotting | `git status --porcelain`, `git rev-parse HEAD`, `ls-files` | needs a repository and a HEAD |
| Staging | `git worktree add --detach <parentVersion>` | needs a commit to check out |
| Gate verification | `git diff --name-only HEAD`, `ls-files --others` | needs an index |
| Promotion | `git commit-tree` + `merge --ff-only` | needs objects and a branch |

Symap is the case that matters: an aggregate of two repositories with **no `.git` at its root**.
Every proposal against it failed at the first row.

## What replaced it

Nothing in the contract actually needed Git. `WorkspaceState` is
`{version, files: path → contentHash}`, and `workspaceStateFromContents` already derives the
version from those hashes — Git was only ever used to *obtain* that state and to *apply* a
change.

- **`src/broker/workspace-snapshot.ts`** walks the tree and hashes every regular file. The
  version is the content identity of the workspace: a commit SHA for a Git-free tree. Symbolic
  links are recorded and skipped, never followed — a link is an escape from the workspace.
- **`src/broker/nongit-staging.ts`** stages by copying the tree into a container and applying the
  operations, verifies the staged tree against the transaction, and renders a **canonical diff**
  from the operations (the text reviewers attest to, and whose `sha256` is the digest).
- **Promotion** re-snapshots the workspace and refuses if it moved since staging — the check
  `git merge --ff-only` performs — then applies the operations in place and verifies the result
  equals the transaction's own `nextVersion`.
- **`parentVersion: "current"`** is accepted as an explicit request for the content as it stands.
  A Git workspace lets a caller read `HEAD`; a Git-free one has nothing to ask, and the
  compare-and-swap still holds from there.

`stageProposal` and `promoteApprovedTransaction` are chosen by whether the root is a Git
top-level. Both paths go through the same `validateProposal`, the same journal assertions
(author, independent reviewer, digest) and the same gates.

## Defect found while proving it on an aggregate

The snapshot's exclusions matched only from the root, so a **nested** `.git` — which every
sub-repository of an aggregate has — was walked and hashed. Git's internals churn on every
command, so the workspace's content identity would have been unstable and enormous. Exclusions
now match by path segment for single-segment rules.

## Verified

`.oma/verify-gitfree-2pc.mjs` drives the real MCP surface against a non-Git aggregate shaped like
Symap (`genai-gcp-infra/` and `genai-image/` side by side, no `.git`):

```
propose_change: isError=false status=staged_pending_review
  workspace untouched after staging: true
attest_review:  isError=false status=review_attested
promote_change: isError=false status=promoted
  file after promotion: "export const region = 'europe-west1';\n"
  promotedVersion=a0de143e…  sibling repository untouched: true
```

`src/broker/__tests__/nongit-staging.test.ts` pins the contract: content snapshot, nested-`.git`
exclusion, staging without touching the workspace, promotion, refusal on a stale parent version,
refusal when the workspace moved after staging, canonical diff stability, and OMA's own state
staying out of the snapshot. The symbolic-link test is skipped with a reason: Windows refuses
`symlinkSync` without elevation (EPERM).

`npm test`: **434 pass, 3 skip, 0 fail**, exit 0.

## Writer experts are dispatched into the container

`dispatch_node` refused any expert that may write, because it ran in the live workspace and a
writer there would bypass the reviewed path. The staging container is the missing place, so the
refusal is gone:

- a **read-only** expert still runs in the workspace, with a read-only sandbox;
- a **writer** runs in an isolated copy of the workspace, and its result is a `changeSet` of
  proposal-ready operations — `{kind, path, baseHash, content}` — plus `changedPaths`. The live
  tree is never edited, the container is discarded, and the change still has to go through
  `propose_change` → review → gates → promote.
- A **binary** change is reported in `binaryPaths` rather than smuggled into a text operation:
  the proposal schema carries contents as text, so a binary edit cannot be reviewed as text and
  must be handled deliberately.

Pinned by tests: the live workspace is byte-identical after a writer dispatch, a modification
carries the hash it replaces, a creation carries `baseHash: null`, and a binary edit lands in
`binaryPaths` with no operation.

## Still open for Layer 5

- Changes **inside** a sub-repository are snapshotted as ordinary files: the aggregate is one
  project to OMA today. Per-sub-repository identity — each with its own parent version — is not
  modelled.
