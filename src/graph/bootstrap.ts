import { parseExecutionGraph } from "./model.js";
import type { ExecutionGraph, GraphEdge, GraphNode } from "./model.js";

/**
 * The canonical revision-1 execution graph.
 *
 * Two orchestrators build this file — `graph_init` for the session-native path and
 * `DynamicConvergenceEngine` for the detached one — and they disagreed. The engine
 * hand-wrote `{schemaVersion, graphId, revision, nodes: [], edges: []}`, which
 * `parseExecutionGraph` rejects twice over: `schedulerAuthorityId` is required, and a graph
 * with no node is refused. The parse error was swallowed by a `catch {}`, so the engine ran
 * with an empty fallback graph, and a mission that reached green progress could never be
 * declared successful — it exhausted its budget instead (measured 2026-09-14: final progress
 * 0 failing tests, gate failures 0, 1/1 work items accepted, status `budget_exhausted`).
 *
 * One builder, so the shape cannot drift again.
 */

export interface InitialGraphOptions {
  graphId: string;
  schedulerAuthorityId?: string;
  /** Title for the synthetic seed node when no custom nodes are supplied. */
  title?: string;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
}

/** The id of the engine-seeded node that gives revision 1 a parent for the first proposal. */
export const BOOTSTRAP_NODE_ID = "bootstrap";

export function buildInitialExecutionGraph(options: InitialGraphOptions): ExecutionGraph {
  const schedulerAuthorityId = options.schedulerAuthorityId ?? "oma-scheduler";

  if (options.nodes !== undefined && options.nodes.length > 0) {
    return parseExecutionGraph({
      schemaVersion: 2,
      graphId: options.graphId,
      revision: 1,
      schedulerAuthorityId,
      nodes: options.nodes,
      edges: options.edges ?? [],
    });
  }

  const rootNode: GraphNode = {
    id: BOOTSTRAP_NODE_ID,
    title: options.title ?? "OMA bootstrap",
    kind: "join",
    activation: "all",
    completionAuthority: "scheduler",
    completionAuthorityId: schedulerAuthorityId,
    // Engine-seeded, not requested work. It exists only so revision 1 has a parent for the
    // first proposal; marking it synthetic keeps a bare `graph_init` from reporting the
    // mission as succeeded.
    synthetic: true,
  };

  return {
    schemaVersion: 2,
    graphId: options.graphId,
    revision: 1,
    schedulerAuthorityId,
    nodes: [rootNode],
    edges: [],
  };
}
