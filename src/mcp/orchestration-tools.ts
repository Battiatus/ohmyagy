import { existsSync } from "node:fs";
import { join } from "node:path";
import { isRecord, sha256 } from "../ledger/canonical.js";
import { GraphBroker, GraphBrokerError } from "../graph/broker.js";
import type { GraphProposal } from "../graph/proposal.js";
import { projectGraph, type ProjectedNode } from "../graph/kernel.js";
import { graphPaths, loadGraphRuntime, verifyGraphStore } from "../graph/store.js";
import type { ExecutionGraph, GraphEdge, GraphNode } from "../graph/model.js";
import { MissionEventsStore } from "../ledger/mission-events.js";
import { findActiveMissionId } from "../mission/read-model.js";
import {
  evaluateConvergenceStep,
  type ConvergenceStepResult,
  type DynamicWorkflowLimits,
} from "../orchestration/convergence-step.js";
import type { ProgressVector } from "../oracle/objective-judge.js";
import { BrainStore } from "../brain/brain-store.js";
import { ingestMissionIntoBrain } from "../brain/mission-ingest.js";

/**
 * MCP tool surface for Unified Session-Native Orchestration & Dynamic Convergence.
 *
 * Exposes:
 * - converge_step: Evaluates one convergence step, calculates progress monotonicity,
 *   detects 2-round stagnation (no_progress_blocked), and returns ready nodes.
 * - converge_status: Read-only query of current convergence progress, DAG state, and budgets.
 * - graph_replan: Dynamic replanning on verifier/gate failure, inserting diagnostic (explorer)
 *   or repair (executor) nodes via atomic Kahn-validated GraphProposal.
 */

export const ORCHESTRATION_TOOL_NAMES = new Set([
  "converge_step",
  "converge_status",
  "graph_replan",
]);

export const ORCHESTRATION_SUCCESS_STATUSES = new Set([
  "in_progress",
  "succeeded",
  "no_progress_blocked",
  "budget_exhausted",
  "replanned",
  "converged",
  "status",
  "reported",
  "evaluated",
  "failed",
]);

export const ORCHESTRATION_TOOL_DEFINITIONS = [
  {
    name: "converge_step",
    description:
      "Evaluate one convergence step of the active session or mission. Projects graph ready nodes, computes progress vector, checks for stagnation (2-round no progress blocked) or budget exhaustion, and returns next step guidance.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: {
          type: "string",
          description: "Optional mission identifier. Defaults to active mission or 'oma-session'.",
        },
        currentProgress: {
          type: "object",
          description: "Optional current ProgressVector from test or gate execution.",
          properties: {
            hiddenTestsFailing: { type: "number" },
            hiddenTestsPassed: { type: "number" },
            visibleTestsFailing: { type: "number" },
            visibleTestsPassed: { type: "number" },
            gateFailures: { type: "number" },
            openDiagnosticsCount: { type: "number" },
            acceptedWorkItems: { type: "number" },
            totalWorkItems: { type: "number" },
          },
        },
        progressHistory: {
          type: "array",
          description: "Optional historical ProgressVectors for stagnation evaluation.",
          items: { type: "object" },
        },
        limits: {
          type: "object",
          description: "Optional dynamic convergence limits override.",
          properties: {
            maxRounds: { type: "number" },
            maxTimeMs: { type: "number" },
            maxConsecutiveNoProgressRounds: { type: "number" },
          },
        },
        currentRound: {
          type: "number",
          description: "Current wave/round index (1-based).",
        },
        isIntegrated: {
          type: "boolean",
          description: "Whether all required items have been verified and integrated into HEAD.",
        },
      },
    },
  },
  {
    name: "converge_status",
    description:
      "Report the read-only convergence status of the active session or mission: ready nodes, current progress vector, wave/round number, stagnation metrics, and graph topology counts. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: {
          type: "string",
          description: "Optional mission identifier. Defaults to active mission.",
        },
      },
    },
  },
  {
    name: "graph_replan",
    description:
      "Dynamically replan upon verifier or gate failure by inserting a targeted diagnostic or repair node (role 'explorer' or 'executor') with a conditional failure edge via a Kahn-validated atomic GraphProposal.",
    inputSchema: {
      type: "object",
      properties: {
        failedNodeId: {
          type: "string",
          description: "ID of the node that failed verification or gate evaluation.",
        },
        failureReason: {
          type: "string",
          description: "Error diagnostic or failure explanation from verifier or gate.",
        },
        role: {
          type: "string",
          enum: ["explorer", "executor"],
          description: "Role for the new node: 'explorer' for root-cause diagnosis, 'executor' for direct repair (default: 'explorer').",
        },
        title: {
          type: "string",
          description: "Optional custom title for the new node.",
        },
        scope: {
          type: "array",
          items: { type: "string" },
          description: "Optional file scopes to investigate or repair.",
        },
        wave: {
          type: "number",
          description: "Current wave index (defaults to revision + 1).",
        },
        missionId: {
          type: "string",
          description: "Optional mission identifier.",
        },
      },
      required: ["failedNodeId"],
    },
  },
];

