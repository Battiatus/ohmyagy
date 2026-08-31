import { canonicalJson, sha256 } from "./canonical.js";
import { JournalStore } from "./journal-store.js";
import type {
  ReviewSubject,
  ReviewerVerdict,
  RunAuthority,
} from "../orchestration/model.js";
import { requiresReviewOfEveryPromotion } from "../policy/registry.js";

const sha256Pattern = /^[a-f0-9]{64}$/;

export interface RunStartedEvent {
  type: "run_started";
  missionId: string;
  runKey: string;
  expertId: string;
}

export interface TransactionStagedEvent {
  type: "transaction_staged";
  runKey: string;
  missionId: string;
  leaseId: string;
  epoch: string;
  transactionId: string;
  stagedDiffDigest: string;
}

export interface TransactionPromotedEvent {
  type: "transaction_promoted";
  runKey: string;
  missionId: string;
  leaseId: string;
  epoch: string;
  transactionId: string;
  stagedDiffDigest: string;
  commitSha: string;
  diffDigest: string;
}

export interface ReviewAttestedEvent {
  type: "review_attested";
  runKey: string;
  reviewerRunKey: string;
  missionId: string;
  epoch: string;
  leaseId: string;
  subject: readonly ReviewSubject[];
  subjectDigest: string;
  reviewerVerdict: ReviewerVerdict;
}

export type MissionJournalEvent =
  | RunStartedEvent
  | TransactionStagedEvent
  | TransactionPromotedEvent
  | ReviewAttestedEvent;

export type SequencedMissionJournalEvent = MissionJournalEvent & { seq: number };

export interface MissionJournalOptions {
  journalStorePath?: string;
  journalStore?: JournalStore;
}

export type JournalRefusalReason =
  | "mission_mismatch"
  | "run_not_started"
  | "duplicate_run"
  | "duplicate_transaction"
  | "staged_transaction_missing"
  | "staged_promoted_mismatch"
  | "unreviewed_promotion"
  | "invalid_event";

export class JournalRefusal extends Error {
  constructor(
    public readonly reasonCode: JournalRefusalReason,
    message: string,
    public readonly transaction: "conflict" | "rejected" | null = null,
  ) {
    super(message);
    this.name = "JournalRefusal";
  }
}

export class MissionJournal {
  readonly #events: SequencedMissionJournalEvent[] = [];
  readonly #store?: JournalStore;

  constructor(
    public readonly missionId: string,
    public readonly missionClass: string,
    options?: MissionJournalOptions | string,
  ) {
    if (missionId.length === 0) {
      throw new JournalRefusal("invalid_event", "Mission journal requires a missionId.");
    }
    requiresReviewOfEveryPromotion(missionClass);

    if (typeof options === "string") {
      this.#store = new JournalStore(options);
    } else if (options?.journalStore) {
      this.#store = options.journalStore;
    } else if (options?.journalStorePath) {
      this.#store = new JournalStore(options.journalStorePath);
    }

    if (this.#store) {
      this.loadAndReplayStore();
    }
  }

  get store(): JournalStore | undefined {
    return this.#store;
  }

