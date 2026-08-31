import { sha256 } from "../ledger/canonical.js";

export interface ReviewSubject {
  workItemId: string;
  stagedDiffDigest: string;
  filesModified: string[];
  modulePatch: Record<string, unknown>;
}

export interface IndependentReviewVerdict {
  reviewerRunId: string;
  reviewerExpertId: string;
  workItemId: string;
  subjectDiffDigest: string;
  verdict: "approved" | "rejected";
  observations: string[];
  reviewArtifactHash: string;
  timestamp: string;
}

export interface ReviewConsensusResult {
  workItemId: string;
  consensus: "approved" | "rejected";
  reviews: IndependentReviewVerdict[];
  consensusHash: string;
}

export class AdversarialReviewEngine {
  /**
   * Executes an independent adversarial review on an isolated diff subject.
   * Reviewer sees only the diff manifest and content, never the worker reasoning or other reviews.
   */
  public static evaluateReview(
    reviewerRunId: string,
    reviewerExpertId: string,
    subject: ReviewSubject,
    inspector: (sub: ReviewSubject) => { approved: boolean; observations: string[] },
  ): IndependentReviewVerdict {
    const timestamp = new Date().toISOString();
    const evaluation = inspector(subject);

    const rawArtifact = JSON.stringify({
      reviewerRunId,
      reviewerExpertId,
      workItemId: subject.workItemId,
      subjectDiffDigest: subject.stagedDiffDigest,
      verdict: evaluation.approved ? "approved" : "rejected",
      observations: evaluation.observations,
      timestamp,
    });

    const reviewArtifactHash = sha256(rawArtifact);

    return {
      reviewerRunId,
      reviewerExpertId,
      workItemId: subject.workItemId,
      subjectDiffDigest: subject.stagedDiffDigest,
      verdict: evaluation.approved ? "approved" : "rejected",
      observations: evaluation.observations,
      reviewArtifactHash,
      timestamp,
    };
  }

  /**
   * Computes consensus across independent reviews.
   * Requires at least 2 independent reviews with unanimous approval.
   */
  public static computeConsensus(
    workItemId: string,
    reviews: IndependentReviewVerdict[],
  ): ReviewConsensusResult {
    const matchingReviews = reviews.filter((r) => r.workItemId === workItemId);
    const distinctReviewers = new Set(matchingReviews.map((r) => r.reviewerRunId));

    const approvedCount = matchingReviews.filter((r) => r.verdict === "approved").length;
    const isApproved =
      distinctReviewers.size >= 2 && approvedCount === matchingReviews.length && approvedCount >= 2;

    const consensus = isApproved ? "approved" : "rejected";
    const consensusHash = sha256(
      JSON.stringify({
        workItemId,
        consensus,
        reviewHashes: matchingReviews.map((r) => r.reviewArtifactHash).sort(),
      }),
    );

    return {
      workItemId,
      consensus,
      reviews: matchingReviews,
      consensusHash,
    };
  }
}
