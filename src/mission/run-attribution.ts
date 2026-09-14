import { MissionEventsStore } from "../ledger/mission-events.js";
import { eventsPathFor } from "./read-model.js";

/**
 * Attribution of a node's completion to a run that actually happened.
 *
 * `graph_mark_node(succeeded)` used to write its own `run_finished`, attributed to
 * `node.executor?.persona ?? node.completionAuthority` — an expert the caller had merely
 * named. So a conductor could complete any node without dispatching anything, and the
 * mission journal would record that an explorer, a reviewer or a verifier had done the work.
 * The whole point of dispatching a node to its expert is lost if the completion does not
 * have to correspond to a run.
 *
 * The rule below is what `dispatch_node` satisfies and nothing else does: a run must have
 * been started for this work item, finished successfully, and — when the node names an
 * executor — been run by that expert. A failure may still be reported without one, because
 * refusing to record a failure until you dispatch something would be perverse.
 */

export interface AttributedRun {
  runId: string;
  expertId: string;
  status: string;
  durationMs: number;
}

export interface RunAttributionOptions {
  workspaceRoot: string;
  missionId: string;
  nodeId: string;
}

/** Started-then-finished runs for one work item, in journal order. */
export function readAttributedRuns(options: RunAttributionOptions): AttributedRun[] {
  let events: ReturnType<typeof MissionEventsStore.readEvents>;
  try {
    events = MissionEventsStore.readEvents(eventsPathFor(options.workspaceRoot, options.missionId));
  } catch {
    return [];
  }

  const started = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "run_started") continue;
    const record = event as unknown as Record<string, unknown>;
    if (record.workItemId !== options.nodeId) continue;
    if (typeof record.runId !== "string") continue;
    started.set(record.runId, typeof record.expertId === "string" ? record.expertId : "");
  }

  const runs: AttributedRun[] = [];
  for (const event of events) {
    if (event.type !== "run_finished") continue;
    const record = event as unknown as Record<string, unknown>;
    if (record.workItemId !== options.nodeId) continue;
    if (typeof record.runId !== "string" || !started.has(record.runId)) continue;
    runs.push({
      runId: record.runId,
      expertId:
        typeof record.expertId === "string" && record.expertId.length > 0
          ? record.expertId
          : started.get(record.runId) ?? "",
      status: typeof record.status === "string" ? record.status : "unknown",
      durationMs: typeof record.durationMs === "number" ? record.durationMs : 0,
    });
  }
  return runs;
}

/**
 * Throws unless a started run for this work item finished successfully, and the node's
 * declared executor ran it.
 */
export function assertNodeCompletionIsAttributed(
  options: RunAttributionOptions & { expectedExpert?: string },
): AttributedRun {
  const runs = readAttributedRuns(options);
  const succeeded = runs.filter((run) => run.status === "succeeded");

  if (runs.length === 0) {
    throw new Error(
      `Node '${options.nodeId}' cannot be completed: no run was ever started for it in mission '${options.missionId}'. Dispatch the node to its expert with 'dispatch_node' first, so the completion is attributed to the expert that really ran.`,
    );
  }
  if (succeeded.length === 0) {
    throw new Error(
      `Node '${options.nodeId}' cannot be completed: its ${runs.length} run(s) never finished successfully (${runs.map((run) => `${run.runId}=${run.status}`).join(", ")}).`,
    );
  }
  if (options.expectedExpert !== undefined && options.expectedExpert.length > 0) {
    const matching = succeeded.find((run) => run.expertId === options.expectedExpert);
    if (matching === undefined) {
      throw new Error(
        `Node '${options.nodeId}' is assigned to expert '${options.expectedExpert}', but the successful run(s) were performed by ${[...new Set(succeeded.map((run) => `'${run.expertId}'`))].join(", ")}. A completion must be attributed to the node's own expert.`,
      );
    }
    return matching;
  }
  return succeeded[succeeded.length - 1];
}