  private loadAndReplayStore(): void {
    if (!this.#store) return;
    const storedEvents = this.#store.readEvents();
    for (const raw of storedEvents) {
      const { sequenceNumber, parentHash, eventHash, ...rest } = raw;
      if (
        typeof rest.type === "string" &&
        rest.missionId === this.missionId &&
        (rest.type === "run_started" ||
          rest.type === "transaction_staged" ||
          rest.type === "transaction_promoted" ||
          rest.type === "review_attested")
      ) {
        const seq = typeof rest.seq === "number" ? rest.seq : sequenceNumber;
        const sequenced = Object.assign({}, rest, { seq }) as unknown as SequencedMissionJournalEvent;
        Object.freeze(sequenced);
        this.#events.push(sequenced);
      }
    }
  }

  appendRunStarted(run: Pick<RunAuthority, "missionId" | "runKey" | "expertId">): RunStartedEvent & { seq: number } {
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

  appendTransactionStaged(
    event: Omit<TransactionStagedEvent, "type">,
  ): TransactionStagedEvent & { seq: number } {
    this.assertMission(event.missionId);
    this.assertRunStarted(event.runKey);
    assertNonEmpty(event.leaseId, "leaseId");
    assertNonEmpty(event.epoch, "epoch");
    assertNonEmpty(event.transactionId, "transactionId");
    assertSha256(event.stagedDiffDigest, "stagedDiffDigest");
    if (
      this.#events.some(
        (candidate) =>
          candidate.type === "transaction_staged" &&
          candidate.transactionId === event.transactionId,
      )
    ) {
      throw new JournalRefusal(
        "duplicate_transaction",
        `Transaction ${event.transactionId} is already staged.`,
      );
    }
    return this.append({ type: "transaction_staged", ...event });
  }

  assertPromotionAllowed(event: Omit<TransactionPromotedEvent, "type" | "commitSha">): void {
    this.assertMission(event.missionId);
    this.assertRunStarted(event.runKey);
    assertNonEmpty(event.leaseId, "leaseId");
    assertNonEmpty(event.epoch, "epoch");
    assertNonEmpty(event.transactionId, "transactionId");
    assertSha256(event.stagedDiffDigest, "stagedDiffDigest");
    assertSha256(event.diffDigest, "diffDigest");
    const staged = this.findStaged(event.runKey, event.transactionId);
    if (!staged) {
      throw new JournalRefusal(
        "staged_transaction_missing",
        `Transaction ${event.transactionId} was not staged by ${event.runKey}.`,
      );
    }
    if (staged.leaseId !== event.leaseId || staged.epoch !== event.epoch) {
      throw new JournalRefusal(
        "invalid_event",
        `Promotion authority does not match staged transaction ${event.transactionId}.`,
      );
    }
    if (
      staged.stagedDiffDigest !== event.stagedDiffDigest ||
      event.diffDigest !== event.stagedDiffDigest
    ) {
      throw new JournalRefusal(
        "staged_promoted_mismatch",
        `Promoted diff ${event.diffDigest} does not match staged diff ${staged.stagedDiffDigest}.`,
        "conflict",
      );
    }
    if (
      requiresReviewOfEveryPromotion(this.missionClass) &&
      !this.hasApprovedIndependentReview(event)
    ) {
      throw new JournalRefusal(
        "unreviewed_promotion",
        `Transaction ${event.transactionId} has no approved independent pre-promotion review.`,
        "rejected",
      );
    }
  }

  appendTransactionPromoted(
    event: Omit<TransactionPromotedEvent, "type">,
  ): TransactionPromotedEvent & { seq: number } {
    this.assertPromotionAllowed(event);
    assertNonEmpty(event.commitSha, "commitSha");
    if (
      this.#events.some(
        (candidate) =>
          candidate.type === "transaction_promoted" &&
          candidate.transactionId === event.transactionId,
      )
    ) {
      throw new JournalRefusal(
        "duplicate_transaction",
        `Transaction ${event.transactionId} is already promoted.`,
      );
    }
    return this.append({ type: "transaction_promoted", ...event });
  }

  appendOracleReviewAttested(
    event: Omit<ReviewAttestedEvent, "type">,
  ): ReviewAttestedEvent & { seq: number } {
    this.assertMission(event.missionId);
    this.assertRunStarted(event.reviewerRunKey);
    if (event.runKey !== event.reviewerRunKey) {
      throw new JournalRefusal(
        "invalid_event",
        "review_attested runKey must equal reviewerRunKey.",
      );
    }
    assertNonEmpty(event.leaseId, "leaseId");
    assertNonEmpty(event.epoch, "epoch");
    const expectedSubjectDigest = subjectDigest(event.subject);
    if (event.subjectDigest !== expectedSubjectDigest) {
      throw new JournalRefusal(
        "invalid_event",
        `Review subject digest must be ${expectedSubjectDigest}.`,
      );
    }
    for (const item of event.subject) {
      assertSha256(item.stagedDiffDigest, "subject.stagedDiffDigest");
      if (!this.findStaged(item.runKey, item.transactionId, item.stagedDiffDigest)) {
        throw new JournalRefusal(
          "staged_transaction_missing",
          `Review subject ${item.transactionId} does not identify a staged transaction.`,
        );
      }
      for (const artifactHash of item.artifactHashes) {
        assertSha256(artifactHash, "subject.artifactHashes[]");
      }
    }
    const immutableSubject = Object.freeze(
      event.subject.map((item) =>
        Object.freeze({
          ...item,
          artifactHashes: Object.freeze([...item.artifactHashes]),
        }),
      ),
    );
    return this.append({ type: "review_attested", ...event, subject: immutableSubject });
  }