export function executeOrchestrationTool(
  workspaceRoot: string,
  toolName: string,
  input: unknown,
  injectedBrain?: BrainStore,
): Record<string, unknown> {
  switch (toolName) {
    case "converge_step":
      return executeConvergeStep(workspaceRoot, input, injectedBrain);
    case "converge_status":
      return executeConvergeStatus(workspaceRoot, input);
    case "graph_replan":
      return executeGraphReplan(workspaceRoot, input);
    default:
      throw new Error(`Unknown orchestration tool: ${toolName}`);
  }
}

function resolveMissionId(workspaceRoot: string, input: unknown): string {
  if (isRecord(input) && typeof input.missionId === "string" && input.missionId.trim()) {
    return input.missionId.trim();
  }
  return findActiveMissionId(workspaceRoot) ?? "oma-session";
}

function readProgressHistoryFromEvents(workspaceRoot: string, missionId: string): ProgressVector[] {
  const eventsPath = join(workspaceRoot, ".oma", "missions", missionId, "events.jsonl");
  if (!existsSync(eventsPath)) return [];
  try {
    const events = MissionEventsStore.readEvents(eventsPath);
    return events
      .filter((e) => e.type === "gate_evaluated" && (e as any).progressVector)
      .map((e) => (e as any).progressVector as ProgressVector);
  } catch {
    return [];
  }
}

