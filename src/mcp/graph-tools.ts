import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, sha256 } from "../ledger/canonical.js";
import { GraphBroker, GraphBrokerError } from "../graph/broker.js";
import { parseGraphProposal } from "../graph/proposal.js";
import { projectGraph, type ProjectedNode } from "../graph/kernel.js";
import {
  appendGraphTransition,
  graphPaths,
  initializeGraphStore,
  loadGraphRuntime,
  verifyGraphStore,
} from "../graph/store.js";
import {
  parseExecutionGraph,
  type ExecutionGraph,
  type GraphAuthority,
  type GraphEdge,
  type GraphEvent,
  type GraphNode,
} from "../graph/model.js";
import { MissionEventsStore, type WorkItemDiscoveredPayload } from "../ledger/mission-events.js";
import { eventsPathFor, findActiveMissionId, ensureMissionStarted } from "../mission/read-model.js";
import { assertInterviewAuthorisesExecution } from "../mission/interview-gate.js";
import { assertNodeCompletionIsAttributed } from "../mission/run-attribution.js";

/**
 * MCP tool surface for the Execution Graph.
 *
 * Vocabulary reconciliation between Approach A specification and underlying engine:
 * - spec graph_init        -> store.ts initializeGraphStore(root) + graphPaths(root)
 * - spec graph_propose     -> proposal.ts parseGraphProposal + broker.ts GraphBroker.validateProposalSync
 * - spec graph_apply       -> broker.ts GraphBroker.applyProposalSync + store.ts appendGraphTransition
 * - spec graph_ready_nodes -> store.ts loadGraphRuntime + kernel.ts projectGraph -> NodeState === "ready"
 * - spec graph_mark_node   -> store.ts appendGraphTransition + kernel.ts assertTransitionAllowed
 * - spec graph_inspect     -> kernel.ts projectGraph + store.ts verifyGraphStore
 *
 * These six tools are thin MCP wrappers around the existing src/graph/ engine.
 */

export const GRAPH_TOOL_NAMES = new Set([
  "graph_init",
  "graph_propose",
  "graph_apply",
  "graph_ready_nodes",
  "graph_mark_node",
  "graph_inspect",
]);

export const GRAPH_SUCCESS_STATUSES = new Set([
  "initialized",
  "proposed",
  "applied",
  "ready_nodes",
  "node_marked",
  "inspected",
]);

