import type { SequencedMissionJournalEvent } from "../ledger/mission-journal.js";
import type {
  CriterionResult,
  MissionAcceptanceCriterion,
} from "../orchestration/model.js";
import {
  REVIEW_EVERY_PROMOTION,
  resolveMissionAcceptance,
} from "../policy/registry.js";

export interface MissionVerdict {
  outcome: "approved" | "rejected";
  criteria: CriterionResult[];
}

export interface MissionJournalView {
  events(): readonly SequencedMissionJournalEvent[];
  expertIdForRun(runKey: string): string | undefined;
}

export function evaluateMissionCoverage(
  journal: MissionJournalView,
  missionClass: string,
  humanDeclared: readonly MissionAcceptanceCriterion[],
): MissionVerdict {
  const acceptance = resolveMissionAcceptance(missionClass, humanDeclared);
  const criteria = acceptance.map((criterion) => {
    if (criterion.gateId !== REVIEW_EVERY_PROMOTION.gateId) {
      throw new Error(`Unsupported mission gate ${criterion.gateId}.`);
    }
    return evaluateReviewCoverage(journal, criterion);
  });
  return {
    outcome: criteria.every((criterion) => criterion.outcome === "satisfied")
      ? "approved"
      : "rejected",
    criteria,
  };
}

function evaluateReviewCoverage(
  journal: MissionJournalView,
  criterion: MissionAcceptanceCriterion,
): CriterionResult {
  const events = journal.events();
  const promotions = events.filter((event) => event.type === "transaction_promoted");
  const attestations = events.filter((event) => event.type === "review_attested");
  const uncovered: string[] = [];

  for (const promotion of promotions) {
    const authorExpertId = journal.expertIdForRun(promotion.runKey);
    const covered = attestations.some((attestation) => {
      const reviewerExpertId = journal.expertIdForRun(attestation.reviewerRunKey);
      return (
        attestation.seq < promotion.seq &&
        attestation.reviewerVerdict === "approved" &&
        authorExpertId !== undefined &&
        reviewerExpertId !== undefined &&
        authorExpertId !== reviewerExpertId &&
        attestation.subject.some(
          (subject) =>
            subject.runKey === promotion.runKey &&
            subject.transactionId === promotion.transactionId &&
            subject.stagedDiffDigest === promotion.stagedDiffDigest,
        )
      );
    });
    if (!covered) {
      uncovered.push(promotion.transactionId);
    }
  }

  return {
    id: criterion.id,
    gateId: criterion.gateId,
    gateClass: "coverage",
    outcome: uncovered.length === 0 ? "satisfied" : "unsatisfied",
    observation:
      uncovered.length === 0
        ? `All ${promotions.length} promoted transactions are covered.`
        : `Uncovered promoted transactions: ${uncovered.join(", ")}.`,
  };
}
