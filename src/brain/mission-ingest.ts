import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { sha256 } from "../ledger/canonical.js";
import { MissionEventsStore, type SequencedMissionEvent } from "../ledger/mission-events.js";
import {
  MissionProjectionEngine,
  type FullMissionProjection,
} from "../graph/mission-projections.js";
import { projectGraph } from "../graph/kernel.js";
import type { ExecutionGraph, GraphEvent } from "../graph/model.js";
import type { BrainStore } from "./brain-store.js";
import type { CompactionOptions, CompactionResult } from "./types.js";

/**
 * Input contract for ingesting a mission into the Neural Brain.
 */
export interface IngestMissionOptions {
  /** Target BrainStore instance. */
  brain: BrainStore;
  /** Identifier of the mission being ingested. */
  missionId: string;
  /** Workspace root path (used to derive default projectId and paths). */
  workspaceRoot?: string;
  /** Explicit target project identifier. */
  projectId?: string;
  /** Explicit target session identifier. */
  sessionId?: string;
  /** Pre-loaded sequenced mission events. */
  events?: SequencedMissionEvent[];
  /** Path to events.jsonl if events are not preloaded. */
  eventsPath?: string;
  /** Pre-computed FullMissionProjection (derived from events if omitted). */
  projection?: FullMissionProjection;
  /** Optional ExecutionGraph to project and ingest nodes. */
  graph?: ExecutionGraph;
  /** Optional GraphEvents corresponding to graph. */
  graphEvents?: GraphEvent[];
  /** Optional round number to associate with newly recorded interaction summaries. */
  roundNumber?: number;
  /** Whether to trigger automatic compaction after ingestion in fail-open mode. Default: true. */
  autoCompact?: boolean;
  /** Compaction interval in rounds for interaction-based auto-compaction (default: 10). */
  autoCompactInterval?: number;
  /** Optional compaction options passed to brain.compact. */
  compactionOptions?: CompactionOptions;
}

/**
 * Result of ingesting a mission into the Brain.
 */
export interface IngestMissionResult {
  status: "ingested" | "skipped" | "failed";
  missionId: string;
  projectId: string;
  sessionId: string;
  runSummariesCreated: number;
  pastErrorsCreated: number;
  interactionsRecorded: number;
  compaction?: CompactionResult;
  error?: string;
}


/**
 * Ingest mission events and projections into the Neural Brain.
 *
 * Guarantees:
 * 1. Fail-open: Never throws; captures all errors and returns a structured failure report.
 * 2. Idempotent: Uses deterministic SHA-256 keys so repeated calls for the same mission
 *    update existing entries in place without duplicating memories.
 * 3. Node-linked: Translates work items, runs, reviews, and gates into `run_summary`
 *    and `past_error` memory entries, as well as `interaction_summaries`, strictly
 *    associated with their corresponding `node_ref`.
 */
