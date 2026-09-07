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
  type PromotionResult,
  promoteApprovedTransaction,
} from "../../broker/promotion.js";
import { StagedReviewBroker } from "../../broker/staged-review.js";
import {
  discardStagedTransaction,
  snapshotCleanGitWorkspace,
  type StagedTransaction,
} from "../../broker/staging.js";
import { contentHash } from "../../broker/transaction.js";
import { sha256 } from "../../ledger/canonical.js";
import {
  JournalRefusal,
  MissionJournal,
  type RunStartedEvent,
  type SequencedMissionJournalEvent,
  type TransactionPromotedEvent,
} from "../../ledger/mission-journal.js";
import type { ArtifactRef, RunAuthority } from "../model.js";
import {
  evaluateMissionCoverage,
  type MissionJournalView,
} from "../../oracle/coverage.js";
import { evaluateStagedTransaction } from "../../oracle/executor.js";
import { attestReviewFromManifest } from "../../oracle/review.js";
import { ReviewRuntime } from "../../runtime/review.js";

test("#21 attests review before promotion and rejects post-promotion attestation", { timeout: 30000 }, () => {
  const before = createHarness("mission-review-before");
  try {
    const staged = before.stageAuthorChange();
    const approval = approve(staged);
    const review = before.runtime.invoke(
      before.reviewer,
      "review-code",
      "Review the staged transaction.",
      [before.authorArtifact()],
      () => "approved",
    );
    const diffArtifact = review.invocation.inputs.find(
      (input) => input.id === `diff:${staged.transaction.transactionId}`,
    );
    assert.ok(diffArtifact);
    assert.deepEqual(diffArtifact, {
      id: `diff:${staged.transaction.transactionId}`,
      kind: "diff",
      path: `artifacts/diffs/${staged.transaction.transactionId}.diff`,
      sha256: staged.stagedDiffDigest,
      bytes: Buffer.byteLength(staged.canonicalDiff, "utf8"),
      producedByRunKey: before.author.runKey,
      inputHashes: [],
    });
    assert.equal(
      readFileSync(join(before.missionRoot, ...diffArtifact.path.split("/")), "utf8"),
      staged.canonicalDiff,
    );
    assert.match(review.invocation.inputDigest, /^[a-f0-9]{64}$/);

    const promoted = before.broker.promote(
      before.author,
      staged.transaction.transactionId,
      approval,
    );
    assert.equal(promoted.transaction, "promoted");
    const events = before.journal.events();
    const attested = events.find((event) => event.type === "review_attested");
    const promotion = events.find((event) => event.type === "transaction_promoted");
    assert.ok(attested);
    assert.ok(promotion);
    assert.ok(attested.seq < promotion.seq);
    assert.equal(evaluateMissionCoverage(before.journal, "code-change", []).outcome, "approved");
  } finally {
    before.cleanup();
  }

  const after = createHarness("mission-review-after");
  try {
    const staged = after.stageAuthorChange();
    const promoted = promoteOutsideBroker(after, staged);
    after.runtime.invoke(
      after.reviewer,
      "review-code",
      "Review the already promoted transaction.",
      [after.authorArtifact()],
      () => "approved",
    );
    const recorded = withRecordedPromotion(after, staged, promoted, "after-staging");
    const events = recorded.events();
    const promotion = events.find((event) => event.type === "transaction_promoted");
    const attested = events.find((event) => event.type === "review_attested");
    assert.ok(promotion);
    assert.ok(attested);
    assert.ok(attested.seq > promotion.seq);
    const verdict = evaluateMissionCoverage(recorded, "code-change", []);
    assert.equal(verdict.outcome, "rejected");
    assert.equal(verdict.criteria[0]?.outcome, "unsatisfied");
  } finally {
    after.cleanup();
  }
});

