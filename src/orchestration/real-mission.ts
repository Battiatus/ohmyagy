import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { discardStagedTransaction } from "../broker/staging.js";
import { StagedReviewBroker } from "../broker/staged-review.js";
import type { ChangeProposal, ProposedOperation } from "../broker/transaction.js";
import { GraphBroker } from "../graph/broker.js";
import { projectGraph } from "../graph/kernel.js";
import type { GraphEdge, GraphNode } from "../graph/model.js";
import {
  appendGraphTransition,
  graphPaths,
  initializeGraphStore,
  loadGraphRuntime,
  verifyGraphStore,
} from "../graph/store.js";
import { canonicalJson, sha256 } from "../ledger/canonical.js";
import { MissionEventsStore, type ProgressVector } from "../ledger/mission-events.js";
import { MissionJournal } from "../ledger/mission-journal.js";
import { evaluateStagedTransaction, type OracleGate } from "../oracle/executor.js";
import { attestReviewFromManifest } from "../oracle/review.js";
import type { ArtifactRef, ReviewerVerdict, RunAuthority } from "./model.js";
import { WorktreePool, type IWorktreePool } from "./worktree-pool.js";
import { AgyDriver, type DriverExecutionResult, type IAgyDriver } from "../runtime/agy-driver.js";
import { MissionLogger, type RunLogger } from "../logging/mission-logger.js";

export interface RealMissionOptions {
  workspaceRoot: string;
  missionId: string;
  goal: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  timeoutMs?: number;
  maxConcurrency?: number;
  maxWaves?: number;
  gates?: OracleGate[];
  driver?: IAgyDriver;
  worktreePool?: IWorktreePool;
  allowDirty?: boolean;
  verbose?: boolean;
}

export interface RealMissionReport {
  missionId: string;
  status: "succeeded" | "failed" | "budget_exhausted";
  totalWaves: number;
  graphRevision: number;
  commitShas: string[];
  diagnostics: string[];
  finalProgress: ProgressVector;
  totalDurationMs: number;
}

interface PlannedWorkItem {
  id: string;
  title: string;
  scope: string[];
  dependsOn: string[];
  persona: "executor" | "worker" | "fixer";
  acceptance: string[];
}

interface WorktreeChange {
  node: GraphNode;
  runId: string;
  worktreePath: string;
  result: DriverExecutionResult;
  diff: string;
  operations: ProposedOperation[];
}

interface BatchFailure {
  node: GraphNode;
  runId: string;
  reason: string;
}

interface BatchPromotion {
  commitSha: string;
  diffDigest: string;
  observations: string[];
}

const bootstrapNodeId = "oma-bootstrap";
const schedulerAuthorityId = "oma-scheduler";
const brokerAuthorityId = "oma-broker";