export const GRAPH_TOOL_DEFINITIONS = [
  {
    name: "graph_init",
    description:
      "Initialize an execution graph store for an objective, mission, or explicit initial DAG, returning the mission and graph identifiers.",
    inputSchema: {
      type: "object",
      properties: {
        missionId: {
          type: "string",
          description: "Unique mission identifier. Defaults to mission-<timestamp>.",
        },
        goal: {
          type: "string",
          description: "Mission goal or high-level objective.",
        },
        objective: {
          type: "string",
          description: "Synonym for goal.",
        },
        graphId: {
          type: "string",
          description: "Optional graph identifier (defaults to graph-<missionId>).",
        },
        nodes: {
          type: "array",
          description: "Optional explicit initial GraphNode array.",
        },
        edges: {
          type: "array",
          description: "Optional explicit initial GraphEdge array.",
        },
        schedulerAuthorityId: {
          type: "string",
          description: "Scheduler identity (defaults to 'oma-scheduler').",
        },
      },
    },
  },
  {
    name: "graph_propose",
    description:
      "Submit an atomic DAG extension proposal (GraphProposal). Validates schema, CAS revision, DAG acyclicity via Kahn's algorithm, and returns diagnostics without mutating canonical state.",
    inputSchema: {
      type: "object",
      properties: {
        proposal: {
          type: "object",
          description: "The GraphProposal object to validate.",
        },
        schemaVersion: { type: "number", enum: [1, 2] },
        proposalId: { type: "string" },
        parentRevision: { type: "number" },
        expectedRevision: { type: "number" },
        parentGraphHash: { type: "string" },
        parentJournalHeadHash: { type: "string" },
        delta: { type: "object" },
        operations: { type: "array" },
        rationale: { type: "object" },
        resourceBudgetsDelta: { type: "object" },
      },
    },
  },
  {
    name: "graph_apply",
    description:
      "Validate and atomically apply an approved GraphProposal to the canonical execution graph via CAS, creating revision N+1 and appending a journal event.",
    inputSchema: {
      type: "object",
      properties: {
        proposal: {
          type: "object",
          description: "The GraphProposal object to apply.",
        },
        schemaVersion: { type: "number", enum: [1, 2] },
        proposalId: { type: "string" },
        parentRevision: { type: "number" },
        expectedRevision: { type: "number" },
        parentGraphHash: { type: "string" },
        parentJournalHeadHash: { type: "string" },
        delta: { type: "object" },
        operations: { type: "array" },
        rationale: { type: "object" },
        resourceBudgetsDelta: { type: "object" },
        missionId: { type: "string" },
      },
    },
  },
  {
    name: "graph_ready_nodes",
    description:
      "Get the ordered list of graph nodes ready for execution (all incoming dependencies satisfied). Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "graph_mark_node",
    description:
      "Update a node's execution state (running, succeeded, failed) with evidence. Enforces kernel state machine invariants and records signed transitions.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "ID of the target graph node.",
        },
        state: {
          type: "string",
          enum: ["running", "succeeded", "completed", "failed", "blocked"],
          description: "Target state for the node.",
        },
        dispatchId: {
          type: "string",
          description: "Unique dispatch id (auto-generated if omitted).",
        },
        outcome: {
          type: "string",
          enum: ["success", "failure"],
          description: "Explicit outcome for completion.",
        },
        authority: {
          type: "string",
          enum: ["broker", "oracle", "scheduler", "human"],
          description: "Authority signing the transition.",
        },
        authorityId: {
          type: "string",
          description: "Identity of the signing authority.",
        },
        evidenceHash: {
          type: "string",
          description: "SHA-256 hash of completion evidence.",
        },
        evidence: {
          type: "string",
          description: "Raw evidence string used to compute evidenceHash if not provided.",
        },
        missionId: {
          type: "string",
          description: "Optional mission identifier.",
        },
      },
      required: ["nodeId", "state"],
    },
  },
  {
    name: "graph_inspect",
    description:
      "Inspect the complete state, projection, verification, and progress metrics of the canonical execution graph. Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
] as const;

function resolveSessionMissionId(workspaceRoot: string, input: Record<string, unknown>): string {
  if (typeof input.missionId === "string" && input.missionId.trim().length > 0) {
    return input.missionId.trim();
  }
  return findActiveMissionId(workspaceRoot) ?? "oma-session";
}


type RoleRequired = WorkItemDiscoveredPayload["roleRequired"];

function isRoleRequired(role: unknown): role is RoleRequired {
  return (
    typeof role === "string" &&
    (role === "planner" ||
      role === "explorer" ||
      role === "executor" ||
      role === "worker" ||
      role === "reviewer" ||
      role === "fixer" ||
      role === "verifier")
  );
}

function ensureWorkItemDiscovered(
  eventsPath: string,
  missionId: string,
  node: GraphNode,
  edges: GraphEdge[],
): void {
  try {
    const existing = MissionEventsStore.readEvents(eventsPath);
    const discovered = existing.some(
      (e) => e.type === "work_item_discovered" && e.workItemId === node.id,
    );
    if (!discovered) {
      const persona = node.executor?.persona;
      const roleRequired: RoleRequired = isRoleRequired(persona) ? persona : "executor";
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "work_item_discovered",
        workItemId: node.id,
        title: node.title,
        scope: node.scope ?? [],
        dependsOn: edges.filter((e) => e.to === node.id).map((e) => e.from),
        roleRequired,
        acceptanceCriteria: (node.acceptance ?? []).map((a) => a.description),
      });
    }
  } catch {}
}