export function executeConvergeStep(
  workspaceRoot: string,
  input: unknown,
  injectedBrain?: BrainStore,
): Record<string, unknown> {
  const missionId = resolveMissionId(workspaceRoot, input);
  const paths = graphPaths(workspaceRoot);

  if (!existsSync(paths.definition) && !existsSync(paths.events)) {
    throw new Error(
      `Execution graph store not found at ${paths.graphDir}. Please run graph_init first.`,
    );
  }

  const runtime = loadGraphRuntime(workspaceRoot);
  const verification = verifyGraphStore(runtime);
  const graphEvents = verification.events;

  const limits: DynamicWorkflowLimits = {
    maxRounds:
      isRecord(input) && isRecord(input.limits) && typeof input.limits.maxRounds === "number"
        ? input.limits.maxRounds
        : 5,
    maxTimeMs:
      isRecord(input) && isRecord(input.limits) && typeof input.limits.maxTimeMs === "number"
        ? input.limits.maxTimeMs
        : 300_000,
    maxConsecutiveNoProgressRounds:
      isRecord(input) &&
      isRecord(input.limits) &&
      typeof input.limits.maxConsecutiveNoProgressRounds === "number"
        ? input.limits.maxConsecutiveNoProgressRounds
        : 2,
  };

  let progressHistory: ProgressVector[] = [];
  if (isRecord(input) && Array.isArray(input.progressHistory)) {
    progressHistory = input.progressHistory as ProgressVector[];
  } else {
    progressHistory = readProgressHistoryFromEvents(workspaceRoot, missionId);
  }

  const currentProgress =
    isRecord(input) && isRecord(input.currentProgress)
      ? (input.currentProgress as unknown as ProgressVector)
      : undefined;

  const currentRound =
    isRecord(input) && typeof input.currentRound === "number" ? input.currentRound : undefined;

  const isIntegrated =
    isRecord(input) && typeof input.isIntegrated === "boolean" ? input.isIntegrated : undefined;

  const stepResult = evaluateConvergenceStep({
    graph: runtime.graph,
    events: graphEvents,
    progressHistory,
    limits,
    currentProgress,
    currentRound,
    isIntegrated,
  });

  // Ingest convergence step and graph state into the Brain (fail-open)
  try {
    const shouldClose = !injectedBrain;
    const brain =
      injectedBrain ??
      new BrainStore(process.env.OMA_BRAIN_PATH ?? join(workspaceRoot, ".oma", "brain.sqlite"));
    try {
      ingestMissionIntoBrain({
        brain,
        missionId,
        workspaceRoot,
        graph: runtime.graph,
        graphEvents,
        roundNumber: currentRound,
      });
    } finally {
      if (shouldClose) {
        brain.close();
      }
    }
  } catch {
    // Fail-open: Orchestration convergence step must never fail due to brain ingestion
  }

  return {
    status: stepResult.status,
    convergenceStatus: stepResult.status,
    missionId,
    readyNodes: stepResult.readyNodes,
    progress: stepResult.progress,
    diagnosis: stepResult.diagnosis,
    consecutiveNoProgressRounds: stepResult.consecutiveNoProgressRounds,
    totalRounds: stepResult.totalRounds,
    graphRevision: runtime.graph.revision,
  };
}

export function executeConvergeStatus(
  workspaceRoot: string,
  input: unknown,
): Record<string, unknown> {
  const missionId = resolveMissionId(workspaceRoot, input);
  const paths = graphPaths(workspaceRoot);

  if (!existsSync(paths.definition) && !existsSync(paths.events)) {
    return {
      status: "status",
      convergenceStatus: "not_initialized",
      missionId,
      readyNodes: [],
      nodeCounts: { total: 0, ready: 0, running: 0, succeeded: 0, failed: 0 },
      diagnosis: "Graph store not initialized in this workspace.",
    };
  }

  const runtime = loadGraphRuntime(workspaceRoot);
  const verification = verifyGraphStore(runtime);
  const projection = projectGraph(runtime.graph, verification.events);
  const progressHistory = readProgressHistoryFromEvents(workspaceRoot, missionId);

  const stepResult = evaluateConvergenceStep({
    graph: runtime.graph,
    events: verification.events,
    progressHistory,
    limits: { maxRounds: 5, maxTimeMs: 300_000, maxConsecutiveNoProgressRounds: 2 },
  });

  return {
    status: "status",
    convergenceStatus: stepResult.status,
    missionId,
    graphId: runtime.graph.graphId,
    revision: runtime.graph.revision,
    readyNodes: stepResult.readyNodes,
    progress: stepResult.progress,
    consecutiveNoProgressRounds: stepResult.consecutiveNoProgressRounds,
    totalRounds: stepResult.totalRounds,
    nodeCounts: {
      total: runtime.graph.nodes.length,
      ready: stepResult.readyNodes.length,
      running: projection.nodes.filter((n) => n.state === "running").length,
      succeeded: projection.nodes.filter((n) => n.state === "succeeded").length,
      failed: projection.nodes.filter((n) => n.state === "failed").length,
    },
    diagnosis: stepResult.diagnosis,
  };
}

