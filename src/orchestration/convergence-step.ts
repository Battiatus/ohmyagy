import type { ExecutionGraph, GraphEvent } from "../graph/model.js";
import { projectGraph, type ProjectedNode } from "../graph/kernel.js";
import { ObjectiveJudge, type ProgressVector } from "../oracle/objective-judge.js";

export interface DynamicWorkflowLimits {
  maxRounds: number;
  maxTimeMs: number;
  maxConsecutiveNoProgressRounds: number;
}

export interface ConvergenceStepInput {
  graph: ExecutionGraph;
  events: GraphEvent[];
  progressHistory: ProgressVector[];
  limits: DynamicWorkflowLimits;
  currentProgress?: ProgressVector;
  currentRound?: number;
  startTimeMs?: number;
  currentTimeMs?: number;
  isIntegrated?: boolean;
}

export interface ConvergenceStepResult {
  readyNodes: ProjectedNode[];
  progress: ProgressVector;
  status: "in_progress" | "succeeded" | "failed" | "no_progress_blocked" | "budget_exhausted";
  diagnosis?: string;
  consecutiveNoProgressRounds: number;
  totalRounds: number;
}

/**
 * Compares two progress vectors by value.
 */
export function areProgressVectorsEqual(a: ProgressVector, b: ProgressVector): boolean {
  return (
    a.hiddenTestsFailing === b.hiddenTestsFailing &&
    a.hiddenTestsPassed === b.hiddenTestsPassed &&
    a.visibleTestsFailing === b.visibleTestsFailing &&
    a.visibleTestsPassed === b.visibleTestsPassed &&
    a.gateFailures === b.gateFailures &&
    a.openDiagnosticsCount === b.openDiagnosticsCount &&
    a.acceptedWorkItems === b.acceptedWorkItems &&
    a.totalWorkItems === b.totalWorkItems
  );
}

/**
 * Pure evaluation of a single convergence step in Oh My Antigravity (OMA).
 *
 * Reconciles the Graph Engineering DAG state (ready/succeeded/failed nodes)
 * with the Dynamic Workflow progress vector (ObjectiveJudge lexicographic ordering,
 * stagnation detection, and budget enforcement).
 */