test("#21bis refuses staged/promoted digest mismatch as staged_promoted_mismatch", { timeout: 30000 }, () => {
  const harness = createHarness("mission-digest-conflict");
  try {
    const originalHead = git(harness.repositoryRoot, ["rev-parse", "HEAD"]);
    const staged = harness.stageAuthorChange();
    const approval = approve(staged);
    const review = harness.runtime.invoke(
      harness.reviewer,
      "review-code",
      "Review the exact staged bytes.",
      [harness.authorArtifact()],
      () => "approved",
    );
    const attestation = harness.journal.events().find(
      (event) => event.type === "review_attested",
    );
    assert.ok(attestation);
    assert.equal(attestation.subject[0]?.stagedDiffDigest, staged.stagedDiffDigest);
    assert.equal(review.verdict, "approved");

    writeFileSync(join(staged.worktreePath, "a.txt"), "tampered after review", "utf8");
    const result = harness.broker.promote(
      harness.author,
      staged.transaction.transactionId,
      approval,
    );
    assert.deepEqual(result, {
      transaction: "conflict",
      reasonCode: "staged_promoted_mismatch",
      transactionId: staged.transaction.transactionId,
    });
    assert.equal(git(harness.repositoryRoot, ["rev-parse", "HEAD"]), originalHead);
    assert.throws(
      () =>
        harness.journal.appendTransactionPromoted({
          runKey: harness.author.runKey,
          missionId: harness.author.missionId,
          leaseId: harness.author.leaseId,
          epoch: harness.author.epoch,
          transactionId: staged.transaction.transactionId,
          stagedDiffDigest: staged.stagedDiffDigest,
          commitSha: "deadbeef",
          diffDigest: "0".repeat(64),
        }),
      (error: unknown) =>
        error instanceof JournalRefusal &&
        error.transaction === "conflict" &&
        error.reasonCode === "staged_promoted_mismatch",
    );
    assert.equal(
      harness.journal.events().some((event) => event.type === "transaction_promoted"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("#20 rejects partial-diff review because attested subject lacks stagedDiffDigest", { timeout: 30000 }, () => {
  const harness = createHarness("mission-partial-review");
  try {
    const staged = harness.stageAuthorChange();
    harness.journal.appendRunStarted(harness.reviewer);
    const partial = staged.canonicalDiff.slice(0, Math.max(1, staged.canonicalDiff.length - 1));
    const partialPath = "artifacts/partial.diff";
    const partialAbsolutePath = join(harness.missionRoot, ...partialPath.split("/"));
    mkdirSync(join(partialAbsolutePath, ".."), { recursive: true });
    writeFileSync(partialAbsolutePath, partial, "utf8");
    const partialArtifact: ArtifactRef = {
      id: `diff:${staged.transaction.transactionId}`,
      kind: "diff",
      path: partialPath,
      sha256: sha256(partial),
      bytes: Buffer.byteLength(partial, "utf8"),
      producedByRunKey: harness.author.runKey,
      inputHashes: [],
    };
    const attestation = attestReviewFromManifest(
      harness.journal,
      harness.reviewer,
      harness.missionRoot,
      [partialArtifact],
      "approved",
    );
    assert.equal(
      attestation.subject.some(
        (subject) => subject.stagedDiffDigest === staged.stagedDiffDigest,
      ),
      false,
    );

    const promoted = promoteOutsideBroker(harness, staged);
    const recorded = withRecordedPromotion(harness, staged, promoted, "after-events");
    const verdict = evaluateMissionCoverage(recorded, "code-change", []);
    assert.equal(verdict.outcome, "rejected");
    assert.equal(verdict.criteria[0]?.outcome, "unsatisfied");
  } finally {
    harness.cleanup();
  }
});

test("#19 code-change policy requires review coverage without human declaration", { timeout: 30000 }, () => {
  const harness = createHarness("mission-review-omitted");
  try {
    const staged = harness.stageAuthorChange();
    const promoted = promoteOutsideBroker(harness, staged);
    const recorded = withRecordedPromotion(harness, staged, promoted, "after-events");
    const verdict = evaluateMissionCoverage(recorded, "code-change", []);
    assert.equal(verdict.outcome, "rejected");
    assert.deepEqual(verdict.criteria.map((criterion) => criterion.id), [
      "coverage.review-of-every-promotion",
    ]);
    assert.equal(verdict.criteria[0]?.outcome, "unsatisfied");
  } finally {
    harness.cleanup();
  }
});

test("#21ter refuses unreviewed code-change promotion before repository mutation", { timeout: 30000 }, () => {
  const harness = createHarness("mission-unreviewed-refusal");
  try {
    const staged = harness.stageAuthorChange();
    const approval = approve(staged);
    const stagingPath = staged.containerPath;
    const beforeAttempt = snapshotCleanGitWorkspace(harness.repositoryRoot);

    const result = harness.broker.promote(
      harness.author,
      staged.transaction.transactionId,
      approval,
    );

    assert.deepEqual(result, {
      transaction: "rejected",
      reasonCode: "unreviewed_promotion",
      transactionId: staged.transaction.transactionId,
    });
    assert.deepEqual(snapshotCleanGitWorkspace(harness.repositoryRoot), beforeAttempt);
    assert.equal(existsSync(stagingPath), false);
    assert.equal(
      harness.journal.events().some((event) => event.type === "transaction_promoted"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("#21quater same-expert attestation does not unblock promotion", { timeout: 30000 }, () => {
  const harness = createHarness("mission-same-expert-review");
  try {
    const staged = harness.stageAuthorChange();
    const sameExpertReviewer = {
      ...harness.reviewer,
      expertId: harness.author.expertId,
    };
    harness.runtime.invoke(
      sameExpertReviewer,
      "review-code",
      "Review with the author's expert identity.",
      [harness.authorArtifact()],
      () => "approved",
    );

    const result = harness.broker.promote(
      harness.author,
      staged.transaction.transactionId,
      approve(staged),
    );

    assert.deepEqual(result, {
      transaction: "rejected",
      reasonCode: "unreviewed_promotion",
      transactionId: staged.transaction.transactionId,
    });
    assert.equal(
      harness.journal.events().some((event) => event.type === "transaction_promoted"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("non-coverage mission class promotes without a reviewer", { timeout: 30000 }, () => {
  const harness = createHarness("mission-artifact-analysis", "artifact-analysis");
  try {
    const staged = harness.stageAuthorChange();
    const result = harness.broker.promote(
      harness.author,
      staged.transaction.transactionId,
      approve(staged),
    );

    assert.equal(result.transaction, "promoted");
    assert.equal(
      harness.journal.events().some((event) => event.type === "transaction_promoted"),
      true,
    );
  } finally {
    harness.cleanup();
  }
});

interface Harness {
  container: string;
  repositoryRoot: string;
  missionRoot: string;
  journal: MissionJournal;
  broker: StagedReviewBroker;
  runtime: ReviewRuntime;
  author: RunAuthority;
  reviewer: RunAuthority;
  stageAuthorChange(): StagedTransaction;
  authorArtifact(): ArtifactRef;
  cleanup(): void;
}

function createHarness(missionId: string, missionClass = "code-change"): Harness {
  const container = mkdtempSync(join(tmpdir(), "oma-staged-review-test-"));
  const repositoryRoot = join(container, "repo");
  const missionRoot = join(container, "mission");
  mkdirSync(repositoryRoot);
  mkdirSync(missionRoot);
  git(repositoryRoot, ["init"]);
  git(repositoryRoot, ["config", "user.email", "oma-test@example.invalid"]);
  git(repositoryRoot, ["config", "user.name", "OMA Test"]);
  writeFileSync(join(repositoryRoot, "a.txt"), "old", "utf8");
  git(repositoryRoot, ["add", "."]);
  git(repositoryRoot, ["commit", "-m", "fixture"]);

  const journal = new MissionJournal(missionId, missionClass);
  const broker = new StagedReviewBroker(journal);
  const runtime = new ReviewRuntime(journal, broker, missionRoot);
  const author: RunAuthority = {
    missionId,
    runKey: `${missionId}:author`,
    leaseId: `${missionId}:author-lease`,
    epoch: "1",
    expertId: "oma-executor",
  };
  const reviewer: RunAuthority = {
    missionId,
    runKey: `${missionId}:reviewer`,
    leaseId: `${missionId}:reviewer-lease`,
    epoch: "1",
    expertId: "oma-reviewer",
  };
  journal.appendRunStarted(author);
  const stagedTransactions: StagedTransaction[] = [];

  return {
    container,
    repositoryRoot,
    missionRoot,
    journal,
    broker,
    runtime,
    author,
    reviewer,
    stageAuthorChange() {
      const parentVersion = git(repositoryRoot, ["rev-parse", "HEAD"]);
      const staged = broker.stage(author, repositoryRoot, {
        schemaVersion: 1,
        parentVersion,
        operations: [
          {
            kind: "write",
            path: "a.txt",
            baseHash: contentHash("old"),
            content: "new",
          },
        ],
      });
      stagedTransactions.push(staged);
      return staged;
    },
    authorArtifact() {
      const path = "artifacts/author-output.txt";
      const content = "author output";
      const absolutePath = join(missionRoot, ...path.split("/"));
      mkdirSync(join(absolutePath, ".."), { recursive: true });
      writeFileSync(absolutePath, content, "utf8");
      return {
        id: "author-output",
        kind: "text",
        path,
        sha256: sha256(content),
        bytes: Buffer.byteLength(content, "utf8"),
        producedByRunKey: author.runKey,
        inputHashes: [],
      };
    },
    cleanup() {
      for (const staged of stagedTransactions) {
        if (existsSync(staged.containerPath)) {
          discardStagedTransaction(staged);
        }
      }
      rmSync(container, { recursive: true, force: true });
    },
  };
}

function withRecordedPromotion(
  harness: Harness,
  staged: StagedTransaction,
  promoted: PromotionResult,
  position: "after-staging" | "after-events",
): MissionJournalView {
  const events = [...harness.journal.events()];
  const stagedIndex = events.findIndex(
    (event) =>
      event.type === "transaction_staged" &&
      event.transactionId === staged.transaction.transactionId,
  );
  assert.notEqual(stagedIndex, -1);
  const promotion: TransactionPromotedEvent = {
    type: "transaction_promoted",
    runKey: harness.author.runKey,
    missionId: harness.author.missionId,
    leaseId: harness.author.leaseId,
    epoch: harness.author.epoch,
    transactionId: staged.transaction.transactionId,
    stagedDiffDigest: promoted.stagedDiffDigest,
    commitSha: promoted.commitSha,
    diffDigest: promoted.diffDigest,
  };
  const insertionIndex = position === "after-staging" ? stagedIndex + 1 : events.length;
  const sequenced: SequencedMissionJournalEvent[] = [
    ...events.slice(0, insertionIndex),
    promotion,
    ...events.slice(insertionIndex),
  ].map((event, index) => Object.freeze({ ...event, seq: index + 1 }));

  return {
    events: () => Object.freeze([...sequenced]),
    expertIdForRun(runKey: string) {
      return sequenced.find(
        (event): event is RunStartedEvent & { seq: number } =>
          event.type === "run_started" && event.runKey === runKey,
      )?.expertId;
    },
  };
}

function promoteOutsideBroker(
  harness: Harness,
  staged: StagedTransaction,
): PromotionResult {
  return promoteApprovedTransaction(approve(staged), {
    missionId: harness.author.missionId,
    runKey: harness.author.runKey,
    expectedStagedDiffDigest: staged.stagedDiffDigest,
  });
}

function approve(staged: StagedTransaction): unknown {
  const evaluation = evaluateStagedTransaction(staged, [
    {
      id: "author-gate",
      program: process.execPath,
      args: ["-e", "process.stdout.write('approved')"],
      timeoutMs: 10_000,
    },
  ]);
  assert.equal(evaluation.status, "approved");
  if (evaluation.status !== "approved") {
    assert.fail("Expected author transaction approval.");
  }
  return evaluation.approval;
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr ?? result.error?.message);
  return (result.stdout ?? "").trim();
}
