import { sha256 } from "../ledger/canonical.js";
import { GraphBroker, GraphBrokerError } from "./broker.js";
import { loadGraphRuntime } from "./store.js";
import type { GraphEdge, GraphNode } from "./model.js";
import type { GraphProposal } from "./proposal.js";

/**
 * Turn a wave's work items into graph nodes.
 *
 * The detached engine emitted `node_dispatched` and `node_completed` transitions for work
 * items it had never added to the graph. Both were wrapped in `try {} catch {}`, so the
 * transitions silently did nothing and the graph only ever held the synthetic seed. A graph
 * with no deliverable node cannot be `succeeded` — correctly — so a mission that reached green
 * progress still exhausted its budget (measured 2026-09-14).
 *
 * Materialization goes through the same `GraphBroker` proposal path as `graph_replan`, so the
 * engine's graph is subject to the same CAS, acyclicity and hash-chain checks as any other
 * writer. A rejected proposal throws: silently continuing is what caused the defect.
 */

export interface WorkItemNodeInput {
  id: string;
  title: string;
  scope?: string[];
  persona: string;
  /** Node ids this work item must wait behind. */
  dependsOn?: string[];
  /** How the dependency is satisfied. Repairs depend on a failure. */
  dependencyWhen?: "success" | "failure" | "always";
}

export interface MaterializeResult {
  added: string[];
  alreadyPresent: string[];
  revision: number;
}

export function materializeWorkItemNodes(options: {
  workspaceRoot: string;
  missionId: string;
  items: readonly WorkItemNodeInput[];
  author?: string;
}): MaterializeResult {
  const runtime = loadGraphRuntime(options.workspaceRoot);
  const existing = new Set(runtime.graph.nodes.map((node) => node.id));

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  const nodesToAdd: GraphNode[] = [];
  const edgesToAdd: GraphEdge[] = [];
  const edgeIds = new Set(runtime.graph.edges.map((edge) => edge.id));

  for (const item of options.items) {
    if (existing.has(item.id)) {
      alreadyPresent.push(item.id);
      continue;
    }
    existing.add(item.id);
    added.push(item.id);
    nodesToAdd.push({
      id: item.id,
      title: item.title,
      kind: "agent",
      activation: "all",
      completionAuthority: "broker",
      completionAuthorityId: "oma-dynamic-engine",
      executor: { adapter: "agy", persona: item.persona },
      ...(item.scope !== undefined && item.scope.length > 0 ? { scope: [...item.scope] } : {}),
    });

    for (const dependency of item.dependsOn ?? []) {
      // A dependency on a node that does not exist would be rejected by the broker; and a
      // repair whose failed node is unknown has nothing to attach to, so it stays a root.
      if (!existing.has(dependency)) continue;
      const edgeId = `edge-${dependency}-${item.id}`;
      if (edgeIds.has(edgeId)) continue;
      edgeIds.add(edgeId);
      edgesToAdd.push({
        id: edgeId,
        from: dependency,
        to: item.id,
        when: item.dependencyWhen ?? "success",
      });
    }
  }

  if (nodesToAdd.length === 0) {
    return { added, alreadyPresent, revision: runtime.graph.revision };
  }

  const proposal: GraphProposal = {
    schemaVersion: 2,
    proposalId: `prop_${sha256(`${options.missionId}:${added.join(",")}:${runtime.graph.revision}`).slice(0, 24)}`,
    expectedRevision: runtime.graph.revision,
    author: options.author ?? "oma-dynamic-engine",
    proposerPersona: "orchestrator",
    reason: `Materialize ${added.length} work item(s) as graph nodes for mission '${options.missionId}'.`,
    missionId: options.missionId,
    parentGraphHash: runtime.graphHash,
    operations: [
      ...nodesToAdd.map((node) => ({ type: "add_node" as const, node })),
      ...edgesToAdd.map((edge) => ({ type: "add_edge" as const, edge })),
    ],
  };

  const result = new GraphBroker(options.workspaceRoot).applyProposalSync(proposal);
  if (!result.success) {
    throw new GraphBrokerError(
      result.code,
      result.error ?? "Work-item materialization proposal rejected",
      result.diagnostics,
      result.cyclePath,
    );
  }

  return {
    added,
    alreadyPresent,
    revision: loadGraphRuntime(options.workspaceRoot).graph.revision,
  };
}