export function executeGraphReplan(
  workspaceRoot: string,
  input: unknown,
): Record<string, unknown> {
  if (!isRecord(input) || typeof input.failedNodeId !== "string" || !input.failedNodeId.trim()) {
    throw new Error("graph_replan requires a non-empty 'failedNodeId' string property.");
  }

  const failedNodeId = input.failedNodeId.trim();
  const role: "explorer" | "executor" = input.role === "executor" ? "executor" : "explorer";
  const failureReason =
    typeof input.failureReason === "string" ? input.failureReason.trim() : undefined;
  const missionId = resolveMissionId(workspaceRoot, input);

  const runtime = loadGraphRuntime(workspaceRoot);
  const failedNode = runtime.graph.nodes.find((n) => n.id === failedNodeId);

  if (!failedNode) {
    throw new Error(`Failed node '${failedNodeId}' was not found in the execution graph.`);
  }

  const wave =
    typeof input.wave === "number" && input.wave > 0 ? input.wave : runtime.graph.revision + 1;
  const prefix = role === "explorer" ? "diag" : "repair";
  const persona = role === "explorer" ? "explorer" : "executor";
  const baseNewId = `${failedNodeId}-${prefix}-w${wave}`;

  let targetNodeId = baseNewId;
  let counter = 1;
  while (runtime.graph.nodes.some((n) => n.id === targetNodeId)) {
    targetNodeId = `${baseNewId}-${counter++}`;
  }

  const title =
    typeof input.title === "string" && input.title.trim()
      ? input.title.trim()
      : role === "explorer"
        ? `Diagnostic: investigate failure in ${failedNode.title}`
        : `Repair: ${failedNode.title}`;

  const scope = Array.isArray(input.scope)
    ? input.scope.map(String)
    : (failedNode.scope ?? []);

  const newNode: GraphNode = {
    id: targetNodeId,
    title,
    kind: "agent",
    activation: "all",
    completionAuthority: "broker",
    completionAuthorityId: failedNode.completionAuthorityId || "oma-broker",
    executor: { adapter: "agy", persona },
    scope,
    acceptance: failedNode.acceptance,
    maxDiff: failedNode.maxDiff,
  };

  const newEdge: GraphEdge = {
    id: `edge-${failedNodeId}-${targetNodeId}`,
    from: failedNodeId,
    to: targetNodeId,
    when: "failure",
  };

  const proposalId = `prop_${sha256(`${missionId}:${targetNodeId}:${runtime.graph.revision}`).slice(0, 24)}`;
  const proposal: GraphProposal = {
    schemaVersion: 2,
    proposalId,
    expectedRevision: runtime.graph.revision,
    author: "oma-orchestrator",
    proposerPersona: "orchestrator",
    reason: failureReason
      ? `Dynamic replan on verifier failure (${failureReason}) inserting ${role} node.`
      : `Dynamic replan on verifier failure inserting ${role} node.`,
    missionId,
    parentGraphHash: runtime.graphHash,
    operations: [
      { type: "add_node", node: newNode },
      { type: "add_edge", edge: newEdge },
    ],
  };

  const broker = new GraphBroker(workspaceRoot);
  const result = broker.applyProposalSync(proposal);

  if (!result.success) {
    throw new GraphBrokerError(
      result.code,
      result.error ?? "Dynamic replan proposal rejected",
      result.diagnostics,
      result.cyclePath,
    );
  }

  // Optionally record in mission journal if mission events exist
  const eventsPath = join(workspaceRoot, ".oma", "missions", missionId, "events.jsonl");
  if (existsSync(eventsPath)) {
    try {
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "work_item_discovered",
        workItemId: targetNodeId,
        title: newNode.title,
        scope: newNode.scope ?? [],
        dependsOn: [failedNode.id],
        roleRequired: role,
        acceptanceCriteria: (newNode.acceptance ?? []).map((c) => c.description),
      });
    } catch {}
  }

  // Project updated graph to check if the new node is immediately ready
  const updatedRuntime = loadGraphRuntime(workspaceRoot);
  const verification = verifyGraphStore(updatedRuntime);
  const updatedProjection = projectGraph(updatedRuntime.graph, verification.events);
  const readyNodes = updatedProjection.readySet;
  const isReady = readyNodes.includes(targetNodeId);

  return {
    status: "replanned",
    proposalId: proposal.proposalId,
    appliedRevision: result.revision,
    role,
    newNodeId: targetNodeId,
    failedNodeId: failedNode.id,
    readyNodes,
    isReady,
    diagnosis: failureReason,
  };
}
