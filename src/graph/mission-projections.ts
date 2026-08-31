import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { canonicalJson, sha256 } from "../ledger/canonical.js";
import {
  type SequencedMissionEvent,
  type ProgressVector,
} from "../ledger/mission-events.js";
import { CapabilityResolver, type ResolvedCapability } from "../runtime/capability-resolver.js";

export type GraphRelationType =
  | "DECOMPOSES_INTO"
  | "DEPENDS_ON"
  | "ASSIGNED_TO"
  | "ATTEMPTS"
  | "SUPERSEDES"
  | "CONFLICTS_WITH"
  | "PRODUCES"
  | "VERIFIED_BY"
  | "BLOCKED_BY";

export interface GraphRelation {
  from: string;
  relation: GraphRelationType;
  to: string;
}

export interface WorkItemNode {
  id: string;
  title: string;
  scope: string[];
  dependsOn: string[];
  state: "pending" | "running" | "reviewed" | "accepted" | "failed" | "blocked";
  assignedExpert?: string;
  activeRunId?: string;
  runs: string[];
  diffDigest?: string;
  producedArtifacts: string[];
}

export interface RunNode {
  runId: string;
  workItemId: string;
  expertId: string;
  model: string;
  effort: string;
  status: "running" | "succeeded" | "failed" | "interrupted" | "timed_out";
  durationMs?: number;
  stdoutHash?: string;
}

export interface ArtifactProvenance {
  hash: string;
  path: string;
  kind: string;
  producedByRunId: string;
  workItemId: string;
}

export interface ReviewProvenance {
  reviewerRunId: string;
  reviewerExpertId: string;
  workItemId: string;
  subjectDiffDigest: string;
  verdict: "approved" | "rejected";
  observations: string[];
}

export interface GateProvenance {
  gateId: string;
  status: "passed" | "failed";
  progressVector: ProgressVector;
  durationMs: number;
}

export interface FullMissionProjection {
  schemaVersion: number;
  missionId: string;
  status: "in_progress" | "succeeded" | "failed" | "blocked";
  currentWave: number;

  // 1. Capacity Graph Projection
  capabilities: {
    experts: Record<string, ResolvedCapability>;
  };

  // 2. Work Graph Projection
  workGraph: {
    workItems: Record<string, WorkItemNode>;
    runs: Record<string, RunNode>;
    readySet: string[];
    runningSet: string[];
    blockedSet: string[];
    acceptedSet: string[];
    relations: GraphRelation[];
  };

  // 3. Proof & Provenance Graph Projection
  provenance: {
    artifacts: Record<string, ArtifactProvenance>;
    reviews: ReviewProvenance[];
    gates: GateProvenance[];
    terminalVerdict?: {
      status: "succeeded" | "failed";
      commitSha?: string;
      finalProgress: ProgressVector;
    };
  };

  progress: ProgressVector;
  totalEventsProcessed: number;
  projectionDigest: string;
}