  events(): readonly SequencedMissionJournalEvent[] {
    return Object.freeze([...this.#events]);
  }

  stagedTransactionsForRun(runKey: string): readonly (TransactionStagedEvent & { seq: number })[] {
    return this.#events.filter(
      (event): event is TransactionStagedEvent & { seq: number } =>
        event.type === "transaction_staged" && event.runKey === runKey,
    );
  }

  expertIdForRun(runKey: string): string | undefined {
    return this.#events.find(
      (event): event is RunStartedEvent & { seq: number } =>
        event.type === "run_started" && event.runKey === runKey,
    )?.expertId;
  }

  private hasApprovedIndependentReview(
    promotion: Omit<TransactionPromotedEvent, "type" | "commitSha">,
  ): boolean {
    const authorExpertId = this.expertIdForRun(promotion.runKey);
    const attemptedPromotionSeq = this.#events.length + 1;
    return this.#events.some((event) => {
      if (event.type !== "review_attested") {
        return false;
      }
      const reviewerExpertId = this.expertIdForRun(event.reviewerRunKey);
      return (
        event.seq < attemptedPromotionSeq &&
        event.reviewerVerdict === "approved" &&
        authorExpertId !== undefined &&
        reviewerExpertId !== undefined &&
        authorExpertId !== reviewerExpertId &&
        event.subject.some(
          (subject) =>
            subject.runKey === promotion.runKey &&
            subject.transactionId === promotion.transactionId &&
            subject.stagedDiffDigest === promotion.stagedDiffDigest,
        )
      );
    });
  }

  private findStaged(
    runKey: string,
    transactionId: string,
    stagedDiffDigest?: string,
  ): (TransactionStagedEvent & { seq: number }) | undefined {
    return this.#events.find(
      (event): event is TransactionStagedEvent & { seq: number } =>
        event.type === "transaction_staged" &&
        event.runKey === runKey &&
        event.transactionId === transactionId &&
        (stagedDiffDigest === undefined || event.stagedDiffDigest === stagedDiffDigest),
    );
  }

  private assertMission(missionId: string): void {
    if (missionId !== this.missionId) {
      throw new JournalRefusal(
        "mission_mismatch",
        `Event mission ${missionId} does not match journal mission ${this.missionId}.`,
      );
    }
  }

  private assertRunStarted(runKey: string): void {
    if (!this.expertIdForRun(runKey)) {
      throw new JournalRefusal("run_not_started", `Run ${runKey} is not journaled.`);
    }
  }

  private append<T extends MissionJournalEvent>(event: T): T & { seq: number } {
    const sequenced = Object.assign({}, event, { seq: this.#events.length + 1 });
    Object.freeze(sequenced);
    this.#events.push(sequenced);
    if (this.#store) {
      this.#store.appendEvent(sequenced as unknown as Record<string, unknown>);
    }
    return sequenced;
  }
}

export function subjectDigest(subject: readonly ReviewSubject[]): string {
  return sha256(
    canonicalJson(subject.map((item) => item.stagedDiffDigest).sort()),
  );
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new JournalRefusal("invalid_event", `${field} must be non-empty.`);
  }
}

function assertSha256(value: string, field: string): void {
  if (!sha256Pattern.test(value)) {
    throw new JournalRefusal(
      "invalid_event",
      `${field} must be a lowercase SHA-256 digest.`,
    );
  }
}