export function executeGraphInit(
  workspaceRoot: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const paths = graphPaths(workspaceRoot);
  if (existsSync(paths.events) || existsSync(paths.head)) {
    throw new Error("Graph event store is already initialized");
  }
  mkdirSync(paths.graphDir, { recursive: true });

  const missionId =
    typeof input.missionId === "string" && input.missionId.trim().length > 0
      ? input.missionId.trim()
      : `mission-${Date.now()}`;
  const graphId =
    typeof input.graphId === "string" && input.graphId.trim().length > 0
      ? input.graphId.trim()
      : `graph-${missionId}`;
  const goal =
    typeof input.goal === "string" && input.goal.trim().length > 0
      ? input.goal.trim()
      : typeof input.objective === "string" && input.objective.trim().length > 0
        ? input.objective.trim()
        : undefined;
  const schedulerAuthorityId =
    typeof input.schedulerAuthorityId === "string" && input.schedulerAuthorityId.trim().length > 0
      ? input.schedulerAuthorityId.trim()
      : "oma-scheduler";

  let isCustomNodes = false;
  if (!existsSync(paths.definition)) {
    let initialGraph: ExecutionGraph;
    if (Array.isArray(input.nodes) && input.nodes.length > 0) {
      isCustomNodes = true;
      initialGraph = parseExecutionGraph({
        schemaVersion: 2,
        graphId,
        revision: 1,
        schedulerAuthorityId,
        nodes: input.nodes,
        edges: Array.isArray(input.edges) ? input.edges : [],
      });
    } else {
      const rootNodeId = "bootstrap";
      const rootNode: GraphNode = {
        id: rootNodeId,
        title: goal ?? "OMA bootstrap",
        kind: "join",
        activation: "all",
        completionAuthority: "scheduler",
        completionAuthorityId: schedulerAuthorityId,
        // Engine-seeded, not requested work. It exists only so revision 1 has a
        // parent for the first proposal. Marking it synthetic keeps a bare
        // `graph_init` from reporting the mission as succeeded.
        synthetic: true,
      };
      initialGraph = {
        schemaVersion: 2,
        graphId,
        revision: 1,
        schedulerAuthorityId,
        nodes: [rootNode],
        edges: [],
      };
    }
    writeFileSync(paths.definition, `${JSON.stringify(initialGraph, null, 2)}\n`, "utf8");
  }

  const runtime = initializeGraphStore(workspaceRoot);
  writeFileSync(join(paths.graphDir, "session-mission-id"), missionId, "utf8");
  const eventsPath = ensureMissionStarted(workspaceRoot, missionId, goal);

  for (const node of runtime.graph.nodes) {
    ensureWorkItemDiscovered(eventsPath, missionId, node, runtime.graph.edges);
  }

  if (!isCustomNodes && runtime.graph.nodes.some((n: GraphNode) => n.id === "bootstrap")) {
    const dispatchId = "dispatch-bootstrap";
    appendGraphTransition(runtime, {
      eventType: "node_dispatched",
      nodeId: "bootstrap",
      dispatchId,
      authorityId: schedulerAuthorityId,
    });
    appendGraphTransition(runtime, {
      eventType: "node_completed",
      nodeId: "bootstrap",
      dispatchId,
      authority: "scheduler",
      authorityId: schedulerAuthorityId,
      outcome: "success",
      evidenceHash: sha256(`bootstrap:${missionId}`),
    });
    try {
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "run_started",
        runId: dispatchId,
        workItemId: "bootstrap",
        expertId: "scheduler",
        model: "scheduler",
        effort: "low",
      });
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "run_finished",
        runId: dispatchId,
        workItemId: "bootstrap",
        expertId: "scheduler",
        status: "succeeded",
        durationMs: 0,
      });
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "integration_attempted",
        waveIndex: 1,
        workItemsIntegrated: ["bootstrap"],
        status: "integrated",
      });
    } catch {}
  }

  const deliverableNodes = runtime.graph.nodes.filter(
    (node: GraphNode) => node.synthetic !== true,
  ).length;

  return {
    status: "initialized",
    missionId,
    graphId: runtime.graph.graphId,
    revision: runtime.graph.revision,
    deliverableNodes,
    // Only the engine seed exists, so nothing has been delivered. The conductor
    // must propose real nodes; `graph_status` cannot be "succeeded" here.
    requiresPlan: deliverableNodes === 0,
    paths: {
      definition: paths.definition,
      events: paths.events,
      head: paths.head,
    },
  };
}

