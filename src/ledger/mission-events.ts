import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";
import type { ProgressVector } from "../oracle/objective-judge.js";
export type { ProgressVector };

export type MissionEventType =
  | "mission_started"
  | "interview_recorded"
  | "work_item_discovered"
  | "run_started"
  | "artifact_created"
  | "run_finished"
  | "review_attested"
  | "gate_evaluated"
  | "integration_attempted"
  | "wave_transitioned"
  | "wave_started"
  | "round_started"
  | "terminal_verdict_rendered"
  | "mission_finished";

export interface BaseMissionEvent {
  seq: number;
  type: MissionEventType;
  timestamp: string;
  missionId: string;
  previousEventHash: string;
  eventHash: string;
}

export interface MissionStartedPayload {
  workflowDigest: string;
  rulebookRevision: string;
  goal: string;
  totalBudgets?: { maxTokens?: number; maxTimeMs?: number; maxRounds?: number };
}

export interface InterviewRecordedPayload {
  /** The questions actually put to the user, in the order they were asked. */
  questions: string[];
  /** The user's answers, aligned with `questions`. */
  answers: string[];
  /**
   * The user's explicit go-ahead. An interview the user never confirmed does not
   * authorise a single run: the gate is the confirmation, not the asking.
   */
  confirmed: boolean;
  /** Host conversation that produced the answers, when the caller knows it. */
  conversationId?: string;
}

export interface WorkItemDiscoveredPayload {
  workItemId: string;
  title: string;
  scope: string[];
  dependsOn: string[];
  roleRequired: "planner" | "explorer" | "executor" | "worker" | "reviewer" | "fixer" | "verifier";
  acceptanceCriteria: string[];
}

export interface RunStartedPayload {
  runId: string;
  workItemId: string;
  expertId: string;
  model: string;
  effort: string;
  worktreePath?: string;
}

export interface ArtifactCreatedPayload {
  runId: string;
  workItemId: string;
  artifactPath: string;
  artifactHash: string;
  artifactKind: "diff" | "report" | "log" | "manifest";
}

export interface RunFinishedPayload {
  runId: string;
  workItemId: string;
  expertId: string;
  status: "succeeded" | "failed" | "interrupted" | "timed_out";
  durationMs: number;
  stdoutHash?: string;
  error?: string;
}

export interface ReviewAttestedPayload {
  runId: string;
  reviewerRunId: string;
  reviewerExpertId: string;
  workItemId: string;
  subjectDiffDigest: string;
  verdict: "approved" | "rejected";
  observations: string[];
}

export interface GateEvaluatedPayload {
  gateId: string;
  status: "passed" | "failed";
  progressVector: ProgressVector;
  durationMs: number;
  diagnostics: string[];
}

export interface IntegrationAttemptedPayload {
  waveIndex: number;
  workItemsIntegrated: string[];
  commitSha?: string;
  status: "integrated" | "conflict_blocked" | "gate_rejected";
  conflictDetails?: string;
}

export interface WaveTransitionedPayload {
  fromWave: number;
  toWave: number;
  progressBefore: ProgressVector;
  progressAfter: ProgressVector;
  hasProgressed: boolean;
  reason: string;
}

export interface WaveStartedPayload {
  waveIndex: number;
}

export interface RoundStartedPayload {
  roundIndex: number;
}

export interface TerminalVerdictRenderedPayload {
  runId: string;
  status: "succeeded" | "failed";
  commitSha?: string;
  verdictHash: string;
}

export interface MissionFinishedPayload {
  finalStatus: "succeeded" | "failed" | "budget_exhausted" | "no_progress_blocked";
  totalDurationMs: number;
  finalProgress: ProgressVector;
  integratedCommitSha?: string;
}

export type MissionEventPayload =
  | ({ type: "mission_started" } & MissionStartedPayload)
  | ({ type: "interview_recorded" } & InterviewRecordedPayload)
  | ({ type: "work_item_discovered" } & WorkItemDiscoveredPayload)
  | ({ type: "run_started" } & RunStartedPayload)
  | ({ type: "artifact_created" } & ArtifactCreatedPayload)
  | ({ type: "run_finished" } & RunFinishedPayload)
  | ({ type: "review_attested" } & ReviewAttestedPayload)
  | ({ type: "gate_evaluated" } & GateEvaluatedPayload)
  | ({ type: "integration_attempted" } & IntegrationAttemptedPayload)
  | ({ type: "wave_transitioned" } & WaveTransitionedPayload)
  | ({ type: "wave_started" } & WaveStartedPayload)
  | ({ type: "round_started" } & RoundStartedPayload)
  | ({ type: "terminal_verdict_rendered" } & TerminalVerdictRenderedPayload)
  | ({ type: "mission_finished" } & MissionFinishedPayload);

export type SequencedMissionEvent = BaseMissionEvent & MissionEventPayload;

export interface MissionWorkItemState {
  id: string;
  title: string;
  scope: string[];
  dependsOn: string[];
  state: "pending" | "running" | "reviewed" | "accepted" | "failed" | "blocked";
  activeRunId?: string;
  runs: string[];
  diffDigest?: string;
  reviews: Array<{ reviewer: string; verdict: "approved" | "rejected" }>;
}

export interface MissionProjection {
  missionId: string;
  status: "in_progress" | "succeeded" | "failed" | "blocked";
  currentWave: number;
  workItems: Map<string, MissionWorkItemState>;
  runs: Map<string, { id: string; workItemId: string; expertId: string; status: string }>;
  progress: ProgressVector;
  eventCount: number;
  lastEventHash: string;
}

