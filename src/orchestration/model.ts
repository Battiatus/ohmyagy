export interface RunAuthority {
  missionId: string;
  runKey: string;
  leaseId: string;
  epoch: string;
  expertId: string;
}

export interface ArtifactRef {
  id: string;
  kind: string;
  path: string;
  sha256: string;
  bytes: number;
  producedByRunKey: string;
  inputHashes: readonly string[];
}

export interface ReviewSubject {
  runKey: string;
  transactionId: string;
  stagedDiffDigest: string;
  artifactHashes: readonly string[];
}

export type ReviewerVerdict = "approved" | "rejected" | "inconclusive";

export interface MissionAcceptanceCriterion {
  id: string;
  description: string;
  gateId: string;
}

export interface CriterionResult {
  id: string;
  gateId: string;
  gateClass: "coverage";
  outcome: "satisfied" | "unsatisfied";
  observation: string;
}