export function executeGraphPropose(
  workspaceRoot: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const proposalPayload = isRecord(input.proposal) ? input.proposal : input;
  const proposal = parseGraphProposal(proposalPayload);
  const broker = new GraphBroker(workspaceRoot);
  const validation = broker.validateProposalSync(proposal);
  if (!validation.valid) {
    const primary = validation.diagnostics[0];
    throw new GraphBrokerError(
      primary?.code ?? "CYCLE_DETECTED",
      primary?.message ?? "Proposal validation failed",
      validation.diagnostics,
      validation.cyclePath,
    );
  }
  return {
    status: "proposed",
    valid: true,
    proposalId: proposal.proposalId,
    deltaSummary: validation.deltaSummary,
    proposedGraph: validation.proposedGraph,
    topologicalOrder: validation.topologicalOrder,
  };
}

export function executeGraphApply(
  workspaceRoot: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const proposalPayload = isRecord(input.proposal) ? input.proposal : input;
  const proposal = parseGraphProposal(proposalPayload);
  const broker = new GraphBroker(workspaceRoot);
  const result = broker.applyProposalSync(proposal);
  if (!result.success) {
    throw new GraphBrokerError(
      result.code,
      result.error ?? "Failed to apply graph proposal",
      result.diagnostics,
      result.cyclePath,
    );
  }

  try {
    const missionId = resolveSessionMissionId(workspaceRoot, input);
    const eventsPath = ensureMissionStarted(workspaceRoot, missionId);
    for (const node of result.graph.nodes) {
      ensureWorkItemDiscovered(eventsPath, missionId, node, result.graph.edges);
    }
  } catch {}

  return {
    status: "applied",
    success: true,
    revision: result.revision,
    graphHash: result.graphHash,
    journalHeadHash: result.journalHeadHash,
    graph: result.graph,
  };
}

export function executeGraphReadyNodes(
  workspaceRoot: string,
): Record<string, unknown> {
  const runtime = loadGraphRuntime(workspaceRoot);
  const verification = verifyGraphStore(runtime);
  if (!verification.valid) {
    throw new Error(`Graph store verification failed: ${verification.errors.join("; ")}`);
  }
  const projection = projectGraph(runtime.graph, verification.events);
  const readyNodes = projection.nodes.filter((n: ProjectedNode) => n.state === "ready");
  return {
    status: "ready_nodes",
    graphId: runtime.graph.graphId,
    revision: runtime.graph.revision,
    readySet: projection.readySet,
    nodes: readyNodes,
    count: readyNodes.length,
  };
}

