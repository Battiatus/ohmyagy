import { canonicalJson, sha256 } from "./canonical.js";
import { JournalStore } from "./journal-store.js";
import { requiresReviewOfEveryPromotion } from "../policy/registry.js";
const sha256Pattern = /^[a-f0-9]{64}$/;
export class JournalRefusal extends Error {
    reasonCode;
    transaction;
    constructor(reasonCode, message, transaction = null) {
        super(message);
        this.reasonCode = reasonCode;
        this.transaction = transaction;
        this.name = "JournalRefusal";
    }
}
export class MissionJournal {
    missionId;
    missionClass;
    #events = [];
    #store;
    constructor(missionId, missionClass, options) {
        this.missionId = missionId;
        this.missionClass = missionClass;
        if (missionId.length === 0) {
            throw new JournalRefusal("invalid_event", "Mission journal requires a missionId.");
        }
        requiresReviewOfEveryPromotion(missionClass);
        if (typeof options === "string") {
            this.#store = new JournalStore(options);
        }
        else if (options?.journalStore) {
            this.#store = options.journalStore;
        }
        else if (options?.journalStorePath) {
            this.#store = new JournalStore(options.journalStorePath);
        }
        if (this.#store) {
            this.loadAndReplayStore();
        }
    }
    get store() {
        return this.#store;
    }
    loadAndReplayStore() {
        if (!this.#store)
            return;
        const storedEvents = this.#store.readEvents();
        for (const raw of storedEvents) {
            const { sequenceNumber, parentHash, eventHash, ...rest } = raw;
            if (typeof rest.type === "string" &&
                rest.missionId === this.missionId &&
                (rest.type === "run_started" ||
                    rest.type === "transaction_staged" ||
                    rest.type === "transaction_promoted" ||
                    rest.type === "review_attested")) {
                const seq = typeof rest.seq === "number" ? rest.seq : sequenceNumber;
                const sequenced = Object.assign({}, rest, { seq });
                Object.freeze(sequenced);
                this.#events.push(sequenced);
            }
        }
    }
    appendRunStarted(run) {
        this.assertMission(run.missionId);
        if (run.runKey.length === 0 || run.expertId.length === 0) {
            throw new JournalRefusal("invalid_event", "Run identity requires runKey and expertId.");
        }
        if (this.#events.some((event) => event.type === "run_started" && event.runKey === run.runKey)) {
            throw new JournalRefusal("duplicate_run", `Run ${run.runKey} is already journaled.`);
        }
        return this.append({
            type: "run_started",
            missionId: run.missionId,
            runKey: run.runKey,
            expertId: run.expertId,
        });
    }
    appendTransactionStaged(event) {
        this.assertMission(event.missionId);
        this.assertRunStarted(event.runKey);
        assertNonEmpty(event.leaseId, "leaseId");
        assertNonEmpty(event.epoch, "epoch");
        assertNonEmpty(event.transactionId, "transactionId");
        assertSha256(event.stagedDiffDigest, "stagedDiffDigest");
        if (this.#events.some((candidate) => candidate.type === "transaction_staged" &&
            candidate.transactionId === event.transactionId)) {
            throw new JournalRefusal("duplicate_transaction", `Transaction ${event.transactionId} is already staged.`);
        }
        return this.append({ type: "transaction_staged", ...event });
    }
    assertPromotionAllowed(event) {
        this.assertMission(event.missionId);
        this.assertRunStarted(event.runKey);
        assertNonEmpty(event.leaseId, "leaseId");
        assertNonEmpty(event.epoch, "epoch");
        assertNonEmpty(event.transactionId, "transactionId");
        assertSha256(event.stagedDiffDigest, "stagedDiffDigest");
        assertSha256(event.diffDigest, "diffDigest");
        const staged = this.findStaged(event.runKey, event.transactionId);
        if (!staged) {
            throw new JournalRefusal("staged_transaction_missing", `Transaction ${event.transactionId} was not staged by ${event.runKey}.`);
        }
        if (staged.leaseId !== event.leaseId || staged.epoch !== event.epoch) {
            throw new JournalRefusal("invalid_event", `Promotion authority does not match staged transaction ${event.transactionId}.`);
        }
        if (staged.stagedDiffDigest !== event.stagedDiffDigest ||
            event.diffDigest !== event.stagedDiffDigest) {
            throw new JournalRefusal("staged_promoted_mismatch", `Promoted diff ${event.diffDigest} does not match staged diff ${staged.stagedDiffDigest}.`, "conflict");
        }
        if (requiresReviewOfEveryPromotion(this.missionClass) &&
            !this.hasApprovedIndependentReview(event)) {
            throw new JournalRefusal("unreviewed_promotion", `Transaction ${event.transactionId} has no approved independent pre-promotion review.`, "rejected");
        }
    }
    appendTransactionPromoted(event) {
        this.assertPromotionAllowed(event);
        assertNonEmpty(event.commitSha, "commitSha");
        if (this.#events.some((candidate) => candidate.type === "transaction_promoted" &&
            candidate.transactionId === event.transactionId)) {
            throw new JournalRefusal("duplicate_transaction", `Transaction ${event.transactionId} is already promoted.`);
        }
        return this.append({ type: "transaction_promoted", ...event });
    }
    appendOracleReviewAttested(event) {
        this.assertMission(event.missionId);
        this.assertRunStarted(event.reviewerRunKey);
        if (event.runKey !== event.reviewerRunKey) {
            throw new JournalRefusal("invalid_event", "review_attested runKey must equal reviewerRunKey.");
        }
        assertNonEmpty(event.leaseId, "leaseId");
        assertNonEmpty(event.epoch, "epoch");
        const expectedSubjectDigest = subjectDigest(event.subject);
        if (event.subjectDigest !== expectedSubjectDigest) {
            throw new JournalRefusal("invalid_event", `Review subject digest must be ${expectedSubjectDigest}.`);
        }
        for (const item of event.subject) {
            assertSha256(item.stagedDiffDigest, "subject.stagedDiffDigest");
            if (!this.findStaged(item.runKey, item.transactionId, item.stagedDiffDigest)) {
                throw new JournalRefusal("staged_transaction_missing", `Review subject ${item.transactionId} does not identify a staged transaction.`);
            }
            for (const artifactHash of item.artifactHashes) {
                assertSha256(artifactHash, "subject.artifactHashes[]");
            }
        }
        const immutableSubject = Object.freeze(event.subject.map((item) => Object.freeze({
            ...item,
            artifactHashes: Object.freeze([...item.artifactHashes]),
        })));
        return this.append({ type: "review_attested", ...event, subject: immutableSubject });
    }
    events() {
        return Object.freeze([...this.#events]);
    }
    stagedTransactionsForRun(runKey) {
        return this.#events.filter((event) => event.type === "transaction_staged" && event.runKey === runKey);
    }
    expertIdForRun(runKey) {
        return this.#events.find((event) => event.type === "run_started" && event.runKey === runKey)?.expertId;
    }
    hasApprovedIndependentReview(promotion) {
        const authorExpertId = this.expertIdForRun(promotion.runKey);
        const attemptedPromotionSeq = this.#events.length + 1;
        return this.#events.some((event) => {
            if (event.type !== "review_attested") {
                return false;
            }
            const reviewerExpertId = this.expertIdForRun(event.reviewerRunKey);
            return (event.seq < attemptedPromotionSeq &&
                event.reviewerVerdict === "approved" &&
                authorExpertId !== undefined &&
                reviewerExpertId !== undefined &&
                authorExpertId !== reviewerExpertId &&
                event.subject.some((subject) => subject.runKey === promotion.runKey &&
                    subject.transactionId === promotion.transactionId &&
                    subject.stagedDiffDigest === promotion.stagedDiffDigest));
        });
    }
    findStaged(runKey, transactionId, stagedDiffDigest) {
        return this.#events.find((event) => event.type === "transaction_staged" &&
            event.runKey === runKey &&
            event.transactionId === transactionId &&
            (stagedDiffDigest === undefined || event.stagedDiffDigest === stagedDiffDigest));
    }
    assertMission(missionId) {
        if (missionId !== this.missionId) {
            throw new JournalRefusal("mission_mismatch", `Event mission ${missionId} does not match journal mission ${this.missionId}.`);
        }
    }
    assertRunStarted(runKey) {
        if (!this.expertIdForRun(runKey)) {
            throw new JournalRefusal("run_not_started", `Run ${runKey} is not journaled.`);
        }
    }
    append(event) {
        const sequenced = Object.assign({}, event, { seq: this.#events.length + 1 });
        Object.freeze(sequenced);
        this.#events.push(sequenced);
        if (this.#store) {
            this.#store.appendEvent(sequenced);
        }
        return sequenced;
    }
}
export function subjectDigest(subject) {
    return sha256(canonicalJson(subject.map((item) => item.stagedDiffDigest).sort()));
}
function assertNonEmpty(value, field) {
    if (value.length === 0) {
        throw new JournalRefusal("invalid_event", `${field} must be non-empty.`);
    }
}
function assertSha256(value, field) {
    if (!sha256Pattern.test(value)) {
        throw new JournalRefusal("invalid_event", `${field} must be a lowercase SHA-256 digest.`);
    }
}