export function ingestMissionIntoBrain(options: IngestMissionOptions): IngestMissionResult {
  const { brain, missionId } = options;

  let projectId = options.projectId ?? "";
  let sessionId = options.sessionId ?? "";

  try {
    if (!missionId || missionId.trim().length === 0) {
      return {
        status: "failed",
        missionId: "",
        projectId: "",
        sessionId: "",
        runSummariesCreated: 0,
        pastErrorsCreated: 0,
        interactionsRecorded: 0,
        error: "Cannot ingest mission: missionId is required and must not be empty.",
      };
    }

    // 1. Resolve Project
    if (!projectId) {
      const root = options.workspaceRoot ?? process.cwd();
      const project = brain.ensureProject({
        name: basename(root) || "workspace",
        rootPath: root,
      });
      projectId = project.id;
    }

    // 2. Resolve Session
    if (!sessionId) {
      const existingSessions = brain.listSessions(projectId);
      const missionSession = existingSessions.find(
        (s) => s.objective === `Mission ${missionId}` || s.objective?.includes(missionId),
      );
      if (missionSession) {
        sessionId = missionSession.id;
      } else {
        const newSession = brain.startSession({
          projectId,
          objective: `Mission ${missionId}`,
        });
        sessionId = newSession.id;
      }
    } else {
      const existingSession = brain.getSession(sessionId);
      if (!existingSession) {
        brain.startSession({
          id: sessionId,
          projectId,
          objective: `Mission ${missionId}`,
        });
      }
    }

    // 3. Resolve Events
    let events: SequencedMissionEvent[] = options.events ?? [];
    if (events.length === 0) {
      let resolvedEventsPath = options.eventsPath;
      if (!resolvedEventsPath && options.workspaceRoot) {
        resolvedEventsPath = join(
          options.workspaceRoot,
          ".oma",
          "missions",
          missionId,
          "events.jsonl",
        );
      }
      if (resolvedEventsPath && existsSync(resolvedEventsPath)) {
        try {
          events = MissionEventsStore.readEvents(resolvedEventsPath);
        } catch {
          events = [];
        }
      }
    }

    // 4. Resolve Projection
    let projection: FullMissionProjection | undefined = options.projection;
    if (!projection && events.length > 0) {
      try {
        projection = MissionProjectionEngine.project(events);
      } catch {
        projection = undefined;
      }
    }

    if (events.length === 0 && !projection && !options.graph) {
      return {
        status: "skipped",
        missionId,
        projectId,
        sessionId,
        runSummariesCreated: 0,
        pastErrorsCreated: 0,
        interactionsRecorded: 0,
        error: `No events, projection, or graph found for mission '${missionId}'`,
      };
    }

    let runSummariesCreated = 0;
    let pastErrorsCreated = 0;
    let interactionsRecorded = 0;

    // 5. Ingest work item nodes -> run_summary and interaction_summaries
    if (projection?.workGraph?.workItems) {
      let roundCounter = options.roundNumber ?? brain.getNextRoundNumber(sessionId);
      for (const [nodeId, item] of Object.entries(projection.workGraph.workItems)) {
        const nodeRef = item.id || nodeId;

        // A. run_summary for work item
        const memId = sha256(`oma-brain:run_summary:${missionId}:node:${nodeRef}`);
        const scopeStr = item.scope && item.scope.length > 0 ? item.scope.join(", ") : "none";
        const artifactsStr =
          item.producedArtifacts && item.producedArtifacts.length > 0
            ? item.producedArtifacts.join(", ")
            : "none";

        brain.storeMemory({
          id: memId,
          projectId,
          sessionId,
          dimension: "run_summary",
          title: `Node ${nodeRef}: ${item.title}`,
          content: `Work item '${item.title}' [node: ${nodeRef}] reached state '${item.state}'. Scope: ${scopeStr}. Produced artifacts: ${artifactsStr}. Diff digest: ${item.diffDigest ?? "none"}.`,
          tags: ["run_summary", "work_item", nodeRef, `node:${nodeRef}`, `mission:${missionId}`, item.state],
          confidence: item.state === "accepted" ? 1.0 : 0.85,
        });
        runSummariesCreated++;

        // B. interaction_summary tied to nodeRef
        const intId = sha256(`oma-brain:interaction:${missionId}:node:${nodeRef}`);
        brain.recordInteraction({
          id: intId,
          sessionId,
          roundNumber: roundCounter++,
          context: `Execute node ${nodeRef}: ${item.title}`,
          actions: `Work item in state '${item.state}'. Assigned expert: ${item.assignedExpert ?? "executor"}. Scope: ${scopeStr}.`,
          outcome: `State: ${item.state}`,
          nodeRef,
        });
        interactionsRecorded++;

        // C. If work item failed, record a past_error tied to nodeRef
        if (item.state === "failed" || item.state === "blocked") {
          const failId = sha256(`oma-brain:past_error:${missionId}:work_item:${nodeRef}`);
          brain.storeMemory({
            id: failId,
            projectId,
            sessionId,
            dimension: "past_error",
            title: `Work item ${item.state}: ${nodeRef}`,
            content: `Work item '${item.title}' [node: ${nodeRef}] ended in state '${item.state}'. Scope: ${scopeStr}.`,
            tags: ["past_error", "work_item_failed", nodeRef, `node:${nodeRef}`, `mission:${missionId}`],
            confidence: 0.9,
          });
          pastErrorsCreated++;
        }
      }
    }

    // 5b. If graph is provided, ingest graph nodes as well
    if (options.graph) {
      try {
        const graphProjection = projectGraph(options.graph, options.graphEvents ?? []);
        let roundCounter = options.roundNumber ?? brain.getNextRoundNumber(sessionId);
        for (const node of graphProjection.nodes) {
          const nodeRef = node.id;
          const originalNode = options.graph.nodes.find((n) => n.id === node.id);
          const scopeStr = originalNode?.scope && originalNode.scope.length > 0 ? originalNode.scope.join(", ") : "none";

          if (node.state === "succeeded" || node.state === "running") {
            const memId = sha256(`oma-brain:run_summary:${missionId}:graph_node:${nodeRef}`);
            brain.storeMemory({
              id: memId,
              projectId,
              sessionId,
              dimension: "run_summary",
              title: `Graph node ${nodeRef}: ${node.title}`,
              content: `Graph node '${node.title}' [node: ${nodeRef}] state is '${node.state}'. Scope: ${scopeStr}.`,
              tags: ["run_summary", "graph_node", nodeRef, `node:${nodeRef}`, `mission:${missionId}`, node.state],
              confidence: node.state === "succeeded" ? 1.0 : 0.8,
            });
            runSummariesCreated++;
          } else if (node.state === "failed") {
            const errId = sha256(`oma-brain:past_error:${missionId}:graph_node:${nodeRef}`);
            brain.storeMemory({
              id: errId,
              projectId,
              sessionId,
              dimension: "past_error",
              title: `Graph node failure: ${nodeRef}`,
              content: `Graph node '${node.title}' [node: ${nodeRef}] failed execution. Scope: ${scopeStr}.`,
              tags: ["past_error", "graph_node_failure", nodeRef, `node:${nodeRef}`, `mission:${missionId}`],
              confidence: 0.95,
            });
            pastErrorsCreated++;
          }

          const intId = sha256(`oma-brain:interaction:${missionId}:graph_node:${nodeRef}`);
          brain.recordInteraction({
            id: intId,
            sessionId,
            roundNumber: roundCounter++,
            context: `Execute graph node ${nodeRef}: ${node.title}`,
            actions: `Graph node reached state '${node.state}'. Scope: ${scopeStr}.`,
            outcome: `State: ${node.state}`,
            nodeRef,
          });
          interactionsRecorded++;
        }
      } catch {
        // fail-open
      }
    }

    // 6. Ingest overall mission / wave run_summaries
    if (projection) {
      const overallMemId = sha256(`oma-brain:run_summary:${missionId}:overall`);
      brain.storeMemory({
        id: overallMemId,
        projectId,
        sessionId,
        dimension: "run_summary",
        title: `Mission ${missionId}: ${projection.status}`,
        content: `Mission '${missionId}' completed with status '${projection.status}' at wave ${projection.currentWave}. Total events: ${projection.totalEventsProcessed}. Accepted items: ${projection.progress.acceptedWorkItems}/${projection.progress.totalWorkItems}. Visible tests passing: ${projection.progress.visibleTestsPassed}.`,
        tags: ["run_summary", "mission_overview", `mission:${missionId}`, projection.status],
        confidence: 1.0,
      });
      runSummariesCreated++;
    }

    // 7. Ingest events: wave transitions, failed gates, failed runs, rejected reviews
    for (const event of events) {
      if (event.type === "wave_transitioned") {
        const waveMemId = sha256(`oma-brain:run_summary:${missionId}:wave:${event.fromWave}`);
        brain.storeMemory({
          id: waveMemId,
          projectId,
          sessionId,
          dimension: "run_summary",
          title: `Wave ${event.fromWave} transition: ${missionId}`,
          content: `Wave transitioned from ${event.fromWave} to ${event.toWave}. Reason: ${event.reason}. Progress: accepted ${event.progressAfter.acceptedWorkItems}/${event.progressAfter.totalWorkItems}.`,
          tags: ["run_summary", "wave_transition", `wave:${event.fromWave}`, `mission:${missionId}`],
          confidence: 0.95,
        });
        runSummariesCreated++;
      } else if (event.type === "gate_evaluated" && event.status === "failed") {
        const gateErrId = sha256(`oma-brain:past_error:${missionId}:gate:${event.gateId}:${event.seq}`);
        const diagnostics = event.diagnostics && event.diagnostics.length > 0 ? event.diagnostics.join("; ") : "Gate evaluation failed.";
        brain.storeMemory({
          id: gateErrId,
          projectId,
          sessionId,
          dimension: "past_error",
          title: `Gate failure: ${event.gateId}`,
          content: `Gate '${event.gateId}' failed during mission '${missionId}'. Diagnostics: ${diagnostics}`,
          tags: ["past_error", "gate_failure", event.gateId, `mission:${missionId}`],
          confidence: 1.0,
        });
        pastErrorsCreated++;
      } else if (event.type === "run_finished" && (event.status === "failed" || event.status === "timed_out")) {
        const nodeRef = event.workItemId;
        const runErrId = sha256(`oma-brain:past_error:${missionId}:run:${event.runId}`);
        brain.storeMemory({
          id: runErrId,
          projectId,
          sessionId,
          dimension: "past_error",
          title: `Run failure: ${nodeRef} (${event.expertId})`,
          content: `Expert '${event.expertId}' failed on [node: ${nodeRef}] with status '${event.status}'. Error: ${event.error ?? "unspecified error"}.`,
          tags: ["past_error", "run_failure", nodeRef, `node:${nodeRef}`, event.expertId, `mission:${missionId}`],
          confidence: 1.0,
        });
        pastErrorsCreated++;
      } else if (event.type === "review_attested" && event.verdict === "rejected") {
        const nodeRef = event.workItemId;
        const reviewErrId = sha256(`oma-brain:past_error:${missionId}:review:${event.runId}:${event.seq}`);
        const obs = event.observations && event.observations.length > 0 ? event.observations.join("; ") : "Reviewer rejected changes.";
        brain.storeMemory({
          id: reviewErrId,
          projectId,
          sessionId,
          dimension: "past_error",
          title: `Review rejected: ${nodeRef}`,
          content: `Reviewer '${event.reviewerExpertId}' rejected changes for [node: ${nodeRef}]. Observations: ${obs}.`,
          tags: ["past_error", "review_rejection", nodeRef, `node:${nodeRef}`, event.reviewerExpertId, `mission:${missionId}`],
          confidence: 0.95,
        });
        pastErrorsCreated++;
      }
    }

    // 8. Auto-compaction after mission ingestion in fail-open mode
    let compaction: CompactionResult | undefined;
    if (options.autoCompact !== false) {
      const shouldCompact =
        options.autoCompactInterval === undefined ||
        options.autoCompactInterval <= 0 ||
        (interactionsRecorded > 0 && interactionsRecorded % options.autoCompactInterval === 0);

      if (shouldCompact) {
        try {
          compaction = brain.compact({
            projectId,
            ...options.compactionOptions,
          });
        } catch {
          // Fail-open: compaction failure must never fail mission ingestion
        }
      }
    }

    return {
      status: "ingested",
      missionId,
      projectId,
      sessionId,
      runSummariesCreated,
      pastErrorsCreated,
      interactionsRecorded,
      ...(compaction ? { compaction } : {}),
    };

  } catch (err) {
    // Fail-open: Never let ingestion failure crash the mission or conductor
    return {
      status: "failed",
      missionId,
      projectId: projectId || "unknown",
      sessionId: sessionId || "unknown",
      runSummariesCreated: 0,
      pastErrorsCreated: 0,
      interactionsRecorded: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