export class MissionProjectionEngine {
  public static project(events: SequencedMissionEvent[]): FullMissionProjection {
    let missionId = "unknown";
    let status: "in_progress" | "succeeded" | "failed" | "blocked" = "in_progress";
    let currentWave = 1;

    const workItems: Record<string, WorkItemNode> = {};
    const runs: Record<string, RunNode> = {};
    const artifacts: Record<string, ArtifactProvenance> = {};
    const reviews: ReviewProvenance[] = [];
    const gates: GateProvenance[] = [];
    const relations: GraphRelation[] = [];
    let terminalVerdict: FullMissionProjection["provenance"]["terminalVerdict"];

    let progress: ProgressVector = {
      hiddenTestsFailing: 0,
      hiddenTestsPassed: 0,
      visibleTestsFailing: 0,
      visibleTestsPassed: 0,
      gateFailures: 0,
      openDiagnosticsCount: 0,
      acceptedWorkItems: 0,
      totalWorkItems: 0,
    };

    const expertsRegistered: Record<string, ResolvedCapability> = {
      planner: CapabilityResolver.resolve("planner"),
      worker: CapabilityResolver.resolve("worker"),
      reviewer: CapabilityResolver.resolve("reviewer"),
    };

    for (const e of events) {
      missionId = e.missionId;

      switch (e.type) {
        case "mission_started":
          status = "in_progress";
          break;

        case "work_item_discovered":
          workItems[e.workItemId] = {
            id: e.workItemId,
            title: e.title,
            scope: [...e.scope],
            dependsOn: [...e.dependsOn],
            state: "pending",
            runs: [],
            producedArtifacts: [],
          };
          relations.push({
            from: missionId,
            relation: "DECOMPOSES_INTO",
            to: e.workItemId,
          });
          for (const dep of e.dependsOn) {
            relations.push({
              from: e.workItemId,
              relation: "DEPENDS_ON",
              to: dep,
            });
          }
          break;

        case "run_started":
          runs[e.runId] = {
            runId: e.runId,
            workItemId: e.workItemId,
            expertId: e.expertId,
            model: e.model,
            effort: e.effort,
            status: "running",
          };
          if (!expertsRegistered[e.expertId]) {
            expertsRegistered[e.expertId] = CapabilityResolver.resolve(e.expertId);
          }
          const wi = workItems[e.workItemId];
          if (wi) {
            wi.state = "running";
            wi.activeRunId = e.runId;
            wi.assignedExpert = e.expertId;
            if (!wi.runs.includes(e.runId)) {
              wi.runs.push(e.runId);
            }
          }
          relations.push({
            from: e.runId,
            relation: "ATTEMPTS",
            to: e.workItemId,
          });
          relations.push({
            from: e.runId,
            relation: "ASSIGNED_TO",
            to: e.expertId,
          });
          break;

        case "artifact_created":
          artifacts[e.artifactHash] = {
            hash: e.artifactHash,
            path: e.artifactPath,
            kind: e.artifactKind,
            producedByRunId: e.runId,
            workItemId: e.workItemId,
          };
          const targetWi = workItems[e.workItemId];
          if (targetWi) {
            targetWi.producedArtifacts.push(e.artifactHash);
            if (e.artifactKind === "diff") {
              targetWi.diffDigest = e.artifactHash;
            }
          }
          relations.push({
            from: e.runId,
            relation: "PRODUCES",
            to: e.artifactHash,
          });
          break;

        case "run_finished":
          const targetRun = runs[e.runId];
          if (targetRun) {
            targetRun.status = e.status;
            targetRun.durationMs = e.durationMs;
            targetRun.stdoutHash = e.stdoutHash;
          }
          const targetWorkItem = workItems[e.workItemId];
          if (targetWorkItem && targetWorkItem.activeRunId === e.runId) {
            if (e.status === "succeeded") {
              targetWorkItem.state = "reviewed";
            } else if (e.status === "failed" || e.status === "interrupted" || e.status === "timed_out") {
              targetWorkItem.state = "failed";
            }
          }
          break;

        case "review_attested":
          reviews.push({
            reviewerRunId: e.reviewerRunId,
            reviewerExpertId: e.reviewerExpertId,
            workItemId: e.workItemId,
            subjectDiffDigest: e.subjectDiffDigest,
            verdict: e.verdict,
            observations: e.observations,
          });
          relations.push({
            from: e.reviewerRunId,
            relation: "VERIFIED_BY",
            to: e.subjectDiffDigest,
          });
          const reviewedItem = workItems[e.workItemId];
          if (reviewedItem) {
            const approvedReviews = reviews.filter(
              (r) => r.workItemId === e.workItemId && r.verdict === "approved",
            );
            if (approvedReviews.length >= 2) {
              reviewedItem.state = "accepted";
            }
          }
          break;

        case "gate_evaluated":
          gates.push({
            gateId: e.gateId,
            status: e.status,
            progressVector: e.progressVector,
            durationMs: e.durationMs,
          });
          progress = e.progressVector;
          break;

        case "wave_transitioned":
          currentWave = e.toWave;
          break;

        case "integration_attempted":
          if (e.status === "conflict_blocked") {
            status = "blocked";
          }
          break;

        case "mission_finished":
          status = e.finalStatus === "succeeded" ? "succeeded" : "failed";
          progress = e.finalProgress;
          terminalVerdict = {
            status: e.finalStatus === "succeeded" ? "succeeded" : "failed",
            commitSha: e.integratedCommitSha,
            finalProgress: e.finalProgress,
          };
          break;
      }
    }

    const readySet = Object.values(workItems)
      .filter((w) => w.state === "pending" && w.dependsOn.every((d) => workItems[d]?.state === "accepted"))
      .map((w) => w.id);

    const runningSet = Object.values(workItems)
      .filter((w) => w.state === "running")
      .map((w) => w.id);

    const blockedSet = Object.values(workItems)
      .filter((w) => w.state === "blocked" || w.state === "failed")
      .map((w) => w.id);

    const acceptedSet = Object.values(workItems)
      .filter((w) => w.state === "accepted")
      .map((w) => w.id);

    progress.totalWorkItems = Object.keys(workItems).length;
    progress.acceptedWorkItems = acceptedSet.length;

    const rawProjectionData = {
      schemaVersion: 1,
      missionId,
      status,
      currentWave,
      capabilities: { experts: expertsRegistered },
      workGraph: {
        workItems,
        runs,
        readySet,
        runningSet,
        blockedSet,
        acceptedSet,
        relations,
      },
      provenance: {
        artifacts,
        reviews,
        gates,
        terminalVerdict,
      },
      progress,
      totalEventsProcessed: events.length,
    };

    const projectionDigest = sha256(canonicalJson(rawProjectionData));

    return {
      ...rawProjectionData,
      projectionDigest,
    };
  }

  public static persistProjection(projectionPath: string, projection: FullMissionProjection): void {
    writeFileSync(projectionPath, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
  }

  public static loadProjection(projectionPath: string): FullMissionProjection | undefined {
    if (!existsSync(projectionPath)) return undefined;
    const content = readFileSync(projectionPath, "utf8");
    return JSON.parse(content) as FullMissionProjection;
  }
}
