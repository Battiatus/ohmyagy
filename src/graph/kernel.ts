import type {
  ExecutionGraph,
  GraphEdge,
  GraphEvent,
  GraphOutcome,
} from "./model.js";
import { topologicalNodeIds } from "./model.js";

export type NodeState = "blocked" | "ready" | "running" | "succeeded" | "failed" | "skipped";
export type EdgeState = "pending" | "active" | "inactive";

export interface ProjectedNode {
  id: string;
  title: string;
  kind: ExecutionGraph["nodes"][number]["kind"];
  state: NodeState;
  /** Seeded by the engine; completing it is not delivered work. */
  synthetic: boolean;
  dispatchId?: string;
  evidenceHash?: string;
}

export interface GraphProjection {
  graphId: string;
  revision: number;
  status: "ready" | "running" | "succeeded" | "failed" | "stalled";
  nodes: ProjectedNode[];
  edges: Array<{ id: string; state: EdgeState }>;
  readySet: string[];
}

export function projectGraph(graph: ExecutionGraph, events: GraphEvent[]): GraphProjection {
  const eventState = new Map<
    string,
    { outcome?: NodeState; dispatchId: string; evidenceHash?: string }
  >();
  for (const event of events) {
    const projection = deriveProjection(graph, eventState);
    assertEventAgainstProjection(graph, projection, event);
    if (event.eventType === "node_dispatched") {
      eventState.set(event.nodeId, { dispatchId: event.dispatchId });
    } else {
      eventState.set(event.nodeId, {
        dispatchId: event.dispatchId,
        outcome: event.outcome === "success" ? "succeeded" : "failed",
        evidenceHash: event.evidenceHash,
      });
    }
  }
  return deriveProjection(graph, eventState);
}

function deriveProjection(
  graph: ExecutionGraph,
  eventState: Map<string, { outcome?: NodeState; dispatchId: string; evidenceHash?: string }>,
): GraphProjection {
  const nodeStates = new Map<string, NodeState>();
  const edgeStates = new Map<string, EdgeState>();
  for (const nodeId of topologicalNodeIds(graph)) {
    const explicit = eventState.get(nodeId);
    if (explicit) {
      nodeStates.set(nodeId, explicit.outcome ?? "running");
      continue;
    }
    const incoming = graph.edges.filter((edge) => edge.to === nodeId);
    if (incoming.length === 0) {
      nodeStates.set(nodeId, "ready");
      continue;
    }
    const states = incoming.map((edge) => {
      const state = deriveEdgeState(edge, nodeStates.get(edge.from));
      edgeStates.set(edge.id, state);
      return state;
    });
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`Missing node ${nodeId}`);
    if (node.activation === "all") {
      nodeStates.set(
        nodeId,
        states.some((state) => state === "inactive")
          ? "skipped"
          : states.every((state) => state === "active")
            ? "ready"
            : "blocked",
      );
    } else {
      nodeStates.set(
        nodeId,
        states.some((state) => state === "active")
          ? "ready"
          : states.every((state) => state === "inactive")
            ? "skipped"
            : "blocked",
      );
    }
  }
  for (const edge of graph.edges) {
    if (!edgeStates.has(edge.id)) {
      edgeStates.set(edge.id, deriveEdgeState(edge, nodeStates.get(edge.from)));
    }
  }
  const nodes = [...graph.nodes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node): ProjectedNode => {
      const explicit = eventState.get(node.id);
      return {
        id: node.id,
        title: node.title,
        kind: node.kind,
        state: nodeStates.get(node.id) ?? "blocked",
        synthetic: node.synthetic === true,
        ...(explicit?.dispatchId ? { dispatchId: explicit.dispatchId } : {}),
        ...(explicit?.evidenceHash ? { evidenceHash: explicit.evidenceHash } : {}),
      };
    });
  const readySet = nodes.filter((node) => node.state === "ready").map((node) => node.id);
  return {
    graphId: graph.graphId,
    revision: graph.revision,
    status: deriveGraphStatus(graph, nodes, readySet),
    nodes,
    edges: [...graph.edges]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((edge) => ({ id: edge.id, state: edgeStates.get(edge.id) ?? "pending" })),
    readySet,
  };
}

export function assertTransitionAllowed(
  graph: ExecutionGraph,
  events: GraphEvent[],
  event: GraphEvent,
): void {
  const projection = projectGraph(graph, events);
  assertEventAgainstProjection(graph, projection, event);
}

function assertEventAgainstProjection(
  graph: ExecutionGraph,
  projection: GraphProjection,
  event: GraphEvent,
): void {
  const node = graph.nodes.find((candidate) => candidate.id === event.nodeId);
  if (!node) throw new Error(`Unknown graph node: ${event.nodeId}`);
  const projected = projection.nodes.find((candidate) => candidate.id === event.nodeId);
  if (!projected) throw new Error(`Node projection missing: ${event.nodeId}`);
  if (event.eventType === "node_dispatched") {
    if (event.authority !== "scheduler") throw new Error("Only the scheduler may dispatch nodes");
    if (event.authorityId !== graph.schedulerAuthorityId) {
      throw new Error(`Dispatch requires scheduler identity ${graph.schedulerAuthorityId}`);
    }
    if (projected.state !== "ready") {
      throw new Error(`Node ${event.nodeId} is ${projected.state}, not ready`);
    }
    return;
  }
  if (projected.state !== "running" || projected.dispatchId !== event.dispatchId) {
    throw new Error(`Node ${event.nodeId} is not running under dispatch ${event.dispatchId}`);
  }
  if (event.authority !== node.completionAuthority) {
    throw new Error(
      `Node ${event.nodeId} requires ${node.completionAuthority} completion authority`,
    );
  }
  if (event.authorityId !== node.completionAuthorityId) {
    throw new Error(
      `Node ${event.nodeId} requires authority identity ${node.completionAuthorityId}`,
    );
  }
}

function deriveEdgeState(edge: GraphEdge, sourceState: NodeState | undefined): EdgeState {
  const outcome = terminalOutcome(sourceState);
  if (!outcome) return sourceState === "skipped" ? "inactive" : "pending";
  return edge.when === "always" || edge.when === outcome ? "active" : "inactive";
}

function terminalOutcome(state: NodeState | undefined): GraphOutcome | undefined {
  if (state === "succeeded") return "success";
  if (state === "failed") return "failure";
  return undefined;
}

function deriveGraphStatus(
  graph: ExecutionGraph,
  nodes: ProjectedNode[],
  readySet: string[],
): GraphProjection["status"] {
  if (nodes.some((node) => node.state === "running")) return "running";
  if (readySet.length > 0) return "ready";
  // A graph with no node has declared no work at all; it is not a success.
  if (nodes.length === 0) return "stalled";
  const terminal = nodes.every((node) =>
    ["succeeded", "failed", "skipped"].includes(node.state),
  );
  if (!terminal) return "stalled";
  const outgoingSources = new Set(graph.edges.map((edge) => edge.from));
  const sinks = nodes.filter((node) => !outgoingSources.has(node.id));
  if (sinks.some((node) => node.state === "failed")) return "failed";
  // Succeeding requires delivered work. A terminal graph whose only completed
  // nodes are engine-seeded (the `bootstrap` seed) has proven nothing: before
  // this guard, `graph_init` alone reported `succeeded` with one synthetic node
  // and 100% progress, so a conductor could declare victory with zero artifacts.
  const deliveredWork = nodes.some((node) => !node.synthetic && node.state === "succeeded");
  if (!deliveredWork) return "stalled";
  return "succeeded";
}
