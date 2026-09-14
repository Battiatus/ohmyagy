import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MissionEventsStore } from "../../../ledger/mission-events.js";
import { ensureMissionStarted, eventsPathFor } from "../../read-model.js";

/**
 * Record the run a node's completion must be attributed to.
 *
 * `graph_mark_node(succeeded)` now refuses a node with no finished run behind it, so a test
 * that completes a node has to say what did the work. Two ways exist: `dispatch_node`, which
 * proves the whole chain for the tests that are about dispatch, and this, for the tests whose
 * subject is something else (the success contract, the projection, observability) and which
 * merely need a node to have been worked on.
 */

export interface RecordRunOptions {
  workspaceRoot: string;
  /** Defaults to the mission owning the workspace graph. */
  missionId?: string;
  nodeId: string;
  expertId: string;
  status?: "succeeded" | "failed";
  durationMs?: number;
}

/** The mission the workspace graph belongs to, as the tools resolve it. */
export function sessionMissionId(workspaceRoot: string): string {
  try {
    const pointer = readFileSync(join(workspaceRoot, ".oma", "graph", "session-mission-id"), "utf8").trim();
    if (pointer.length > 0) return pointer;
  } catch {
    // Fall through to the caller's expectation.
  }
  return "oma-session";
}

export function recordRun(options: RecordRunOptions): string {
  const missionId = options.missionId ?? sessionMissionId(options.workspaceRoot);
  const eventsPath = ensureMissionStarted(options.workspaceRoot, missionId);
  const runId = `test-run-${options.nodeId}-${options.status ?? "succeeded"}-${Date.now()}`;
  MissionEventsStore.appendEvent(eventsPath, missionId, {
    type: "run_started",
    runId,
    workItemId: options.nodeId,
    expertId: options.expertId,
    model: "test-model",
    effort: "medium",
  });
  MissionEventsStore.appendEvent(eventsPath, missionId, {
    type: "run_finished",
    runId,
    workItemId: options.nodeId,
    expertId: options.expertId,
    status: options.status ?? "succeeded",
    durationMs: options.durationMs ?? 1,
  });
  return runId;
}

/** Shorthand for the common case: a successful run by the node's own expert. */
export function recordSuccessfulRun(
  workspaceRoot: string,
  nodeId: string,
  expertId: string,
  missionId?: string,
): string {
  return recordRun({ workspaceRoot, nodeId, expertId, missionId });
}

/** Where a mission's events live, for tests that assert on the journal. */
export function missionEventsPath(workspaceRoot: string, missionId?: string): string {
  return eventsPathFor(workspaceRoot, missionId ?? sessionMissionId(workspaceRoot));
}