export function executeGraphMarkNode(
  workspaceRoot: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const nodeId = typeof input.nodeId === "string" ? input.nodeId.trim() : "";
  if (!nodeId) {
    throw new Error("nodeId is required");
  }
  const state = typeof input.state === "string" ? input.state.trim().toLowerCase() : "";
  if (!["running", "succeeded", "completed", "failed", "blocked"].includes(state)) {
    throw new Error(
      `Invalid state '${state}'. Must be one of: running, succeeded, completed, failed, blocked`,
    );
  }

  if (state === "blocked") {
    throw new Error(
      "Node state 'blocked' cannot be set directly; it is derived from unresolved upstream dependencies.",
    );
  }

  const runtime = loadGraphRuntime(workspaceRoot);
  const verification = verifyGraphStore(runtime);
  if (!verification.valid) {
    throw new Error(`Graph store verification failed: ${verification.errors.join("; ")}`);
  }

  const targetNode = runtime.graph.nodes.find((n: GraphNode) => n.id === nodeId);
  if (!targetNode) {
    throw new Error(`Node '${nodeId}' not found in execution graph '${runtime.graph.graphId}'`);
  }

  const projection = projectGraph(runtime.graph, verification.events);
  const projectedNode = projection.nodes.find((n: ProjectedNode) => n.id === nodeId);
  if (!projectedNode) {
    throw new Error(`Node projection missing for '${nodeId}'`);
  }

  const dispatchId =
    typeof input.dispatchId === "string" && input.dispatchId.trim().length > 0
      ? input.dispatchId.trim()
      : projectedNode.dispatchId ?? `dispatch-${nodeId}-${Date.now()}`;

  const missionId = resolveSessionMissionId(workspaceRoot, input);
  const eventsPath = ensureMissionStarted(workspaceRoot, missionId);
  ensureWorkItemDiscovered(eventsPath, missionId, targetNode, runtime.graph.edges);

  let lastEvent: GraphEvent;

  if (state === "running") {
    if (projectedNode.state === "running") {
      return {
        status: "node_marked",
        nodeId,
        state: "running",
        dispatchId: projectedNode.dispatchId,
        readySet: projection.readySet,
      };
    }
    // Marking a node running is where work actually starts. The interview gate is
    // enforced here rather than described in a skill, so an un-interviewed mission
    // cannot dispatch anything at all.
    assertInterviewAuthorisesExecution({ workspaceRoot, missionId });
    lastEvent = appendGraphTransition(runtime, {
      eventType: "node_dispatched",
      nodeId,
      dispatchId,
      authorityId: runtime.graph.schedulerAuthorityId,
    });
    try {
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "run_started",
        runId: dispatchId,
        workItemId: nodeId,
        expertId: targetNode.executor?.persona ?? targetNode.completionAuthority,
        model: "session-native",
        effort: "default",
      });
    } catch {}
  } else if (state === "succeeded" || state === "completed" || state === "failed") {
    const outcome = state === "failed" || input.outcome === "failure" ? "failure" : "success";

    if (outcome === "success") {
      // Checked BEFORE this transition writes its own `run_finished`, otherwise the record
      // it is about to create would satisfy its own precondition. A node may only be
      // completed if a dispatched run for it already finished successfully — and if the
      // node names an executor, that executor ran it.
      assertNodeCompletionIsAttributed({
        workspaceRoot,
        missionId,
        nodeId,
        expectedExpert: targetNode.executor?.persona,
      });
    }

    if (projectedNode.state === "ready") {
      appendGraphTransition(runtime, {
        eventType: "node_dispatched",
        nodeId,
        dispatchId,
        authorityId: runtime.graph.schedulerAuthorityId,
      });
    }

    const authority =
      typeof input.authority === "string" &&
      ["broker", "oracle", "scheduler", "human"].includes(input.authority)
        ? (input.authority as GraphAuthority)
        : targetNode.completionAuthority;
    const authorityId =
      typeof input.authorityId === "string" && input.authorityId.trim().length > 0
        ? input.authorityId.trim()
        : targetNode.completionAuthorityId;

    const evidenceHash =
      typeof input.evidenceHash === "string" && /^[a-f0-9]{64}$/u.test(input.evidenceHash.trim())
        ? input.evidenceHash.trim()
        : sha256(
            typeof input.evidence === "string"
              ? input.evidence
              : `evidence-${nodeId}-${outcome}-${Date.now()}`,
          );

    lastEvent = appendGraphTransition(runtime, {
      eventType: "node_completed",
      nodeId,
      dispatchId,
      outcome,
      authority,
      authorityId,
      evidenceHash,
    });
    try {
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "run_finished",
        runId: dispatchId,
        workItemId: nodeId,
        expertId: targetNode.executor?.persona ?? targetNode.completionAuthority,
        status: outcome === "success" ? "succeeded" : "failed",
        durationMs: typeof input.durationMs === "number" ? input.durationMs : 0,
      });
      if (outcome === "success") {
        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "integration_attempted",
          waveIndex: 1,
          workItemsIntegrated: [nodeId],
          status: "integrated",
        });
      }
    } catch {}
  } else {
    throw new Error(`Unsupported state: ${state}`);
  }

  const freshVerification = verifyGraphStore(runtime);
  const freshProjection = projectGraph(runtime.graph, freshVerification.events);
  const updatedNode = freshProjection.nodes.find((n: ProjectedNode) => n.id === nodeId);

  return {
    status: "node_marked",
    nodeId,
    state: updatedNode?.state ?? state,
    dispatchId,
    event: lastEvent,
    readySet: freshProjection.readySet,
  };
}

