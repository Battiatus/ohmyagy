import type { CommandEvidence } from "../control/model.js";

export interface AuthorityMetadata {
  schemaVersion: 1;
  authorityId: string;
  publicKey: string;
  missionId: string;
  contractHash: string;
  graphHash: string;
  createdAt: string;
}

export interface SignedCommandEvidence extends CommandEvidence {
  authorityId: string;
  signature: string;
}

export interface AuthorityHead {
  entries: number;
  headHash: string;
}

export interface AuthorityVerification {
  valid: boolean;
  errors: string[];
  metadata?: AuthorityMetadata;
  events: SignedCommandEvidence[];
  head: AuthorityHead;
}

export interface PinnedAuthorityHead extends AuthorityHead {
  authorityId: string;
}