export function evaluateConvergenceStep(input: ConvergenceStepInput): ConvergenceStepResult {
  const { graph, events, limits } = input;

  // 1. Project Execution Graph state
  const projection = projectGraph(graph, events);
  const readyNodes = projection.nodes.filter((node) => node.state === "ready");
  const succeededNodes = projection.nodes.filter((node) => node.state === "succeeded");
  const failedNodes = projection.nodes.filter((node) => node.state === "failed");

  // 2. Resolve current progress vector
  let currentProgress: ProgressVector;
  if (input.currentProgress) {
    currentProgress = input.currentProgress;
  } else if (input.progressHistory.length > 0) {
    currentProgress = input.progressHistory[input.progressHistory.length - 1];
  } else {
    currentProgress = {
      hiddenTestsFailing: 0,
      hiddenTestsPassed: 0,
      visibleTestsFailing: 0,
      visibleTestsPassed: 0,
      gateFailures: failedNodes.length,
      openDiagnosticsCount: failedNodes.length,
      acceptedWorkItems: succeededNodes.length,
      totalWorkItems: graph.nodes.length,
    };
  }

  // 3. Assemble complete progress vector history for stagnation tracking
  let fullHistory: ProgressVector[];
  if (input.progressHistory.length === 0) {
    fullHistory = [currentProgress];
  } else if (input.currentRound !== undefined) {
    // If currentRound is specified, check whether progressHistory already includes it
    if (input.progressHistory.length < input.currentRound && input.currentProgress) {
      fullHistory = [...input.progressHistory, input.currentProgress];
    } else {
      fullHistory = [...input.progressHistory];
    }
  } else if (
    input.currentProgress &&
    input.currentProgress !== input.progressHistory[input.progressHistory.length - 1] &&
    !areProgressVectorsEqual(
      input.currentProgress,
      input.progressHistory[input.progressHistory.length - 1],
    )
  ) {
    fullHistory = [...input.progressHistory, input.currentProgress];
  } else {
    fullHistory = [...input.progressHistory];
  }

  // 4. Calculate consecutive non-improving rounds lexicographically
  let consecutiveNoProgress = 0;
  for (let idx = 1; idx < fullHistory.length; idx++) {
    const previous = fullHistory[idx - 1];
    const current = fullHistory[idx];
    if (ObjectiveJudge.isProgressing(previous, current)) {
      consecutiveNoProgress = 0;
    } else {
      consecutiveNoProgress++;
    }
  }

  const totalRounds = input.currentRound ?? fullHistory.length;

  // 5. Evaluate Convergence Status Hierarchy

  // Priority A: Success / Full Convergence
  const isAllNodesSucceeded =
    projection.nodes.length > 0 &&
    projection.status === "succeeded" &&
    currentProgress.hiddenTestsFailing === 0 &&
    currentProgress.visibleTestsFailing === 0 &&
    currentProgress.gateFailures === 0;

  if (input.isIntegrated === true || (input.isIntegrated !== false && isAllNodesSucceeded)) {
    return {
      readyNodes,
      progress: currentProgress,
      status: "succeeded",
      diagnosis: "Objectives converged and integrated successfully.",
      consecutiveNoProgressRounds: consecutiveNoProgress,
      totalRounds,
    };
  }

  // Priority B: Stagnation (2-round consecutive no progress)
  if (consecutiveNoProgress >= limits.maxConsecutiveNoProgressRounds) {
    return {
      readyNodes,
      progress: currentProgress,
      status: "no_progress_blocked",
      diagnosis: `Stagnation detected: ${consecutiveNoProgress} consecutive rounds without measurable progress.`,
      consecutiveNoProgressRounds: consecutiveNoProgress,
      totalRounds,
    };
  }

  // Priority C: Budget Exhaustion (rounds or time)
  if (input.currentRound !== undefined && input.currentRound >= limits.maxRounds) {
    return {
      readyNodes,
      progress: currentProgress,
      status: "budget_exhausted",
      diagnosis: `Round budget exhausted: round ${input.currentRound} reached maxRounds limit of ${limits.maxRounds}.`,
      consecutiveNoProgressRounds: consecutiveNoProgress,
      totalRounds,
    };
  }

  if (fullHistory.length >= limits.maxRounds && !input.isIntegrated) {
    return {
      readyNodes,
      progress: currentProgress,
      status: "budget_exhausted",
      diagnosis: `Round budget exhausted: ${fullHistory.length} rounds reached maxRounds limit of ${limits.maxRounds}.`,
      consecutiveNoProgressRounds: consecutiveNoProgress,
      totalRounds,
    };
  }

  if (
    input.startTimeMs !== undefined &&
    (input.currentTimeMs ?? Date.now()) - input.startTimeMs > limits.maxTimeMs
  ) {
    return {
      readyNodes,
      progress: currentProgress,
      status: "budget_exhausted",
      diagnosis: `Time budget exhausted: elapsed time exceeded ${limits.maxTimeMs}ms limit.`,
      consecutiveNoProgressRounds: consecutiveNoProgress,
      totalRounds,
    };
  }

  // Priority D: Terminal Failure (failures detected with no ready or running nodes)
  const hasNoActiveWork =
    readyNodes.length === 0 && !projection.nodes.some((n) => n.state === "running");
  const isTerminalFailure =
    (projection.status === "failed" || projection.status === "stalled" || hasNoActiveWork) &&
    failedNodes.length > 0 &&
    readyNodes.length === 0;

  if (isTerminalFailure) {
    return {
      readyNodes,
      progress: currentProgress,
      status: "failed",
      diagnosis: "Graph execution failed: terminal failures detected without active repair path.",
      consecutiveNoProgressRounds: consecutiveNoProgress,
      totalRounds,
    };
  }

  // Priority E: In Progress (ready nodes or active rounds remaining)
  return {
    readyNodes,
    progress: currentProgress,
    status: "in_progress",
    diagnosis:
      readyNodes.length > 0
        ? `${readyNodes.length} node(s) ready for execution.`
        : "In progress: awaiting next wave or node transitions.",
    consecutiveNoProgressRounds: consecutiveNoProgress,
    totalRounds,
  };
}