export function executeGraphInspect(
  workspaceRoot: string,
): Record<string, unknown> {
  const runtime = loadGraphRuntime(workspaceRoot);
  const verification = verifyGraphStore(runtime);
  const projection = projectGraph(runtime.graph, verification.events);

  const totalNodes = projection.nodes.length;
  const succeededNodes = projection.nodes.filter((n: ProjectedNode) => n.state === "succeeded").length;
  const failedNodes = projection.nodes.filter((n: ProjectedNode) => n.state === "failed").length;
  const runningNodes = projection.nodes.filter((n: ProjectedNode) => n.state === "running").length;
  const readyNodes = projection.readySet.length;
  const blockedNodes = projection.nodes.filter((n: ProjectedNode) => n.state === "blocked").length;
  const skippedNodes = projection.nodes.filter((n: ProjectedNode) => n.state === "skipped").length;
  // Progress is measured over DELIVERABLE nodes. Counting the engine seed made a
  // bare `graph_init` report 100% while the graph was in fact `stalled`, which is
  // the same false-comfort signal as the old `succeeded` verdict.
  const deliverableNodes = projection.nodes.filter((n: ProjectedNode) => !n.synthetic).length;
  const deliveredNodes = projection.nodes.filter(
    (n: ProjectedNode) => !n.synthetic && n.state === "succeeded",
  ).length;
  const progressPercentage =
    deliverableNodes > 0 ? (deliveredNodes / deliverableNodes) * 100 : 0;

  return {
    status: "inspected",
    valid: verification.valid,
    graphId: runtime.graph.graphId,
    revision: runtime.graph.revision,
    graphHash: runtime.graphHash,
    headHash: verification.headHash,
    graphStatus: projection.status,
    metrics: {
      totalNodes,
      deliverableNodes,
      deliveredNodes,
      succeededNodes,
      failedNodes,
      runningNodes,
      readyNodes,
      blockedNodes,
      skippedNodes,
      progressPercentage,
    },
    projection,
    verificationErrors: verification.errors,
  };
}

export function executeGraphTool(
  workspaceRoot: string,
  toolName: string,
  input: unknown,
): Record<string, unknown> {
  const args: Record<string, unknown> = isRecord(input) ? input : {};
  switch (toolName) {
    case "graph_init":
      return executeGraphInit(workspaceRoot, args);
    case "graph_propose":
      return executeGraphPropose(workspaceRoot, args);
    case "graph_apply":
      return executeGraphApply(workspaceRoot, args);
    case "graph_ready_nodes":
      return executeGraphReadyNodes(workspaceRoot);
    case "graph_mark_node":
      return executeGraphMarkNode(workspaceRoot, args);
    case "graph_inspect":
      return executeGraphInspect(workspaceRoot);
    default:
      throw new Error(`Unknown graph tool: ${toolName}`);
  }
}