export class MissionEventsStore {
  public static appendEvent(
    eventsFilePath: string,
    missionId: string,
    payload: MissionEventPayload,
  ): SequencedMissionEvent {
    const dir = dirname(eventsFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const existing = this.readEvents(eventsFilePath);
    const seq = existing.length + 1;
    const previousEventHash =
      existing.length > 0
        ? existing[existing.length - 1].eventHash
        : "0".repeat(64);

    const timestamp = new Date().toISOString();
    const eventWithoutHash = {
      seq,
      timestamp,
      missionId,
      previousEventHash,
      ...payload,
    };

    const eventHash = sha256(canonicalJson(eventWithoutHash));
    const fullEvent: SequencedMissionEvent = {
      ...eventWithoutHash,
      eventHash,
    } as SequencedMissionEvent;

    appendFileSync(eventsFilePath, `${JSON.stringify(fullEvent)}\n`, "utf8");
    return fullEvent;
  }

  public static readEvents(eventsFilePath: string): SequencedMissionEvent[] {
    if (!existsSync(eventsFilePath)) return [];
    const content = readFileSync(eventsFilePath, "utf8");
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l) as SequencedMissionEvent);
  }

  public static verifyEventChain(events: SequencedMissionEvent[]): { valid: boolean; error?: string } {
    let prevHash = "0".repeat(64);
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.seq !== i + 1) {
        return { valid: false, error: `Sequence discontinuity at index ${i}: expected seq ${i + 1}, got ${event.seq}` };
      }
      if (event.previousEventHash !== prevHash) {
        return { valid: false, error: `Hash chain mismatch at seq ${event.seq}` };
      }
      const { eventHash, ...data } = event;
      const computedHash = sha256(canonicalJson(data));
      if (computedHash !== eventHash) {
        return { valid: false, error: `Invalid event payload hash at seq ${event.seq}` };
      }
      prevHash = eventHash;
    }
    return { valid: true };
  }

  public static projectMission(events: SequencedMissionEvent[]): MissionProjection {
    const workItems = new Map<string, MissionWorkItemState>();
    const runs = new Map<string, { id: string; workItemId: string; expertId: string; status: string }>();

    let missionId = "unknown";
    let status: "in_progress" | "succeeded" | "failed" | "blocked" = "in_progress";
    let currentWave = 1;
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
    let lastEventHash = "0".repeat(64);

    for (const e of events) {
      lastEventHash = e.eventHash;
      missionId = e.missionId;

      switch (e.type) {
        case "mission_started":
          status = "in_progress";
          break;

        case "work_item_discovered":
          workItems.set(e.workItemId, {
            id: e.workItemId,
            title: e.title,
            scope: e.scope,
            dependsOn: e.dependsOn,
            state: "pending",
            runs: [],
            reviews: [],
          });
          progress.totalWorkItems = workItems.size;
          break;

        case "run_started":
          runs.set(e.runId, { id: e.runId, workItemId: e.workItemId, expertId: e.expertId, status: "running" });
          const item = workItems.get(e.workItemId);
          if (item) {
            item.state = "running";
            item.activeRunId = e.runId;
            item.runs.push(e.runId);
          }
          break;

        case "artifact_created":
          if (e.artifactKind === "diff") {
            const wi = workItems.get(e.workItemId);
            if (wi) wi.diffDigest = e.artifactHash;
          }
          break;

        case "run_finished":
          const run = runs.get(e.runId);
          if (run) run.status = e.status;
          const targetWi = workItems.get(e.workItemId);
          if (targetWi && targetWi.activeRunId === e.runId) {
            if (e.status === "succeeded") {
              targetWi.state = "reviewed"; // Pending review attestation
            } else {
              targetWi.state = "failed";
            }
          }
          break;

        case "review_attested":
          const reviewedWi = workItems.get(e.workItemId);
          if (reviewedWi) {
            reviewedWi.reviews.push({ reviewer: e.reviewerExpertId, verdict: e.verdict });
            if (e.verdict === "approved" && reviewedWi.reviews.filter((r) => r.verdict === "approved").length >= 2) {
              reviewedWi.state = "accepted";
            }
          }
          break;

        case "gate_evaluated":
          progress = e.progressVector;
          break;

        case "wave_transitioned":
          currentWave = e.toWave;
          break;

        case "wave_started":
          currentWave = e.waveIndex;
          break;

        case "round_started":
          currentWave = e.roundIndex;
          break;

        case "integration_attempted":
          if (e.status === "integrated") {
            progress.acceptedWorkItems = e.workItemsIntegrated.length;
            for (const id of e.workItemsIntegrated) {
              const item = workItems.get(id);
              if (item) {
                item.state = "accepted";
              }
            }
          } else if (e.status === "conflict_blocked") {
            status = "blocked";
          }
          break;

        case "terminal_verdict_rendered":
          status = e.status;
          break;

        case "mission_finished":
          status = e.finalStatus === "succeeded" ? "succeeded" : (e.finalStatus === "no_progress_blocked" ? "blocked" : "failed");
          progress = e.finalProgress;
          if (e.finalStatus === "succeeded") {
            for (const item of workItems.values()) {
              if (item.state !== "failed" && item.state !== "blocked") {
                item.state = "accepted";
              }
            }
          }
          break;
      }
    }

    return {
      missionId,
      status,
      currentWave,
      workItems,
      runs,
      progress,
      eventCount: events.length,
      lastEventHash,
    };
  }
}

/**
 * Deterministic ID Generators
 */
export function generateDeterministicRunId(workItemId: string, expertId: string, seq: number): string {
  return `run-${workItemId}-${expertId}-${String(seq).padStart(2, "0")}`;
}

export function generateDeterministicWorkItemId(scopeId: string): string {
  return `work-${scopeId.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()}`;
}