export class RealMissionExecutor {
  public static async execute(options: RealMissionOptions): Promise<RealMissionReport> {
    const startedAt = Date.now();
    const workspaceRoot = resolve(options.workspaceRoot);
    const missionId = normalizeMissionId(options.missionId);
    const missionDir = join(workspaceRoot, ".oma", "missions", missionId);
    const eventsPath = join(missionDir, "events.jsonl");
    const graphRoot = join(missionDir, "graph-runtime");
    const diagnostics: string[] = [];
    const logger = new MissionLogger(missionDir, { verbose: options.verbose });
    logger.log("Mission", `Starting mission '${missionId}' - Goal: "${options.goal}"`);

    if (existsSync(eventsPath)) {
      throw new Error(`Mission '${missionId}' already exists. Use oma resume for an interrupted mission.`);
    }

    if (!options.allowDirty) {
      ensureCleanWorkspace(workspaceRoot);
    }
    ensureRuntime(options.driver);
    mkdirSync(join(missionDir, "artifacts"), { recursive: true });

    const driver = options.driver ?? new AgyDriver();
    const worktreePool = options.worktreePool ?? new WorktreePool({ workspaceRoot });
    const gates = resolveGates(options.gates);
    const journal = new MissionJournal(missionId, "code-change", join(missionDir, "broker-journal.jsonl"));

    MissionEventsStore.appendEvent(eventsPath, missionId, {
      type: "mission_started",
      workflowDigest: "real-graph-workflow-v1",
      rulebookRevision: "real-path-v1",
      goal: options.goal,
      totalBudgets: {
        maxRounds: options.maxWaves ?? 3,
        maxTimeMs: options.timeoutMs ?? 300_000,
      },
    });

    initializeMissionGraph(graphRoot, missionId, gates);

    const plannerRunId = `run-planner-${missionId}`;
    MissionEventsStore.appendEvent(eventsPath, missionId, {
      type: "run_started",
      runId: plannerRunId,
      workItemId: "planner",
      expertId: "planner",
      model: options.model ?? "default",
      effort: options.effort ?? "agy-default",
      worktreePath: workspaceRoot,
    });

    const plannerPromptText = plannerPrompt(options.goal);
    logger.log("Planner", `Invoking planner with model '${options.model ?? "default"}'...`);
    const plannerRunLogger = logger.createRunLogger({
      runId: plannerRunId,
      expertId: "planner",
      persona: "planner",
      model: options.model,
      effort: options.effort,
      worktree: workspaceRoot,
      prompt: plannerPromptText,
    }, { streamConsole: options.verbose });

    const plannerResult = await driver.invoke({
      contractPrompt: plannerPromptText,
      persona: "planner",
      worktreeDir: workspaceRoot,
      timeoutMs: options.timeoutMs ?? 300_000,
      modelOverride: options.model,
      reasoningEffort: options.effort,
      executionMode: "plan",
      runId: plannerRunId,
      verbose: options.verbose,
      onStdoutChunk: (chunk) => plannerRunLogger.handleStdoutChunk(chunk),
      onStderrChunk: (chunk) => plannerRunLogger.handleStderrChunk(chunk),
    });

    plannerRunLogger.finalize({
      exitCode: plannerResult.exitCode,
      status: plannerResult.status,
      durationMs: plannerResult.durationMs,
      parsedOutput: plannerResult.parsedOutput,
      error: plannerResult.error,
    });

    const plannerArtifact = persistArtifact(missionDir, "planner-receipt.json", JSON.stringify(receiptPayload(plannerResult), null, 2));
    MissionEventsStore.appendEvent(eventsPath, missionId, {
      type: "artifact_created",
      runId: plannerRunId,
      workItemId: "planner",
      artifactPath: plannerArtifact.path,
      artifactHash: plannerArtifact.hash,
      artifactKind: "report",
    });

    if (plannerResult.status !== "success") {
      logger.log("Planner", `Planner execution failed: ${plannerResult.error ?? "No valid plan output"}`, "ERROR");
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "run_finished",
        runId: plannerRunId,
        workItemId: "planner",
        expertId: "planner",
        status: driverStatusToMissionStatus(plannerResult),
        durationMs: plannerResult.durationMs,
        stdoutHash: plannerResult.stdoutHash,
        error: plannerResult.error,
      });
      return finishMission(eventsPath, missionId, startedAt, "failed", 0, [], [plannerResult.error ?? "Planner failed"], zeroProgress(0, 0, 1), logger);
    }

    let plan: PlannedWorkItem[];
    try {
      plan = parsePlannerPlan(plannerResult.parsedOutput);
    } catch (error) {
      const message = messageOf(error);
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "run_finished",
        runId: plannerRunId,
        workItemId: "planner",
        expertId: "planner",
        status: "failed",
        durationMs: plannerResult.durationMs,
        stdoutHash: plannerResult.stdoutHash,
        error: message,
      });
      return finishMission(eventsPath, missionId, startedAt, "failed", 0, [], [message], zeroProgress(0, 0, 1));
    }

    MissionEventsStore.appendEvent(eventsPath, missionId, {
      type: "run_finished",
      runId: plannerRunId,
      workItemId: "planner",
      expertId: "planner",
      status: "succeeded",
      durationMs: plannerResult.durationMs,
      stdoutHash: plannerResult.stdoutHash,
    });

    const planArtifact = persistArtifact(missionDir, "planner-plan.json", JSON.stringify({ workItems: plan }, null, 2));
    MissionEventsStore.appendEvent(eventsPath, missionId, {
      type: "artifact_created",
      runId: plannerRunId,
      workItemId: "planner",
      artifactPath: planArtifact.path,
      artifactHash: planArtifact.hash,
      artifactKind: "manifest",
    });

    try {
      await publishPlan(graphRoot, missionId, plan, gates[0]!.id);
    } catch (error) {
      return finishMission(eventsPath, missionId, startedAt, "failed", 0, [], [messageOf(error)], zeroProgress(0, 0, 1));
    }

    for (const item of plan) {
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "work_item_discovered",
        workItemId: item.id,
        title: item.title,
        scope: item.scope,
        dependsOn: item.dependsOn,
        roleRequired: item.persona,
        acceptanceCriteria: item.acceptance,
      });
    }

    return runGraphMission({
      workspaceRoot,
      missionId,
      missionDir,
      graphRoot,
      eventsPath,
      goal: options.goal,
      driver,
      worktreePool,
      journal,
      gates,
      model: options.model,
      effort: options.effort,
      timeoutMs: options.timeoutMs ?? 300_000,
      maxConcurrency: options.maxConcurrency ?? 3,
      maxWaves: options.maxWaves ?? 3,
      startedAt,
      diagnostics,
      initialWave: 1,
      logger,
      verbose: options.verbose,
    });
  }

  public static async resume(options: Omit<RealMissionOptions, "goal"> & { goal?: string }): Promise<RealMissionReport> {
    const startedAt = Date.now();
    const workspaceRoot = resolve(options.workspaceRoot);
    const missionId = normalizeMissionId(options.missionId);
    const missionDir = join(workspaceRoot, ".oma", "missions", missionId);
    const eventsPath = join(missionDir, "events.jsonl");
    const graphRoot = join(missionDir, "graph-runtime");
    const diagnostics: string[] = [];

    if (!existsSync(eventsPath) || !existsSync(graphPaths(graphRoot).definition)) {
      throw new Error(`Mission '${missionId}' has no durable graph and journal to resume.`);
    }

    const missionEvents = MissionEventsStore.readEvents(eventsPath);
    const chain = MissionEventsStore.verifyEventChain(missionEvents);
    if (!chain.valid) {
      throw new Error(`Mission event chain is invalid: ${chain.error}`);
    }

    const existingTerminal = missionEvents.find((event) => event.type === "mission_finished");
    if (existingTerminal?.type === "mission_finished") {
      return {
        missionId,
        status: existingTerminal.finalStatus === "succeeded" ? "succeeded" : "failed",
        totalWaves: 0,
        graphRevision: loadGraphRuntime(graphRoot).graph.revision,
        commitShas: existingTerminal.integratedCommitSha ? [existingTerminal.integratedCommitSha] : [],
        diagnostics: [],
        finalProgress: existingTerminal.finalProgress,
        totalDurationMs: 0,
      };
    }

    ensureCleanWorkspace(workspaceRoot);
    ensureRuntime(options.driver);
    const driver = options.driver ?? new AgyDriver();
    const worktreePool = options.worktreePool ?? new WorktreePool({ workspaceRoot });
    const gates = resolveGates(options.gates);
    const journal = new MissionJournal(missionId, "code-change", join(missionDir, "broker-journal.jsonl"));
    const runtime = loadGraphRuntime(graphRoot);
    const verification = verifyGraphStore(runtime);
    if (!verification.valid) {
      throw new Error(`Mission graph is invalid: ${verification.errors.join("; ")}`);
    }

    const projection = projectGraph(runtime.graph, verification.events);
    const interrupted: BatchFailure[] = [];
    for (const node of projection.nodes.filter((candidate) => candidate.state === "running")) {
      const graphNode = runtime.graph.nodes.find((candidate) => candidate.id === node.id);
      if (!graphNode || !node.dispatchId) continue;
      appendGraphTransition(runtime, {
        eventType: "node_completed",
        nodeId: node.id,
        dispatchId: node.dispatchId,
        authority: "broker",
        authorityId: brokerAuthorityId,
        outcome: "failure",
        evidenceHash: sha256(`interrupted:${missionId}:${node.id}:${node.dispatchId}`),
      });
      interrupted.push({
        node: graphNode,
        runId: `interrupted-${node.id}`,
        reason: "The previous process stopped before the node completed.",
      });
    }

    let initialWave = 1;
    if (interrupted.length > 0) {
      initialWave = 2;
      await publishRepairNodes({ graphRoot, missionId, eventsPath }, interrupted, initialWave);
    }

    const missionStarted = missionEvents.find((event) => event.type === "mission_started");
    const goal = options.goal ?? (missionStarted?.type === "mission_started" ? missionStarted.goal : "Resume mission");
    const logger = new MissionLogger(missionDir, { verbose: options.verbose });
    logger.log("Mission", `Resuming mission '${missionId}' from wave ${initialWave}`);

    return runGraphMission({
      workspaceRoot,
      missionId,
      missionDir,
      graphRoot,
      eventsPath,
      goal,
      driver,
      worktreePool,
      journal,
      gates,
      model: options.model,
      effort: options.effort,
      timeoutMs: options.timeoutMs ?? 300_000,
      maxConcurrency: options.maxConcurrency ?? 3,
      maxWaves: options.maxWaves ?? 3,
      startedAt,
      diagnostics,
      initialWave,
      logger,
      verbose: options.verbose,
    });
  }
}

