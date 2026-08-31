import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { hashJson, sha256 } from "../ledger/canonical.js";
import { StagedReviewBroker } from "../broker/staged-review.js";
import { MissionJournal } from "../ledger/mission-journal.js";
import type {
  ArtifactRef,
  ReviewerVerdict,
  RunAuthority,
} from "../orchestration/model.js";
import { OracleError } from "../oracle/executor.js";
import { attestReviewFromManifest } from "../oracle/review.js";

export interface ReviewInvocation {
  reviewer: Readonly<RunAuthority>;
  taskKind: string;
  objective: string;
  inputs: readonly ArtifactRef[];
  inputDigest: string;
}

export interface ReviewExecution {
  invocation: ReviewInvocation;
  attestationSeq: number;
  verdict: ReviewerVerdict;
}

export type InProcessReviewExpert = (invocation: ReviewInvocation) => ReviewerVerdict;

export class ReviewRuntime {
  constructor(
    private readonly journal: MissionJournal,
    private readonly broker: StagedReviewBroker,
    private readonly missionRoot: string,
  ) {}

  invoke(
    reviewer: RunAuthority,
    taskKind: string,
    objective: string,
    inputs: readonly ArtifactRef[],
    expert: InProcessReviewExpert,
  ): ReviewExecution {
    this.journal.appendRunStarted(reviewer);
    const invocation = this.prepare(reviewer, taskKind, objective, inputs);
    const verdict = expert(invocation);
    if (!(["approved", "rejected", "inconclusive"] as const).includes(verdict)) {
      throw new OracleError(`Reviewer returned invalid verdict ${String(verdict)}.`);
    }
    const attestation = attestReviewFromManifest(
      this.journal,
      invocation.reviewer,
      this.missionRoot,
      invocation.inputs,
      verdict,
    );
    return { invocation, attestationSeq: attestation.seq, verdict };
  }

  prepare(
    reviewer: RunAuthority,
    taskKind: string,
    objective: string,
    inputs: readonly ArtifactRef[],
  ): ReviewInvocation {
    if (inputs.some((input) => input.producedByRunKey.length === 0)) {
      throw new OracleError("Every reviewer input requires producedByRunKey provenance.");
    }
    const manifest = inputs.map(copyArtifact);
    const ids = new Set(manifest.map((input) => input.id));
    const producerRunKeys = [...new Set(inputs.map((input) => input.producedByRunKey))].sort();
    for (const producerRunKey of producerRunKeys) {
      for (const staged of this.journal.stagedTransactionsForRun(producerRunKey)) {
        const id = `diff:${staged.transactionId}`;
        if (ids.has(id)) {
          throw new OracleError(`Reviewer manifest already contains reserved artifact ${id}.`);
        }
        const canonicalDiff = this.broker.stagedDiff(staged.runKey, staged.transactionId);
        if (canonicalDiff === undefined || sha256(canonicalDiff) !== staged.stagedDiffDigest) {
          throw new OracleError(`Canonical staged diff ${staged.transactionId} is unavailable.`);
        }
        const path = posix.join("artifacts", "diffs", `${staged.transactionId}.diff`);
        const absolutePath = join(this.missionRoot, ...path.split("/"));
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, canonicalDiff, "utf8");
        manifest.push(Object.freeze({
          id,
          kind: "diff",
          path,
          sha256: staged.stagedDiffDigest,
          bytes: Buffer.byteLength(canonicalDiff, "utf8"),
          producedByRunKey: staged.runKey,
          inputHashes: Object.freeze([]),
        }));
        ids.add(id);
      }
    }
    const artifactHashes = manifest.map((artifact) => hashJson(artifact)).sort();
    const immutableInputs = Object.freeze([...manifest]);
    return Object.freeze({
      reviewer: Object.freeze({ ...reviewer }),
      taskKind,
      objective,
      inputs: immutableInputs,
      inputDigest: hashJson({
        expertId: reviewer.expertId,
        taskKind,
        objective,
        inputs: artifactHashes,
        messages: [],
      }),
    });
  }
}

function copyArtifact(artifact: ArtifactRef): ArtifactRef {
  return Object.freeze({
    ...artifact,
    inputHashes: Object.freeze([...artifact.inputHashes]),
  });
}
