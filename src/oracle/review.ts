import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { sha256 } from "../ledger/canonical.js";
import {
  MissionJournal,
  subjectDigest,
  type ReviewAttestedEvent,
} from "../ledger/mission-journal.js";
import type {
  ArtifactRef,
  ReviewerVerdict,
  ReviewSubject,
  RunAuthority,
} from "../orchestration/model.js";
import { OracleError } from "./executor.js";

const sha256Pattern = /^[a-f0-9]{64}$/;

export function attestReviewFromManifest(
  journal: MissionJournal,
  reviewer: RunAuthority,
  missionRoot: string,
  inputs: readonly ArtifactRef[],
  reviewerVerdict: ReviewerVerdict,
): ReviewAttestedEvent & { seq: number } {
  if (inputs.some((input) => input.producedByRunKey.length === 0)) {
    throw new OracleError("Every reviewer input requires producedByRunKey provenance.");
  }

  const subject: ReviewSubject[] = [];
  const producerRunKeys = [...new Set(inputs.map((input) => input.producedByRunKey))].sort();
  for (const producerRunKey of producerRunKeys) {
    for (const staged of journal.stagedTransactionsForRun(producerRunKey)) {
      const diffArtifact = inputs.find(
        (input) =>
          input.id === `diff:${staged.transactionId}` &&
          input.kind === "diff" &&
          input.producedByRunKey === staged.runKey &&
          input.sha256 === staged.stagedDiffDigest &&
          input.inputHashes.length === 0 &&
          artifactBytesMatch(missionRoot, input),
      );
      if (!diffArtifact) {
        continue;
      }
      subject.push({
        runKey: staged.runKey,
        transactionId: staged.transactionId,
        stagedDiffDigest: staged.stagedDiffDigest,
        artifactHashes: Object.freeze([diffArtifact.sha256]),
      });
    }
  }
  subject.sort((left, right) =>
    `${left.runKey}\0${left.transactionId}`.localeCompare(
      `${right.runKey}\0${right.transactionId}`,
    ),
  );

  return journal.appendOracleReviewAttested({
    runKey: reviewer.runKey,
    reviewerRunKey: reviewer.runKey,
    missionId: reviewer.missionId,
    epoch: reviewer.epoch,
    leaseId: reviewer.leaseId,
    subject,
    subjectDigest: subjectDigest(subject),
    reviewerVerdict,
  });
}

function artifactBytesMatch(missionRoot: string, artifact: ArtifactRef): boolean {
  if (
    artifact.id.length === 0 ||
    artifact.kind.length === 0 ||
    artifact.path.length === 0 ||
    !sha256Pattern.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes < 0 ||
    !Array.isArray(artifact.inputHashes) ||
    artifact.inputHashes.some((hash) => !sha256Pattern.test(hash))
  ) {
    return false;
  }
  const root = resolve(missionRoot);
  const absolutePath = resolve(root, ...artifact.path.split("/"));
  const fromRoot = relative(root, absolutePath);
  if (
    fromRoot.length === 0 ||
    fromRoot.startsWith("..") ||
    isAbsolute(fromRoot) ||
    !existsSync(absolutePath)
  ) {
    return false;
  }
  const bytes = readFileSync(absolutePath);
  return bytes.byteLength === artifact.bytes && sha256(bytes) === artifact.sha256;
}