interface GraphMissionContext {
  workspaceRoot: string;
  missionId: string;
  missionDir: string;
  graphRoot: string;
  eventsPath: string;
  goal: string;
  driver: IAgyDriver;
  worktreePool: IWorktreePool;
  journal: MissionJournal;
  gates: OracleGate[];
  model?: string;
  effort?: "low" | "medium" | "high";
  timeoutMs: number;
  maxConcurrency: number;
  maxWaves: number;
  startedAt: number;
  diagnostics: string[];
  initialWave: number;
  logger: MissionLogger;
  verbose?: boolean;
}

async function runGraphMission(context: GraphMissionContext): Promise<RealMissionReport> {
  const commitShas: string[] = [];
  let wave = context.initialWave;

  while (wave <= context.maxWaves) {
    const runtime = loadGraphRuntime(context.graphRoot);
    const verification = verifyGraphStore(runtime);
    if (!verification.valid) {
      context.logger.log("Mission", `Graph validation failed: ${verification.errors.join("; ")}`, "ERROR");
      return finishMission(context.eventsPath, context.missionId, context.startedAt, "failed", wave, commitShas, verification.errors, graphProgress(runtime, verification.events), context.logger);
    }

    const projection = projectGraph(runtime.graph, verification.events);
    const readyNodes = projection.readySet
      .map((nodeId) => runtime.graph.nodes.find((node) => node.id === nodeId))
      .filter((node): node is GraphNode => Boolean(node && node.kind === "agent"));

    if (readyNodes.length === 0) {
      if (projection.status === "succeeded") {
        context.logger.log("Mission", "All nodes succeeded. Mission execution completed.", "SUCCESS");
        return finishMission(context.eventsPath, context.missionId, context.startedAt, "succeeded", wave, commitShas, context.diagnostics, graphProgress(runtime, verification.events), context.logger);
      }
      if (projection.status === "failed" || projection.nodes.some((node) => node.state === "failed")) {
        context.logger.log("Mission", "Graph reached failed terminal state without remaining ready nodes.", "ERROR");
        return finishMission(context.eventsPath, context.missionId, context.startedAt, "failed", wave, commitShas, context.diagnostics, graphProgress(runtime, verification.events), context.logger);
      }
      context.logger.log("Mission", "Graph is stalled without a ready executable node.", "ERROR");
      return finishMission(context.eventsPath, context.missionId, context.startedAt, "failed", wave, commitShas, ["Graph is stalled without a ready executable node."], graphProgress(runtime, verification.events), context.logger);
    }

    context.logger.log("Wave", `Starting Wave ${wave}/${context.maxWaves} with ${readyNodes.length} ready node(s)...`);
    MissionEventsStore.appendEvent(context.eventsPath, context.missionId, {
      type: "wave_started",
      waveIndex: wave,
    });

    const batch = selectConcurrentNodes(readyNodes, context.maxConcurrency);
    const dispatched = batch.map((node) => {
      const dispatchId = `dispatch-${node.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      appendGraphTransition(runtime, {
        eventType: "node_dispatched",
        nodeId: node.id,
        dispatchId,
        authorityId: schedulerAuthorityId,
      });
      return { node, dispatchId };
    });

    const outcomes = await Promise.all(dispatched.map((entry) => executeNode(context, entry.node, entry.dispatchId)));
    const failures = outcomes.filter((outcome): outcome is BatchFailure => "reason" in outcome && !("operations" in outcome));
    const changes = outcomes.filter((outcome): outcome is WorktreeChange => "operations" in outcome);

    if (failures.length > 0 || changes.length !== dispatched.length) {
      const allFailures = failures.length > 0
        ? failures
        : dispatched.map((entry) => ({ node: entry.node, runId: `run-${entry.node.id}`, reason: "A worker completed without a promotable diff." }));
      context.logger.log("Wave", `Wave ${wave} had ${allFailures.length} failure(s): ${allFailures.map(f => f.reason).join("; ")}`, "WARN");
      await completeFailedBatch(context, dispatched, allFailures);
      if (wave >= context.maxWaves) {
        return finishMission(context.eventsPath, context.missionId, context.startedAt, "budget_exhausted", wave, commitShas, allFailures.map((failure) => failure.reason), graphProgress(loadGraphRuntime(context.graphRoot), verifyGraphStore(loadGraphRuntime(context.graphRoot)).events), context.logger);
      }
      await publishRepairNodes(context, allFailures, wave + 1);
      MissionEventsStore.appendEvent(context.eventsPath, context.missionId, {
        type: "wave_transitioned",
        fromWave: wave,
        toWave: wave + 1,
        progressBefore: graphProgress(runtime, verification.events),
        progressAfter: graphProgress(loadGraphRuntime(context.graphRoot), verifyGraphStore(loadGraphRuntime(context.graphRoot)).events),
        hasProgressed: false,
        reason: allFailures.map((failure) => failure.reason).join("; "),
      });
      wave += 1;
      continue;
    }

    let promotion: BatchPromotion | undefined;
    try {
      promotion = await reviewAndPromote(context, changes, wave);
      commitShas.push(promotion.commitSha);
    } catch (error) {
      const reason = messageOf(error);
      context.logger.log("Review", `Batch promotion failed in wave ${wave}: ${reason}`, "WARN");
      const promotionFailures = changes.map((change) => ({ node: change.node, runId: change.runId, reason }));
      await completeFailedBatch(context, dispatched, promotionFailures);
      if (wave >= context.maxWaves) {
        return finishMission(context.eventsPath, context.missionId, context.startedAt, "budget_exhausted", wave, commitShas, [reason], graphProgress(loadGraphRuntime(context.graphRoot), verifyGraphStore(loadGraphRuntime(context.graphRoot)).events), context.logger);
      }
      await publishRepairNodes(context, promotionFailures, wave + 1);
      wave += 1;
      continue;
    }

    for (const change of changes) {
      const freshRuntime = loadGraphRuntime(context.graphRoot);
      const dispatch = dispatched.find((entry) => entry.node.id === change.node.id);
      if (!dispatch) continue;
      appendGraphTransition(freshRuntime, {
        eventType: "node_completed",
        nodeId: change.node.id,
        dispatchId: dispatch.dispatchId,
        authority: "broker",
        authorityId: brokerAuthorityId,
        outcome: "success",
        evidenceHash: promotion.diffDigest,
      });
      MissionEventsStore.appendEvent(context.eventsPath, context.missionId, {
        type: "run_finished",
        runId: change.runId,
        workItemId: change.node.id,
        expertId: change.node.executor?.persona ?? "executor",
        status: "succeeded",
        durationMs: change.result.durationMs,
        stdoutHash: change.result.stdoutHash,
      });
      await context.worktreePool.release(change.node.id, true);
    }

    MissionEventsStore.appendEvent(context.eventsPath, context.missionId, {
      type: "integration_attempted",
      waveIndex: wave,
      workItemsIntegrated: changes.map((change) => change.node.id),
      commitSha: promotion.commitSha,
      status: "integrated",
    });
  }

  const runtime = loadGraphRuntime(context.graphRoot);
  return finishMission(context.eventsPath, context.missionId, context.startedAt, "budget_exhausted", context.maxWaves, commitShas, ["Maximum dynamic workflow waves exhausted."], graphProgress(runtime, verifyGraphStore(runtime).events), context.logger);
}

async function executeNode(
  context: GraphMissionContext,
  node: GraphNode,
  dispatchId: string,
): Promise<WorktreeChange | BatchFailure> {
  const runId = `run-${node.id}-${Date.now()}`;
  let worktreePath = "";
  try {
    worktreePath = await context.worktreePool.acquire(node.id, "HEAD");
    context.logger.log(`Worker:${node.id}`, `Acquired isolated worktree at ${worktreePath}`);
    MissionEventsStore.appendEvent(context.eventsPath, context.missionId, {
      type: "run_started",
      runId,
      workItemId: node.id,
      expertId: node.executor?.persona ?? "executor",
      model: context.model ?? "default",
      effort: context.effort ?? "agy-default",
      worktreePath,
    });

    const promptText = workerPrompt(context.goal, node);
    const workerRunLogger = context.logger.createRunLogger({
      runId,
      expertId: node.executor?.persona ?? "executor",
      persona: node.executor?.persona ?? "executor",
      model: context.model,
      effort: context.effort,
      worktree: worktreePath,
      prompt: promptText,
    }, { streamConsole: context.verbose });

    const result = await context.driver.invoke({
      contractPrompt: promptText,
      persona: node.executor?.persona ?? "executor",
      worktreeDir: worktreePath,
      timeoutMs: context.timeoutMs,
      modelOverride: context.model,
      reasoningEffort: context.effort,
      executionMode: "accept-edits",
      runId,
      verbose: context.verbose,
      onStdoutChunk: (chunk) => workerRunLogger.handleStdoutChunk(chunk),
      onStderrChunk: (chunk) => workerRunLogger.handleStderrChunk(chunk),
    });

    workerRunLogger.finalize({
      exitCode: result.exitCode,
      status: result.status,
      durationMs: result.durationMs,
      parsedOutput: result.parsedOutput,
      error: result.error,
    });

    const receipt = persistArtifact(context.missionDir, `worker-${safeFileName(node.id)}-${safeFileName(runId)}.json`, JSON.stringify(receiptPayload(result), null, 2));
    MissionEventsStore.appendEvent(context.eventsPath, context.missionId, {
      type: "artifact_created",
      runId,
      workItemId: node.id,
      artifactPath: receipt.path,
      artifactHash: receipt.hash,
      artifactKind: "report",
    });
    if (result.status !== "success") {
      context.logger.log(`Worker:${node.id}`, `Execution failed (${result.status}): ${result.error ?? "No error details"}`, "ERROR");
      return { node, runId, reason: result.error ?? `Worker exited with ${result.status}.` };
    }

    const extracted = extractWorktreeChange(context.workspaceRoot, worktreePath, node.scope ?? []);
    context.logger.saveDiff(node.id, extracted.diff);
    context.logger.log(`Worker:${node.id}`, `Generated diff: ${extracted.operations.length} file ops, ${extracted.diff ? extracted.diff.split('\n').length : 0} diff lines`, "SUCCESS");

    const diffArtifact = persistArtifact(context.missionDir, `diff-${safeFileName(node.id)}-${safeFileName(runId)}.patch`, extracted.diff);
    MissionEventsStore.appendEvent(context.eventsPath, context.missionId, {
      type: "artifact_created",
      runId,
      workItemId: node.id,
      artifactPath: diffArtifact.path,
      artifactHash: diffArtifact.hash,
      artifactKind: "diff",
    });
    return { node, runId, worktreePath, result, diff: extracted.diff, operations: extracted.operations };
  } catch (error) {
    return { node, runId, reason: messageOf(error) };
  }
}

async function completeFailedBatch(
  context: GraphMissionContext,
  dispatched: Array<{ node: GraphNode; dispatchId: string }>,
  failures: BatchFailure[],
): Promise<void> {
  const byNode = new Map(failures.map((failure) => [failure.node.id, failure]));
  for (const entry of dispatched) {
    const failure = byNode.get(entry.node.id) ?? {
      node: entry.node,
      runId: `run-${entry.node.id}`,
      reason: "The concurrent batch was discarded after another node failed.",
    };
    const runtime = loadGraphRuntime(context.graphRoot);
    appendGraphTransition(runtime, {
      eventType: "node_completed",
      nodeId: entry.node.id,
      dispatchId: entry.dispatchId,
      authority: "broker",
      authorityId: brokerAuthorityId,
      outcome: "failure",
      evidenceHash: sha256(failure.reason),
    });
    MissionEventsStore.appendEvent(context.eventsPath, context.missionId, {
      type: "run_finished",
      runId: failure.runId,
      workItemId: entry.node.id,
      expertId: entry.node.executor?.persona ?? "executor",
      status: "failed",
      durationMs: 0,
      error: failure.reason,
    });
    await context.worktreePool.release(entry.node.id, true);
  }
}

async function reviewAndPromote(
  context: GraphMissionContext,
  changes: WorktreeChange[],
  wave: number,
): Promise<BatchPromotion> {
  const proposal = combineChanges(context.workspaceRoot, changes);
  const author: RunAuthority = {
    missionId: context.missionId,
    runKey: `batch-${wave}-${Date.now()}`,
    leaseId: `lease-${wave}-${Date.now()}`,
    epoch: String(wave),
    expertId: "worker-batch",
  };
  context.journal.appendRunStarted(author);
  const reviewBroker = new StagedReviewBroker(context.journal);
  const staged = reviewBroker.stage(author, context.workspaceRoot, proposal);
  const stagedArtifact = persistArtifact(context.missionDir, `staged-${staged.transaction.transactionId}.patch`, staged.canonicalDiff);
  const artifactRef: ArtifactRef = {
    id: `diff:${staged.transaction.transactionId}`,
    kind: "diff",
    path: stagedArtifact.path,
    sha256: stagedArtifact.hash,
    bytes: Buffer.byteLength(staged.canonicalDiff, "utf8"),
    producedByRunKey: author.runKey,
    inputHashes: [],
  };

  const reviewerSpecs = ["reviewer-alpha", "reviewer-beta"] as const;
  const reviews = await Promise.all(reviewerSpecs.map(async (reviewerExpertId) => {
    const reviewerRunId = `run-${reviewerExpertId}-${staged.transaction.transactionId.slice(0, 12)}`;
    const promptText = reviewerPrompt(staged.canonicalDiff, staged.stagedDiffDigest);
    const revLogger = context.logger.createRunLogger({
      runId: reviewerRunId,
      expertId: reviewerExpertId,
      persona: "reviewer",
      model: context.model,
      effort: context.effort,
      worktree: staged.worktreePath,
      prompt: promptText,
    }, { streamConsole: context.verbose });

    const result = await context.driver.invoke({
      contractPrompt: promptText,
      persona: "reviewer",
      worktreeDir: staged.worktreePath,
      timeoutMs: context.timeoutMs,
      modelOverride: context.model,
      reasoningEffort: context.effort,
      executionMode: "plan",
      runId: reviewerRunId,
      verbose: context.verbose,
      onStdoutChunk: (chunk) => revLogger.handleStdoutChunk(chunk),
      onStderrChunk: (chunk) => revLogger.handleStderrChunk(chunk),
    });

    const verdict = parseReviewerVerdict(result);
    revLogger.finalize({
      exitCode: result.exitCode,
      status: result.status,
      durationMs: result.durationMs,
      parsedOutput: verdict,
      error: result.error,
    });
    context.logger.log(`Reviewer:${reviewerExpertId}`, `Verdict: ${verdict.verdict.toUpperCase()}`);

    return { reviewerExpertId, reviewerRunId, result, verdict };
  }));

  for (const review of reviews) {
    const reviewArtifact = persistArtifact(
      context.missionDir,
      `review-${safeFileName(review.reviewerRunId)}.json`,
      JSON.stringify({ receipt: receiptPayload(review.result), verdict: review.verdict }, null, 2),
    );
    const reviewer: RunAuthority = {
      missionId: context.missionId,
      runKey: review.reviewerRunId,
      leaseId: `lease-${review.reviewerRunId}`,
      epoch: String(wave),
      expertId: review.reviewerExpertId,
    };
    context.journal.appendRunStarted(reviewer);
    attestReviewFromManifest(context.journal, reviewer, context.missionDir, [artifactRef], review.verdict.verdict);
    for (const change of changes) {
      MissionEventsStore.appendEvent(context.eventsPath, context.missionId, {
        type: "artifact_created",
        runId: review.reviewerRunId,
        workItemId: change.node.id,
        artifactPath: reviewArtifact.path,
        artifactHash: reviewArtifact.hash,
        artifactKind: "report",
      });
      MissionEventsStore.appendEvent(context.eventsPath, context.missionId, {
        type: "review_attested",
        runId: change.runId,
        reviewerRunId: review.reviewerRunId,
        reviewerExpertId: review.reviewerExpertId,
        workItemId: change.node.id,
        subjectDiffDigest: staged.stagedDiffDigest,
        verdict: review.verdict.verdict === "approved" ? "approved" : "rejected",
        observations: review.verdict.observations,
      });
    }
  }

  if (reviews.some((review) => review.verdict.verdict !== "approved")) {
    context.logger.log("Review", "Staged transaction rejected by an independent reviewer.", "WARN");
    discardStagedTransaction(staged);
    throw new Error("An independent reviewer rejected or could not validate the exact staged diff.");
  }

  context.logger.log("Gate", `Evaluating ${context.gates.length} external gate(s)...`);
  const evaluation = evaluateStagedTransaction(staged, context.gates);
  const gateArtifact = persistArtifact(
    context.missionDir,
    `gates-${staged.transaction.transactionId}.json`,
    JSON.stringify(evaluation, null, 2),
  );
  for (const change of changes) {
    MissionEventsStore.appendEvent(context.eventsPath, context.missionId, {
      type: "artifact_created",
      runId: author.runKey,
      workItemId: change.node.id,
      artifactPath: gateArtifact.path,
      artifactHash: gateArtifact.hash,
      artifactKind: "report",
    });
  }
  if (evaluation.status !== "approved") {
    context.logger.logGateResult(evaluation.failedGateId, "failed", [evaluation.reason]);
    MissionEventsStore.appendEvent(context.eventsPath, context.missionId, {
      type: "gate_evaluated",
      gateId: evaluation.failedGateId,
      status: "failed",
      progressVector: zeroProgress(changes.length, 0, 1),
      durationMs: 0,
      diagnostics: [evaluation.reason],
    });
    throw new Error(`External gate '${evaluation.failedGateId}' rejected the staged transaction.`);
  }

  for (const observation of evaluation.observations) {
    context.logger.logGateResult(observation.id, "passed", []);
    MissionEventsStore.appendEvent(context.eventsPath, context.missionId, {
      type: "gate_evaluated",
      gateId: observation.id,
      status: "passed",
      progressVector: zeroProgress(changes.length, changes.length, 0),
      durationMs: 0,
      diagnostics: [],
    });
  }

  const promoted = reviewBroker.promote(author, staged.transaction.transactionId, evaluation.approval);
  if (promoted.transaction !== "promoted") {
    context.logger.log("Integrator", `Promotion refused: ${promoted.reasonCode}`, "ERROR");
    throw new Error(`Promotion refused: ${promoted.reasonCode}.`);
  }
  context.logger.log("Integrator", `Promotion complete! Git commit: ${promoted.commitSha.slice(0, 8)}`, "SUCCESS");
  return {
    commitSha: promoted.commitSha,
    diffDigest: promoted.diffDigest,
    observations: evaluation.observations.map((observation) => observation.id),
  };
}

async function publishPlan(graphRoot: string, missionId: string, plan: PlannedWorkItem[], gateId: string): Promise<void> {
  const runtime = loadGraphRuntime(graphRoot);
  const operations: Array<{ type: "add_node"; node: GraphNode } | { type: "add_edge"; edge: GraphEdge }> = [];
  for (const item of plan) {
    operations.push({
      type: "add_node",
      node: {
        id: item.id,
        title: item.title,
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: brokerAuthorityId,
        executor: { adapter: "agy", persona: item.persona },
        scope: item.scope,
        acceptance: item.acceptance.map((description, index) => ({
          id: `criterion-${index + 1}`,
          description,
          gateId,
        })),
        maxDiff: { files: item.scope.length, lines: 2_000 },
      },
    });
  }
  for (const item of plan) {
    const dependencies = item.dependsOn.length > 0 ? item.dependsOn : [bootstrapNodeId];
    for (const dependency of dependencies) {
      operations.push({
        type: "add_edge",
        edge: {
          id: `edge-${dependency}-${item.id}`,
          from: dependency,
          to: item.id,
          when: "success",
        },
      });
    }
  }
  const proposal = {
    schemaVersion: 2 as const,
    proposalId: proposalId(missionId, "plan", runtime.graph.revision),
    expectedRevision: runtime.graph.revision,
    author: "oma-controller",
    reason: "Publish planner-derived work graph through the broker.",
    missionId,
    parentGraphHash: runtime.graphHash,
    operations,
  };
  const result = await new GraphBroker(graphRoot).applyProposal(proposal);
  if (!result.success) {
    throw new Error(`Graph proposal rejected: ${result.error ?? result.code}`);
  }
}

async function publishRepairNodes(
  context: Pick<GraphMissionContext, "graphRoot" | "missionId" | "eventsPath">,
  failures: BatchFailure[],
  wave: number,
): Promise<void> {
  const runtime = loadGraphRuntime(context.graphRoot);
  const operations: Array<{ type: "add_node"; node: GraphNode } | { type: "add_edge"; edge: GraphEdge }> = [];
  for (const failure of failures) {
    const repairId = `${failure.node.id}-repair-${wave}`;
    operations.push({
      type: "add_node",
      node: {
        id: repairId,
        title: `Repair ${failure.node.title}`,
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: brokerAuthorityId,
        executor: { adapter: "agy", persona: "fixer" },
        scope: failure.node.scope,
        acceptance: failure.node.acceptance,
        maxDiff: failure.node.maxDiff,
      },
    });
    operations.push({
      type: "add_edge",
      edge: {
        id: `edge-${failure.node.id}-${repairId}`,
        from: failure.node.id,
        to: repairId,
        when: "failure",
      },
    });
  }
  const proposal = {
    schemaVersion: 2 as const,
    proposalId: proposalId(context.missionId, "repair", runtime.graph.revision),
    expectedRevision: runtime.graph.revision,
    author: "oma-controller",
    reason: `Publish repair wave ${wave} after verified worker or gate failure.`,
    missionId: context.missionId,
    parentGraphHash: runtime.graphHash,
    operations,
  };
  const result = await new GraphBroker(context.graphRoot).applyProposal(proposal);
  if (!result.success) {
    throw new Error(`Repair graph proposal rejected: ${result.error ?? result.code}`);
  }
  for (const failure of failures) {
    const repairId = `${failure.node.id}-repair-${wave}`;
    MissionEventsStore.appendEvent(context.eventsPath, context.missionId, {
      type: "work_item_discovered",
      workItemId: repairId,
      title: `Repair ${failure.node.title}`,
      scope: failure.node.scope ?? [],
      dependsOn: [failure.node.id],
      roleRequired: "fixer",
      acceptanceCriteria: (failure.node.acceptance ?? []).map((criterion) => criterion.description),
    });
  }
}

function initializeMissionGraph(graphRoot: string, missionId: string, gates: OracleGate[]): void {
  const paths = graphPaths(graphRoot);
  if (existsSync(paths.definition) || existsSync(paths.events) || existsSync(paths.head)) {
    throw new Error(`Mission graph storage already exists at ${paths.graphDir}.`);
  }
  mkdirSync(paths.graphDir, { recursive: true });
  const registryPath = join(graphRoot, ".agents", "plugins", "oma", "gates.json");
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, gates }, null, 2), "utf8");
  const graph = {
    schemaVersion: 2,
    graphId: `graph-${missionId}`,
    revision: 1,
    schedulerAuthorityId,
    nodes: [
      {
        id: bootstrapNodeId,
        title: "OMA bootstrap",
        kind: "join",
        activation: "all",
        completionAuthority: "scheduler",
        completionAuthorityId: schedulerAuthorityId,
      },
    ],
    edges: [],
  };
  writeFileSync(paths.definition, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  const runtime = initializeGraphStore(graphRoot);
  const dispatchId = `dispatch-${bootstrapNodeId}`;
  appendGraphTransition(runtime, {
    eventType: "node_dispatched",
    nodeId: bootstrapNodeId,
    dispatchId,
    authorityId: schedulerAuthorityId,
  });
  appendGraphTransition(runtime, {
    eventType: "node_completed",
    nodeId: bootstrapNodeId,
    dispatchId,
    authority: "scheduler",
    authorityId: schedulerAuthorityId,
    outcome: "success",
    evidenceHash: sha256(`bootstrap:${missionId}`),
  });
}

function extractWorktreeChange(
  workspaceRoot: string,
  worktreePath: string,
  scope: string[],
): { diff: string; operations: ProposedOperation[] } {
  if (scope.length === 0) {
    throw new Error("An executable graph node must declare a non-empty file scope.");
  }
  const parentVersion = git(workspaceRoot, ["rev-parse", "HEAD"]).trim();
  const tracked = splitNul(git(worktreePath, ["diff", "--name-only", "-z", "HEAD", "--"]));
  const untracked = splitNul(git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]));
  const paths = [...new Set([...tracked, ...untracked])].sort();
  if (paths.length === 0) {
    throw new Error("Worker produced no Git diff or untracked file.");
  }
  const operations: ProposedOperation[] = [];
  for (const path of paths) {
    assertScopePath(path, scope);
    const sourcePath = resolve(workspaceRoot, ...path.split("/"));
    const worktreeFile = resolve(worktreePath, ...path.split("/"));
    const sourceExists = existsSync(sourcePath);
    const worktreeExists = existsSync(worktreeFile);
    if (worktreeExists && lstatSync(worktreeFile).isSymbolicLink()) {
      throw new Error(`Worker produced a symbolic link, which is forbidden: ${path}`);
    }
    if (worktreeExists) {
      const content = readTextFile(worktreeFile, path);
      operations.push({
        kind: "write",
        path,
        baseHash: sourceExists ? sha256(readGitBlob(workspaceRoot, parentVersion, path)) : null,
        content,
      });
    } else if (sourceExists) {
      operations.push({
        kind: "delete",
        path,
        baseHash: sha256(readGitBlob(workspaceRoot, parentVersion, path)),
      });
    } else {
      throw new Error(`Worker change references a missing file: ${path}`);
    }
  }
  const trackedDiff = git(worktreePath, ["diff", "--binary", "HEAD", "--"]);
  const untrackedDiff = untracked.map((path) => renderUntrackedDiff(worktreePath, path)).join("");
  const diff = `${trackedDiff}${untrackedDiff}`;
  if (diff.trim().length === 0) {
    throw new Error("Worker did not produce a trackable Git diff.");
  }
  if (!parentVersion || parentVersion.length !== 40) {
    throw new Error("Unable to determine the clean parent Git revision.");
  }
  return { diff, operations };
}

function combineChanges(workspaceRoot: string, changes: WorktreeChange[]): ChangeProposal {
  const parentVersion = git(workspaceRoot, ["rev-parse", "HEAD"]).trim();
  const operations = changes.flatMap((change) => change.operations);
  const seen = new Set<string>();
  for (const operation of operations) {
    if (seen.has(operation.path)) {
      throw new Error(`Concurrent workers proposed the same path: ${operation.path}`);
    }
    seen.add(operation.path);
  }
  if (operations.length === 0) {
    throw new Error("No operations are available for staging.");
  }
  return { schemaVersion: 1, parentVersion, operations };
}

function parsePlannerPlan(value: unknown): PlannedWorkItem[] {
  if (!isRecord(value) || !Array.isArray(value.workItems) || value.workItems.length === 0) {
    throw new Error("Planner must return JSON object { workItems: [...] } with at least one item.");
  }
  const rawItems = value.workItems;
  const ids = new Set<string>();
  const sourceIdToNodeId = new Map<string, string>();
  for (const raw of rawItems) {
    if (!isRecord(raw) || typeof raw.id !== "string") {
      throw new Error("Every planner work item requires a string id.");
    }
    const nodeId = `work-${normalizeWorkItemId(raw.id)}`;
    if (ids.has(nodeId)) {
      throw new Error(`Planner produced duplicate work item id: ${raw.id}`);
    }
    ids.add(nodeId);
    sourceIdToNodeId.set(raw.id, nodeId);
  }
  return rawItems.map((raw): PlannedWorkItem => {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.title !== "string" || !Array.isArray(raw.scope)) {
      throw new Error("Every planner work item requires id, title and scope.");
    }
    const scope = raw.scope.map((path) => validateRepoPath(path));
    if (scope.length === 0) {
      throw new Error(`Planner work item '${raw.id}' has an empty scope.`);
    }
    const itemId = raw.id;
    const dependencies = raw.dependsOn === undefined ? [] : parseStringArray(raw.dependsOn, `dependsOn for ${itemId}`);
    const dependsOn = dependencies.map((dependency) => {
      const mapped = sourceIdToNodeId.get(dependency);
      if (!mapped) throw new Error(`Planner dependency '${dependency}' is unknown.`);
      if (mapped === sourceIdToNodeId.get(itemId)) throw new Error(`Planner work item '${itemId}' depends on itself.`);
      return mapped;
    });
    const persona = raw.persona === undefined ? "executor" : raw.persona;
    if (persona !== "executor" && persona !== "worker" && persona !== "fixer") {
      throw new Error(`Planner work item '${raw.id}' has unsupported persona '${String(raw.persona)}'.`);
    }
    const acceptance = raw.acceptance === undefined
      ? ["The declared scope is implemented and external gates pass."]
      : parseStringArray(raw.acceptance, `acceptance for ${raw.id}`);
    if (acceptance.length === 0) {
      throw new Error(`Planner work item '${raw.id}' has no acceptance criterion.`);
    }
    return {
      id: sourceIdToNodeId.get(raw.id)!,
      title: raw.title.trim(),
      scope,
      dependsOn,
      persona,
      acceptance,
    };
  });
}

function parseReviewerVerdict(result: DriverExecutionResult): { verdict: ReviewerVerdict; observations: string[] } {
  if (result.status !== "success" || !isRecord(result.parsedOutput)) {
    return { verdict: "inconclusive", observations: [result.error ?? "Reviewer did not produce a structured result."] };
  }
  const verdict = result.parsedOutput.verdict;
  if (verdict !== "approved" && verdict !== "rejected") {
    return { verdict: "inconclusive", observations: ["Reviewer JSON lacks verdict approved or rejected."] };
  }
  const observations = Array.isArray(result.parsedOutput.observations)
    ? result.parsedOutput.observations.filter((value): value is string => typeof value === "string")
    : [];
  return { verdict, observations };
}

function selectConcurrentNodes(nodes: GraphNode[], maxConcurrency: number): GraphNode[] {
  const selected: GraphNode[] = [];
  const occupied = new Set<string>();
  for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    const scope = node.scope ?? [];
    if (scope.some((path) => occupied.has(path))) continue;
    selected.push(node);
    for (const path of scope) occupied.add(path);
    if (selected.length >= maxConcurrency) break;
  }
  return selected;
}

function resolveGates(supplied: OracleGate[] | undefined): OracleGate[] {
  const gitPath = resolveExecutable("git");
  const gates: OracleGate[] = [
    {
      id: "git-diff-check",
      program: gitPath,
      args: ["diff", "--check", "--cached"],
      timeoutMs: 60_000,
    },
    ...(supplied ?? []),
  ];
  const ids = new Set<string>();
  for (const gate of gates) {
    if (ids.has(gate.id)) throw new Error(`Duplicate external gate id: ${gate.id}`);
    ids.add(gate.id);
  }
  return gates;
}

function resolveExecutable(command: string): string {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [command], { encoding: "utf8", windowsHide: true });
  const candidate = result.status === 0 ? result.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) : undefined;
  if (!candidate || !existsSync(candidate)) {
    throw new Error(`Required executable is unavailable: ${command}`);
  }
  return candidate;
}

function ensureCleanWorkspace(workspaceRoot: string): void {
  const status = git(workspaceRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).oma/**",
    ":(exclude).agents/**",
    ":(exclude).omc/**",
    ":(exclude).omo/**",
    ":(exclude)dist/**",
    ":(exclude)docs/**",
    ":(exclude)*.log",
  ]);
  if (status.trim().length > 0) {
    throw new Error(
      `OMA requires a clean target Git workspace before it can stage or promote a mission.\nUncommitted changes detected:\n${status.trim()}\nPlease run 'git commit' or 'git stash' before starting the mission, or pass --allow-dirty.`,
    );
  }
}

function ensureRuntime(driver: IAgyDriver | undefined): void {
  if (driver) return;
  const executable = AgyDriver.resolveAgyBinary();
  const name = basename(executable).toLocaleLowerCase("en-US");
  const isWindows = process.platform === "win32";
  const isValid =
    existsSync(executable) &&
    (isWindows
      ? name === "agy.exe" ||
        name === "agy.cmd" ||
        name === "gemini.cmd" ||
        name === "gemini.exe" ||
        name === "agy" ||
        name === "gemini"
      : name === "agy" || name === "gemini");
  if (!isValid) {
    throw new Error(`OMA requires a verified AntiGravity executable. Resolved '${executable}'.`);
  }
}

function plannerPrompt(goal: string): string {
  return [
    "You are the planning expert for a real OMA mission.",
    `Goal: ${goal}`,
    "Inspect the repository read-only. Return JSON only, exactly {\"workItems\":[...]}",
    "Each work item must contain id, title, scope (non-empty array of repo-relative files), dependsOn (array of item ids), persona (worker or fixer), and acceptance (non-empty string array).",
    "Scopes must be exact files, must not overlap among concurrently independent work items, and every item must be independently buildable after its dependencies.",
  ].join("\n");
}

function workerPrompt(goal: string, node: GraphNode): string {
  return [
    "You are a worker in a verified OMA Graph Engineering mission.",
    `Mission goal: ${goal}`,
    `Node id: ${node.id}`,
    `Node title: ${node.title}`,
    `Allowed files only: ${(node.scope ?? []).join(", ")}`,
    `Acceptance criteria: ${(node.acceptance ?? []).map((criterion) => criterion.description).join(" | ")}`,
    "Implement the task in this worktree. Do not modify files outside the allowed scope. Run relevant checks. End with valid JSON describing changed files and checks, but the Git diff is the authoritative output.",
  ].join("\n");
}

function reviewerPrompt(diff: string, digest: string): string {
  return [
    "You are an independent adversarial reviewer.",
    `The exact staged diff SHA-256 is ${digest}.`,
    "Review only the diff below against correctness, security, scope and regression risk.",
    "Return JSON only: {\"verdict\":\"approved\"|\"rejected\",\"observations\":[\"...\"]}.",
    "Do not edit files and do not assume a successful worker run proves correctness.",
    "--- BEGIN STAGED DIFF ---",
    diff,
    "--- END STAGED DIFF ---",
  ].join("\n");
}

function persistArtifact(missionDir: string, fileName: string, content: string): { path: string; hash: string } {
  const path = join("artifacts", fileName).replace(/\\/gu, "/");
  const absolutePath = join(missionDir, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
  return { path, hash: sha256(content) };
}

function receiptPayload(result: DriverExecutionResult): Record<string, unknown> {
  return {
    receipt: result.receipt,
    status: result.status,
    error: result.error,
    stdout: result.scrubbedStdout,
    stderr: result.scrubbedStderr,
    parsedOutput: result.parsedOutput,
  };
}

function finishMission(
  eventsPath: string,
  missionId: string,
  startedAt: number,
  status: "succeeded" | "failed" | "budget_exhausted",
  waves: number,
  commitShas: string[],
  diagnostics: string[],
  progress: ProgressVector,
  logger?: MissionLogger,
): RealMissionReport {
  let graphRevision = 0;
  try {
    graphRevision = loadGraphRuntime(join(dirname(eventsPath), "graph-runtime")).graph.revision;
  } catch {}
  MissionEventsStore.appendEvent(eventsPath, missionId, {
    type: "mission_finished",
    finalStatus: status,
    totalDurationMs: Date.now() - startedAt,
    finalProgress: progress,
    integratedCommitSha: commitShas.at(-1),
  });
  MissionEventsStore.appendEvent(eventsPath, missionId, {
    type: "terminal_verdict_rendered",
    runId: `terminal-${missionId}`,
    status: status === "succeeded" ? "succeeded" : "failed",
    commitSha: commitShas.at(-1),
    verdictHash: sha256(canonicalJson({ missionId, status, commitShas, diagnostics, progress })),
  });
  const durationMs = Date.now() - startedAt;
  logger?.log(
    "Mission",
    `Mission ${status.toUpperCase()} in ${durationMs}ms (waves: ${waves}, commits: ${commitShas.length}, diagnostics: ${diagnostics.length})`,
    status === "succeeded" ? "SUCCESS" : "ERROR",
  );
  return {
    missionId,
    status,
    totalWaves: waves,
    graphRevision,
    commitShas,
    diagnostics,
    finalProgress: progress,
    totalDurationMs: durationMs,
  };
}

function graphProgress(runtime: ReturnType<typeof loadGraphRuntime>, events: ReturnType<typeof verifyGraphStore>["events"]): ProgressVector {
  const projection = projectGraph(runtime.graph, events);
  const executable = projection.nodes.filter((node) => node.kind === "agent");
  const accepted = executable.filter((node) => node.state === "succeeded").length;
  const failed = executable.filter((node) => node.state === "failed").length;
  return zeroProgress(executable.length, accepted, failed);
}

function zeroProgress(totalWorkItems: number, acceptedWorkItems: number, gateFailures: number): ProgressVector {
  return {
    hiddenTestsFailing: 0,
    hiddenTestsPassed: 0,
    visibleTestsFailing: gateFailures,
    visibleTestsPassed: acceptedWorkItems,
    gateFailures,
    openDiagnosticsCount: gateFailures,
    acceptedWorkItems,
    totalWorkItems,
  };
}

function driverStatusToMissionStatus(result: DriverExecutionResult): "failed" | "timed_out" {
  return result.status === "timed_out" ? "timed_out" : "failed";
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr ?? "").trim()}`);
  }
  return result.stdout ?? "";
}

function renderUntrackedDiff(worktreePath: string, path: string): string {
  const result = spawnSync("git", ["-C", worktreePath, "diff", "--binary", "--no-index", "--", "/dev/null", path], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 1) {
    throw new Error(`Unable to render untracked worker diff for ${path}: ${String(result.stderr ?? "").trim()}`);
  }
  const diff = result.stdout ?? "";
  if (diff.trim().length === 0) {
    throw new Error(`Untracked worker file has no renderable diff: ${path}`);
  }
  return diff;
}

function readGitBlob(workspaceRoot: string, revision: string, path: string): Buffer {
  const result = spawnSync("git", ["-C", workspaceRoot, "show", `${revision}:${path}`], {
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`Unable to read Git blob for ${path}: ${String(result.stderr ?? "").trim()}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
}

function splitNul(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function assertScopePath(path: string, scope: string[]): void {
  validateRepoPath(path);
  if (!scope.includes(path)) {
    throw new Error(`Worker modified '${path}', outside its declared graph scope.`);
  }
}

function readTextFile(path: string, label: string): string {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) {
    throw new Error(`Binary file changes are not accepted in OMA transactions: ${label}`);
  }
  return bytes.toString("utf8");
}

function validateRepoPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") || value.includes(":") || value.startsWith("/")) {
    throw new Error(`Invalid repository-relative path: ${String(value)}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Invalid repository-relative path: ${value}`);
  }
  return value;
}

function normalizeMissionId(value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,80}$/u.test(normalized)) {
    throw new Error("Mission id must use 3-81 letters, digits, dots, underscores or hyphens.");
  }
  return normalized;
}

function normalizeWorkItemId(value: string): string {
  const normalized = value.toLocaleLowerCase("en-US").replace(/[^a-z0-9-]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "");
  if (!/^[a-z0-9][a-z0-9-]{1,50}$/u.test(normalized)) {
    throw new Error(`Invalid planner work item id: ${value}`);
  }
  return normalized;
}

function proposalId(missionId: string, kind: string, revision: number): string {
  return `prop_${sha256(`${missionId}:${kind}:${revision}`).slice(0, 24)}`;
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value.map((entry) => String(entry).trim());
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
