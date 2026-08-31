import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MissionJournal, JournalRefusal, subjectDigest, } from "../mission-journal.js";
import { sha256 } from "../canonical.js";
test("MissionJournal with JournalStore persists events with valid hash chain to events.jsonl", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-mission-journal-test-"));
    const journalPath = join(root, "events.jsonl");
    try {
        const journal = new MissionJournal("test-mission-01", "code-change", {
            journalStorePath: journalPath,
        });
        assert.ok(journal.store);
        assert.equal(existsSync(journalPath), true);
        const run1 = journal.appendRunStarted({
            missionId: "test-mission-01",
            runKey: "run-worker-1",
            expertId: "oma-executor",
        });
        assert.equal(run1.seq, 1);
        const diffDigest = sha256("test-diff-contents");
        const staged = journal.appendTransactionStaged({
            missionId: "test-mission-01",
            runKey: "run-worker-1",
            leaseId: "lease-01",
            epoch: "1",
            transactionId: "tx-001",
            stagedDiffDigest: diffDigest,
        });
        assert.equal(staged.seq, 2);
        const run2 = journal.appendRunStarted({
            missionId: "test-mission-01",
            runKey: "run-reviewer-1",
            expertId: "oma-reviewer",
        });
        assert.equal(run2.seq, 3);
        const reviewSubject = [
            {
                runKey: "run-worker-1",
                transactionId: "tx-001",
                stagedDiffDigest: diffDigest,
                artifactHashes: [],
            },
        ];
        const attested = journal.appendOracleReviewAttested({
            missionId: "test-mission-01",
            runKey: "run-reviewer-1",
            reviewerRunKey: "run-reviewer-1",
            leaseId: "lease-02",
            epoch: "1",
            subject: reviewSubject,
            subjectDigest: subjectDigest(reviewSubject),
            reviewerVerdict: "approved",
        });
        assert.equal(attested.seq, 4);
        const promoted = journal.appendTransactionPromoted({
            missionId: "test-mission-01",
            runKey: "run-worker-1",
            leaseId: "lease-01",
            epoch: "1",
            transactionId: "tx-001",
            stagedDiffDigest: diffDigest,
            commitSha: "c0ffee1234567890abcdef1234567890abcdef12",
            diffDigest,
        });
        assert.equal(promoted.seq, 5);
        // Verify hash chain integrity
        const integrity = journal.store.verifyIntegrity();
        assert.equal(integrity.valid, true);
        const lines = readFileSync(journalPath, "utf8").trim().split("\n");
        assert.equal(lines.length, 5);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("MissionJournal re-opens existing events.jsonl and replays full state", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-mission-journal-replay-"));
    const journalPath = join(root, "events.jsonl");
    try {
        const diffDigest = sha256("code-change-v1");
        // Session 1: Create journal and append staged transaction and review
        {
            const journal1 = new MissionJournal("replay-mission", "code-change", journalPath);
            journal1.appendRunStarted({
                missionId: "replay-mission",
                runKey: "author-1",
                expertId: "oma-executor",
            });
            journal1.appendTransactionStaged({
                missionId: "replay-mission",
                runKey: "author-1",
                leaseId: "lease-1",
                epoch: "1",
                transactionId: "tx-replay-1",
                stagedDiffDigest: diffDigest,
            });
            journal1.appendRunStarted({
                missionId: "replay-mission",
                runKey: "reviewer-1",
                expertId: "oma-reviewer",
            });
            const subject = [
                {
                    runKey: "author-1",
                    transactionId: "tx-replay-1",
                    stagedDiffDigest: diffDigest,
                    artifactHashes: [],
                },
            ];
            journal1.appendOracleReviewAttested({
                missionId: "replay-mission",
                runKey: "reviewer-1",
                reviewerRunKey: "reviewer-1",
                leaseId: "lease-2",
                epoch: "1",
                subject,
                subjectDigest: subjectDigest(subject),
                reviewerVerdict: "approved",
            });
            assert.equal(journal1.events().length, 4);
        }
        // Session 2: Re-open journal from existing events.jsonl
        {
            const journal2 = new MissionJournal("replay-mission", "code-change", {
                journalStorePath: journalPath,
            });
            assert.equal(journal2.events().length, 4);
            assert.equal(journal2.expertIdForRun("author-1"), "oma-executor");
            assert.equal(journal2.expertIdForRun("reviewer-1"), "oma-reviewer");
            // Verify promotion allowed check succeeds from replayed state
            assert.doesNotThrow(() => {
                journal2.assertPromotionAllowed({
                    missionId: "replay-mission",
                    runKey: "author-1",
                    leaseId: "lease-1",
                    epoch: "1",
                    transactionId: "tx-replay-1",
                    stagedDiffDigest: diffDigest,
                    diffDigest,
                });
            });
            // Complete promotion in session 2
            const promoted = journal2.appendTransactionPromoted({
                missionId: "replay-mission",
                runKey: "author-1",
                leaseId: "lease-1",
                epoch: "1",
                transactionId: "tx-replay-1",
                stagedDiffDigest: diffDigest,
                commitSha: "aabbccddeeff00112233445566778899aabbccdd",
                diffDigest,
            });
            assert.equal(promoted.seq, 5);
            assert.equal(journal2.events().length, 5);
            const integrity = journal2.store.verifyIntegrity();
            assert.equal(integrity.valid, true);
        }
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("MissionJournal rejects self-review and unreviewed promotion", () => {
    const journal = new MissionJournal("security-mission", "code-change");
    journal.appendRunStarted({
        missionId: "security-mission",
        runKey: "author-run",
        expertId: "same-expert",
    });
    const diffDigest = sha256("sec-diff");
    journal.appendTransactionStaged({
        missionId: "security-mission",
        runKey: "author-run",
        leaseId: "lease-1",
        epoch: "1",
        transactionId: "tx-sec-1",
        stagedDiffDigest: diffDigest,
    });
    // Attempting promotion before review must fail
    assert.throws(() => {
        journal.assertPromotionAllowed({
            missionId: "security-mission",
            runKey: "author-run",
            leaseId: "lease-1",
            epoch: "1",
            transactionId: "tx-sec-1",
            stagedDiffDigest: diffDigest,
            diffDigest,
        });
    }, (err) => err instanceof JournalRefusal && err.reasonCode === "unreviewed_promotion");
    // Reviewer with SAME expertId (self-review)
    journal.appendRunStarted({
        missionId: "security-mission",
        runKey: "reviewer-run",
        expertId: "same-expert", // Same as author!
    });
    const subject = [
        {
            runKey: "author-run",
            transactionId: "tx-sec-1",
            stagedDiffDigest: diffDigest,
            artifactHashes: [],
        },
    ];
    journal.appendOracleReviewAttested({
        missionId: "security-mission",
        runKey: "reviewer-run",
        reviewerRunKey: "reviewer-run",
        leaseId: "lease-2",
        epoch: "1",
        subject,
        subjectDigest: subjectDigest(subject),
        reviewerVerdict: "approved",
    });
    // Promotion must STILL be refused because Author == Reviewer expertId
    assert.throws(() => {
        journal.assertPromotionAllowed({
            missionId: "security-mission",
            runKey: "author-run",
            leaseId: "lease-1",
            epoch: "1",
            transactionId: "tx-sec-1",
            stagedDiffDigest: diffDigest,
            diffDigest,
        });
    }, (err) => err instanceof JournalRefusal && err.reasonCode === "unreviewed_promotion");
});
