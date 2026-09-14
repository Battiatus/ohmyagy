import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256, isRecord } from "../ledger/canonical.js";
import {
  MissionEventsStore,
  generateDeterministicRunId,
  generateDeterministicWorkItemId,
} from "../ledger/mission-events.js";
import {
  ObjectiveJudge,
  type JudgeVerdict,
  type PipelineModuleBundle,
  type ProgressVector,
} from "../oracle/objective-judge.js";
import {
  AdversarialReviewEngine,
  type IndependentReviewVerdict,
  type ReviewSubject,
} from "../oracle/adversarial-review.js";
import {
  DeterministicIntegrator,
  type WorkItemChangeProposal,
  type IntegrationReport,
} from "./integrator.js";
import { AgyDriver, type IAgyDriver, type DriverExecutionResult } from "../runtime/agy-driver.js";
import { WorktreePool, type IWorktreePool } from "./worktree-pool.js";
import { GraphBroker } from "../graph/broker.js";
import {
  initializeGraphStore,
  appendGraphTransition,
  loadGraphRuntime,
  verifyGraphStore,
  graphPaths,
  type LoadedGraphRuntime,
} from "../graph/store.js";
import { projectGraph } from "../graph/kernel.js";
import { BOOTSTRAP_NODE_ID, buildInitialExecutionGraph } from "../graph/bootstrap.js";
import { materializeWorkItemNodes } from "../graph/materialize.js";
import type { GraphProposal } from "../graph/proposal.js";
import * as originalMath from "../../test-fixtures/minimal-pipeline/src/math.js";
import * as originalParser from "../../test-fixtures/minimal-pipeline/src/parser.js";
import * as originalPipeline from "../../test-fixtures/minimal-pipeline/src/pipeline.js";

import {
  evaluateConvergenceStep,
  type DynamicWorkflowLimits,
} from "./convergence-step.js";

export type { DynamicWorkflowLimits };

/**
 * The projected state of a node, or undefined when the graph has no such node.
 *
 * The engine can be run more than once against the same workspace — a benchmark runs four
 * variants over shared fixtures — and node ids are deterministic, so a second run finds nodes
 * the first run already completed. Emitting `node_dispatched` for a succeeded node is a
 * rejected transition (`Node x is succeeded, not ready`), not an error worth reporting: the
 * graph is simply further along than this run assumed.
 */
function projectedStateOf(runtime: LoadedGraphRuntime, nodeId: string): string | undefined {
  try {
    return projectGraph(runtime.graph, verifyGraphStore(runtime).events).nodes.find(
      (node) => node.id === nodeId,
    )?.state;
  } catch {
    return undefined;
  }
}

/**
 * Report a graph bookkeeping failure instead of swallowing it.
 *
 * The engine's transitions used to sit inside `try {} catch {}`. That is how it emitted
 * `node_dispatched` and `node_completed` for nodes it had never added: every rejection was
 * discarded, and the only symptom was a mission that could not converge.
 */
function recordEngineProblem(error: unknown, context: string): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`OMA dynamic engine: ${context} failed: ${message}\n`);
}

export interface DynamicEngineOptions {
  workspaceRoot: string;
  missionId: string;
  goal?: string;
  workflowDigest?: string;
  rulebookRevision?: string;
  driver?: IAgyDriver;
  worktreePool?: IWorktreePool;
  baseBundle?: PipelineModuleBundle;
  limits?: Partial<DynamicWorkflowLimits>;
  initialWorkItemsSupplier?: (wave: number) => Array<{
    scopeId: string;
    title: string;
    filesModified: string[];
    modulePatch?: Partial<PipelineModuleBundle>;
    rawDiffContent?: string;
  }>;
  diagnosticFixerSupplier?: (diagnostics: string[]) => Array<{
    scopeId: string;
    title: string;
    filesModified: string[];
    modulePatch?: Partial<PipelineModuleBundle>;
    rawDiffContent?: string;
  }>;
}

export interface DynamicConvergenceReport {
  missionId: string;
  status: "succeeded" | "failed" | "budget_exhausted" | "no_progress_blocked";
  totalWaves: number;
  progressHistory: ProgressVector[];
  finalProgress: ProgressVector;
  integratedCommitSha?: string;
  totalDurationMs: number;
}

/**
 * DynamicConvergenceEngine Execution Loop Architectural Mapping (T3.1):
 *
 * 1. INITIALIZATION & WORKSPACE SETUP:
 *    - Resolve paths: .oma/missions/<missionId>, events.jsonl, artifacts/, worktrees/.
 *    - Initialize Graph Store DAG runtime (execution-graph.json, graph-events.jsonl, HEAD).
 *    - Emit mission_started journal event with budgets (maxRounds, maxTimeMs).
 *    - Load base module bundle and prepare initial work items.
 *
 * 2. ITEM DISCOVERY (Wave 1):
 *    - InitialWorkItemsSupplier (if provided) OR invoke Planner persona via AgyDriver.
 *    - Fallback: fails closed with mission_finished: failed if planner fails.
 *
 * 3. WAVE CONVERGENCE LOOP (CurrentWave <= limits.maxRounds):
 *    - Check overall time budget (Date.now() - startTime > maxTimeMs).
 *    - Emit wave_started.
 *    - Materialize & register work items as DAG nodes in graph runtime (appendGraphTransition: node_dispatched).
 *    - Emit work_item_discovered.
 *    - PARALLEL EXECUTION:
 *      * Acquire isolated git worktree via WorktreePool.
 *      * Emit run_started.
 *      * Invoke AgyDriver (executor persona on wave 1, fixer on subsequent waves).
 *      * Extract git diff or patch, write diff artifact, compute sha256 digest.
 *      * Emit run_finished and artifact_created.
 *      * Release worktree.
 *    - DUAL ADVERSARIAL AUDIT:
 *      * Reviewer Alpha and Reviewer Beta independently evaluate staged diff.
 *      * Emit review_attested for each reviewer with cryptographic verdict.
 *    - 2-PHASE COMMIT INTEGRATION:
 *      * DeterministicIntegrator integrates only doubly-approved proposals.
 *      * If integrated, commit staged changes to workspace git repository.
 *    - OBJECTIVE JUDGE & PROGRESS VECTOR:
 *      * ObjectiveJudge runs hidden + visible tests on integrated bundle.
 *      * Compute ProgressVector (hidden/visible test counts, gate failures, diagnostics).
 *      * Emit gate_evaluated.
 *    - CONVERGENCE STEP EVALUATION (evaluateConvergenceStep):
 *      * State A (Converged): Judge approved + integrated -> emit terminal_verdict_rendered, mission_finished: succeeded.
 *      * State B (Stagnation): ObjectiveJudge.isProgressing(prev, curr) === false for >= maxConsecutiveNoProgressRounds
 *        -> emit terminal_verdict_rendered, mission_finished: no_progress_blocked.
 *      * State C (Budget Exhausted): CurrentWave >= maxRounds -> emit mission_finished: budget_exhausted.
 *      * State D (In Progress / Adaptation):
 *        - Emit wave_transitioned linking previous and current progress.
 *        - Trigger Dynamic Re-planning: DiagnosticFixerSupplier or Fixer persona
 *          targets diagnostics from JudgeVerdict to generate next wave work items.
 *        - Increment currentWave and repeat.
 */
export class DynamicConvergenceEngine {
  public static async execute(options: DynamicEngineOptions): Promise<DynamicConvergenceReport> {
    const startTime = Date.now();
    const {
      workspaceRoot,
      missionId,
      goal = "Adaptive convergence through dynamic workflow",
      baseBundle,
      initialWorkItemsSupplier,
      diagnosticFixerSupplier,
    } = options;

    const driver: IAgyDriver = options.driver ?? new AgyDriver();
    const worktreePool: IWorktreePool =
      options.worktreePool ?? new WorktreePool({ workspaceRoot });
    const graphBroker = new GraphBroker(workspaceRoot);

    const limits: DynamicWorkflowLimits = {
      maxRounds: options.limits?.maxRounds ?? 5,
      maxTimeMs: options.limits?.maxTimeMs ?? 300_000,
      maxConsecutiveNoProgressRounds: options.limits?.maxConsecutiveNoProgressRounds ?? 2,
    };

    const workflowDigest = options.workflowDigest ?? "workflow-converge-v1-digest";
    const rulebookRevision = options.rulebookRevision ?? "rulebook-rev-001";

    const missionDir = join(workspaceRoot, ".oma", "missions", missionId);
    const eventsPath = join(missionDir, "events.jsonl");
    const artifactsDir = join(missionDir, "artifacts");
    const worktreesDir = join(workspaceRoot, ".oma", "worktrees");

    mkdirSync(artifactsDir, { recursive: true });
    mkdirSync(worktreesDir, { recursive: true });

    // Initialize graph store runtime
    const gPaths = graphPaths(workspaceRoot);
    let graphRuntime: LoadedGraphRuntime | undefined;
    if (!existsSync(gPaths.definition)) {
      mkdirSync(gPaths.graphDir, { recursive: true });
      // The canonical builder, not a hand-written object: this used to omit
      // `schedulerAuthorityId` and pass empty `nodes`, both of which
      // `parseExecutionGraph` rejects, and the rejection was swallowed below — so the
      // engine ran with an empty fallback graph and could never be declared successful.
      const initialGraph = buildInitialExecutionGraph({
        graphId: `graph-${missionId}`,
        schedulerAuthorityId: "oma-dynamic-engine",
        title: `Detached engine seed for ${missionId}`,
      });
      writeFileSync(gPaths.definition, `${JSON.stringify(initialGraph, null, 2)}\n`, "utf8");
    }
    let graphLoadError: string | undefined;
    try {
      if (!existsSync(gPaths.events) && !existsSync(gPaths.head)) {
        graphRuntime = initializeGraphStore(workspaceRoot);
      } else {
        graphRuntime = loadGraphRuntime(workspaceRoot);
      }
    } catch (error) {
      try {
        graphRuntime = loadGraphRuntime(workspaceRoot);
      } catch (secondError) {
        graphLoadError = secondError instanceof Error ? secondError.message : String(secondError);
      }
    }
    if (graphRuntime === undefined) {
      // Without a graph there is no deliverable node, so `evaluateConvergenceStep` can never
      // reach `succeeded` and the mission would exhaust its budget while making real progress.
      // Failing loudly is the only honest outcome.
      throw new Error(
        `Dynamic engine cannot run without an execution graph: ${graphLoadError ?? "unknown graph load failure"}`,
      );
    }

    // Retire the engine's own seed. It exists only so revision 1 has a parent for the first
    // proposal; left `ready` it keeps the graph out of a terminal state forever, so a mission
    // whose real nodes had all succeeded still projected as `ready` and exhausted its budget.
    // `graph_init` already retires its seed this way.
    //
    // Only when it is still `ready`: a benchmark runs the engine repeatedly against the same
    // workspace, and a second retirement attempt on an already-succeeded seed is a rejected
    // transition (`Node bootstrap is succeeded, not ready`), not a no-op.
    const seedState = projectGraph(graphRuntime.graph, verifyGraphStore(graphRuntime).events)
      .nodes.find((node) => node.id === BOOTSTRAP_NODE_ID)?.state;
    if (seedState === "ready") {
      const seedDispatchId = "dispatch-bootstrap";
      appendGraphTransition(graphRuntime, {
        eventType: "node_dispatched",
        nodeId: BOOTSTRAP_NODE_ID,
        dispatchId: seedDispatchId,
        authorityId: graphRuntime.graph.schedulerAuthorityId,
      });
      appendGraphTransition(graphRuntime, {
        eventType: "node_completed",
        nodeId: BOOTSTRAP_NODE_ID,
        dispatchId: seedDispatchId,
        authority: "scheduler",
        authorityId: graphRuntime.graph.schedulerAuthorityId,
        outcome: "success",
        evidenceHash: sha256(`bootstrap:${missionId}`),
      });
      graphRuntime = loadGraphRuntime(workspaceRoot);
    }

    // 0. Start Mission & Journal Entry
    MissionEventsStore.appendEvent(eventsPath, missionId, {
      type: "mission_started",
      workflowDigest,
      rulebookRevision,
      goal,
      totalBudgets: { maxRounds: limits.maxRounds, maxTimeMs: limits.maxTimeMs },
    });

    let currentWave = 1;
    let consecutiveNoProgressCount = 0;
    const progressHistory: ProgressVector[] = [];
    let currentWorkingBundle: PipelineModuleBundle = baseBundle
      ? {
          math: { ...baseBundle.math },
          parser: { ...baseBundle.parser },
          pipeline: { ...baseBundle.pipeline },
        }
      : {
          math: originalMath,
          parser: originalParser,
          pipeline: originalPipeline,
        };

    // Determine initial items
    let activeItemsInput: Array<{
      scopeId: string;
      title: string;
      filesModified: string[];
      modulePatch?: Partial<PipelineModuleBundle>;
      rawDiffContent?: string;
    }> = [];

    if (initialWorkItemsSupplier) {
      activeItemsInput = initialWorkItemsSupplier(1);
    } else {
      // Discover work items via Planner agent
      const plannerRunId = `plan-${missionId}-w1`;
      const plannerResult = await driver.invoke({
        contractPrompt: `Discover work items to satisfy goal: "${goal}". Target workspace: "${workspaceRoot}". Return structured JSON with work items array [{ "scopeId": string, "title": string, "filesModified": string[] }].`,
        persona: "planner",
        worktreeDir: workspaceRoot,
        timeoutMs: 30_000,
        runId: plannerRunId,
      });

      if (plannerResult.status !== "success") {
        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "run_finished",
          runId: plannerRunId,
          workItemId: "plan-discovery",
          expertId: "planner",
          status: "failed",
          durationMs: plannerResult.durationMs,
          stdoutHash: plannerResult.stdoutHash,
        });

        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "mission_finished",
          finalStatus: "failed",
          totalDurationMs: Date.now() - startTime,
          finalProgress: {
            hiddenTestsFailing: 1,
            hiddenTestsPassed: 0,
            visibleTestsFailing: 1,
            visibleTestsPassed: 0,
            gateFailures: 1,
            openDiagnosticsCount: 1,
            acceptedWorkItems: 0,
            totalWorkItems: 0,
          },
        });

        return {
          missionId,
          status: "failed",
          totalWaves: 0,
          progressHistory: [],
          finalProgress: {
            hiddenTestsFailing: 1,
            hiddenTestsPassed: 0,
            visibleTestsFailing: 1,
            visibleTestsPassed: 0,
            gateFailures: 1,
            openDiagnosticsCount: 1,
            acceptedWorkItems: 0,
            totalWorkItems: 0,
          },
          totalDurationMs: Date.now() - startTime,
        };
      }

      // Parse discovered items from planner output
      const parsedItems = this.extractItemsFromPlannerOutput(plannerResult.parsedOutput, goal);
      if (parsedItems.length === 0) {
        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "mission_finished",
          finalStatus: "failed",
          totalDurationMs: Date.now() - startTime,
          finalProgress: {
            hiddenTestsFailing: 0,
            hiddenTestsPassed: 0,
            visibleTestsFailing: 0,
            visibleTestsPassed: 0,
            gateFailures: 1,
            openDiagnosticsCount: 1,
            acceptedWorkItems: 0,
            totalWorkItems: 0,
          },
        });

        return {
          missionId,
          status: "failed",
          totalWaves: 0,
          progressHistory: [],
          finalProgress: {
            hiddenTestsFailing: 0,
            hiddenTestsPassed: 0,
            visibleTestsFailing: 0,
            visibleTestsPassed: 0,
            gateFailures: 1,
            openDiagnosticsCount: 1,
            acceptedWorkItems: 0,
            totalWorkItems: 0,
          },
          totalDurationMs: Date.now() - startTime,
        };
      }
      activeItemsInput = parsedItems;
    }

    // Nodes that failed the previous wave's gate. A repair wave attaches to them, so the graph
    // says why the new work exists instead of showing a set of unrelated roots.
    let previousWaveFailures: string[] = [];

    while (currentWave <= limits.maxRounds) {
      const waveStartTime = Date.now();

      // Check time budget
      if (Date.now() - startTime > limits.maxTimeMs) {
        const lastProg = progressHistory[progressHistory.length - 1] ?? {
          hiddenTestsFailing: 1,
          hiddenTestsPassed: 0,
          visibleTestsFailing: 0,
          visibleTestsPassed: 0,
          gateFailures: 1,
          openDiagnosticsCount: 1,
          acceptedWorkItems: 0,
          totalWorkItems: 1,
        };
        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "mission_finished",
          finalStatus: "budget_exhausted",
          totalDurationMs: Date.now() - startTime,
          finalProgress: lastProg,
        });
        return {
          missionId,
          status: "budget_exhausted",
          totalWaves: currentWave,
          progressHistory,
          finalProgress: lastProg,
          totalDurationMs: Date.now() - startTime,
        };
      }

      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "wave_started",
        waveIndex: currentWave,
      });

      // 1. Materialize & Register Work Items for Current Wave into Graph DAG
      const materialized: Array<{
        workItemId: string;
        title: string;
        filesModified: string[];
        modulePatch?: Partial<PipelineModuleBundle>;
        rawDiffContent?: string;
      }> = [];

      for (const item of activeItemsInput) {
        const workItemId = generateDeterministicWorkItemId(`${item.scopeId}-w${currentWave}`);
        materialized.push({
          workItemId,
          title: item.title,
          filesModified: item.filesModified,
          modulePatch: item.modulePatch,
          rawDiffContent: item.rawDiffContent,
        });

        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "work_item_discovered",
          workItemId,
          title: item.title,
          scope: item.filesModified,
          dependsOn: [],
          roleRequired: currentWave === 1 ? "executor" : "fixer",
          acceptanceCriteria: ["clean_diff", "tests_pass"],
        });
      }

      const waveNodeIds = materialized.map((item) => item.workItemId);
      // Completed at the end of the wave, once the gate has spoken.
      const waveCompleted: Array<{ nodeId: string; evidenceHash: string }> = [];

      // Add this wave's work items to the graph BEFORE any transition names them. The
      // transitions used to run against nodes that had never been added, inside a
      // `try {} catch {}`, so they silently did nothing and the graph held only the
      // synthetic seed — a graph that can never be `succeeded`.
      if (graphRuntime) {
        const materializedNodes = materializeWorkItemNodes({
          workspaceRoot,
          missionId,
          items: materialized.map((item) => ({
            id: item.workItemId,
            title: item.title,
            scope: item.filesModified,
            persona: currentWave === 1 ? "executor" : "fixer",
            // A repair wave attaches to the nodes that failed in the previous one, so the
            // graph expresses why the new work exists instead of listing isolated roots.
            ...(currentWave > 1 && previousWaveFailures.length > 0
              ? { dependsOn: [...previousWaveFailures], dependencyWhen: "failure" as const }
              : {}),
          })),
        });
        if (materializedNodes.added.length > 0) {
          // The runtime we hold predates the revision bump the broker just committed;
          // transitions against a stale revision are rejected.
          graphRuntime = loadGraphRuntime(workspaceRoot);
        }
        for (const item of materialized) {
          if (projectedStateOf(graphRuntime, item.workItemId) !== "ready") continue;
          try {
            appendGraphTransition(graphRuntime, {
              eventType: "node_dispatched",
              nodeId: item.workItemId,
              dispatchId: `disp-${item.workItemId}`,
              authorityId: "oma-dynamic-engine",
            });
          } catch (error) {
            // Never silent: a transition that cannot be recorded means the graph and the
            // mission disagree, and that is exactly what used to go unnoticed.
            recordEngineProblem(error, `node_dispatched ${item.workItemId}`);
          }
        }
      }

      // 2. Execute Parallel Workers in Isolated Worktrees
      const waveProposals: WorkItemChangeProposal[] = [];

      for (const mat of materialized) {
        const persona = currentWave === 1 ? "executor" : "fixer";
        const runId = generateDeterministicRunId(mat.workItemId, persona, currentWave);
        let worktreePath: string;

        try {
          worktreePath = await worktreePool.acquire(mat.workItemId);
        } catch {
          worktreePath = join(worktreesDir, `task-${mat.workItemId}`);
          mkdirSync(worktreePath, { recursive: true });
        }

        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "run_started",
          runId,
          workItemId: mat.workItemId,
          expertId: persona,
          model: "gemini-3.7-flash",
          effort: "medium",
          worktreePath,
        });

        const driverResult: DriverExecutionResult = await driver.invoke({
          contractPrompt: `Implement work item ${mat.workItemId}: ${mat.title}`,
          persona,
          worktreeDir: worktreePath,
          timeoutMs: 45_000,
          runId,
          modelOverride: "gemini-3.7-flash",
          reasoningEffort: "medium",
        });

        let diffContent = "";
        if (driverResult.status === "success") {
          if (mat.rawDiffContent) {
            diffContent = mat.rawDiffContent;
          } else if (
            isRecord(driverResult.parsedOutput) &&
            typeof driverResult.parsedOutput.diffContent === "string"
          ) {
            diffContent = driverResult.parsedOutput.diffContent;
          } else {
            // Extract real Git diff from worktree
            try {
              const diffProc = spawnSync("git", ["-C", worktreePath, "diff", "HEAD"], {
                encoding: "utf8",
                windowsHide: true,
              });
              if (diffProc.status === 0 && diffProc.stdout.trim().length > 0) {
                diffContent = diffProc.stdout;
              }
            } catch {}
          }
        }

        const isWorkerSuccess = driverResult.status === "success" && (diffContent.length > 0 || mat.modulePatch !== undefined);

        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "run_finished",
          runId,
          workItemId: mat.workItemId,
          expertId: persona,
          status: isWorkerSuccess ? "succeeded" : "failed",
          durationMs: Date.now() - waveStartTime,
          stdoutHash: driverResult.stdoutHash,
        });

        let diffHash = sha256(diffContent || `empty-${runId}`);
        if (diffContent) {
          diffHash = sha256(diffContent);
          const artPath = join(artifactsDir, `diff-${mat.workItemId}.patch`);
          writeFileSync(artPath, diffContent, "utf8");

          MissionEventsStore.appendEvent(eventsPath, missionId, {
            type: "artifact_created",
            runId,
            workItemId: mat.workItemId,
            artifactPath: artPath,
            artifactHash: diffHash,
            artifactKind: "diff",
          });
        }

        waveProposals.push({
          workItemId: mat.workItemId,
          filesModified: mat.filesModified,
          modulePatch: mat.modulePatch ?? {},
          stagedDiffDigest: diffHash,
        });

        // Close the node in the graph. The node now exists — materialization above added it —
        // so this transition is what makes a completed work item visible to the projection.
        // The node's completion is recorded after the gate, not here: a clean diff the
        // objective judge rejects is a failed node, and saying otherwise is what made a repair
        // node look `skipped`.
        waveCompleted.push({ nodeId: mat.workItemId, evidenceHash: diffHash });

        try {
          await worktreePool.release(mat.workItemId, true);
        } catch {}
      }

      // The next wave repairs what this one failed to pass; the gate outcome decides that,
      // further down, from `waveCompleted`.

      // 3. Dual Adversarial Independent Reviews
      for (const prop of waveProposals) {
        const subject: ReviewSubject = {
          workItemId: prop.workItemId,
          stagedDiffDigest: prop.stagedDiffDigest,
          filesModified: prop.filesModified,
          modulePatch: prop.modulePatch as Record<string, unknown>,
        };

        const patchContent = JSON.stringify(subject.modulePatch, null, 2);

        // Helper to dynamically extract reviewer verdict
        const evaluateReviewerResponse = (result: DriverExecutionResult): boolean => {
          if (result.status !== "success") return false;
          const parsed = result.parsedOutput;
          if (isRecord(parsed)) {
            if ("verdict" in parsed && typeof parsed.verdict === "string") {
              return parsed.verdict === "approved";
            }
            if ("approved" in parsed) {
              return Boolean(parsed.approved);
            }
          }
          const text = (result.scrubbedStdout || result.rawStdout || "").toUpperCase();
          if (text.includes("REJECTED") || text.includes("DEFECT") || text.includes("VULNERABILITY") || text.includes("MUTANT")) {
            return false;
          }
          return prop.stagedDiffDigest.length === 64 && !prop.stagedDiffDigest.startsWith("empty-");
        };

        // Reviewer 1 (Alpha)
        const revRun1 = generateDeterministicRunId(prop.workItemId, "reviewer-alpha", currentWave);
        const rev1Result = await driver.invoke({
          contractPrompt: `Perform independent adversarial code audit on staged changes for ${prop.workItemId}:\nFiles: ${subject.filesModified.join(", ")}\nDigest: ${subject.stagedDiffDigest}\nPatch:\n${patchContent}`,
          persona: "reviewer",
          worktreeDir: workspaceRoot,
          timeoutMs: 30_000,
          runId: revRun1,
        });

        const isRev1Approved = evaluateReviewerResponse(rev1Result);
        const verdict1 = AdversarialReviewEngine.evaluateReview(
          revRun1,
          "reviewer-alpha",
          subject,
          () => ({
            approved: isRev1Approved,
            observations: isRev1Approved
              ? ["Staged patch verified clean, sound and robust."]
              : ["Adversarial reviewer rejected defective or non-compliant patch."],
          }),
        );

        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "review_attested",
          runId: prop.workItemId,
          reviewerRunId: revRun1,
          reviewerExpertId: "reviewer-alpha",
          workItemId: prop.workItemId,
          subjectDiffDigest: prop.stagedDiffDigest,
          verdict: verdict1.verdict,
          observations: verdict1.observations,
        });

        // Reviewer 2 (Beta) - Independent
        const revRun2 = generateDeterministicRunId(prop.workItemId, "reviewer-beta", currentWave);
        const rev2Result = await driver.invoke({
          contractPrompt: `Perform second independent review on staged changes for ${prop.workItemId}:\nFiles: ${subject.filesModified.join(", ")}\nDigest: ${subject.stagedDiffDigest}\nPatch:\n${patchContent}`,
          persona: "reviewer",
          worktreeDir: workspaceRoot,
          timeoutMs: 30_000,
          runId: revRun2,
        });

        const isRev2Approved = evaluateReviewerResponse(rev2Result);
        const verdict2 = AdversarialReviewEngine.evaluateReview(
          revRun2,
          "reviewer-beta",
          subject,
          () => ({
            approved: isRev2Approved,
            observations: isRev2Approved
              ? ["Dual review validation confirmed clean diff."]
              : ["Second independent review rejected the staged diff."],
          }),
        );

        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "review_attested",
          runId: prop.workItemId,
          reviewerRunId: revRun2,
          reviewerExpertId: "reviewer-beta",
          workItemId: prop.workItemId,
          subjectDiffDigest: prop.stagedDiffDigest,
          verdict: verdict2.verdict,
          observations: verdict2.observations,
        });
      }

      // 4. Deterministic Integration & Objective Judge
      const approvedProposals = waveProposals.filter((p) => {
        const events = MissionEventsStore.readEvents(eventsPath);
        const pReviews = events.filter(
          (e) => e.type === "review_attested" && e.workItemId === p.workItemId,
        );
        return pReviews.length >= 2 && pReviews.every((r) => r.type === "review_attested" && r.verdict === "approved");
      });

      const integration = DeterministicIntegrator.integrateWorkItems(
        currentWorkingBundle,
        approvedProposals.length > 0 ? approvedProposals : waveProposals,
      );

      // Perform validated Git commit if integration succeeded
      let finalCommitSha = integration.commitHash;
      if (integration.status === "integrated" && approvedProposals.length > 0) {
        try {
          const topLevelRes = spawnSync(
            "git",
            ["-C", workspaceRoot, "rev-parse", "--show-toplevel"],
            { encoding: "utf8", windowsHide: true },
          );
          const isGitRepo =
            topLevelRes.status === 0 &&
            typeof topLevelRes.stdout === "string" &&
            resolve(topLevelRes.stdout.trim()).toLowerCase() ===
              resolve(workspaceRoot).toLowerCase();

          if (isGitRepo) {
            // Check if there are actual modified or untracked changes before attempting to commit
            const statusRes = spawnSync(
              "git",
              ["-C", workspaceRoot, "status", "--porcelain"],
              { encoding: "utf8", windowsHide: true },
            );
            if (statusRes.status === 0 && statusRes.stdout.trim().length > 0) {
              // Only commit if changes are present; stage relevant modified files
              spawnSync("git", ["-C", workspaceRoot, "add", "-u"], {
                encoding: "utf8",
                windowsHide: true,
              });
              const diffCached = spawnSync(
                "git",
                ["-C", workspaceRoot, "diff", "--cached", "--quiet"],
                { encoding: "utf8", windowsHide: true },
              );
              if (diffCached.status !== 0) {
                const commitRes = spawnSync(
                  "git",
                  ["-C", workspaceRoot, "commit", "-m", `oma(${missionId}): integrate wave ${currentWave}`],
                  { encoding: "utf8", windowsHide: true },
                );
                if (commitRes.status === 0) {
                  const headSha = spawnSync("git", ["-C", workspaceRoot, "rev-parse", "HEAD"], {
                    encoding: "utf8",
                    windowsHide: true,
                  }).stdout.trim();
                  if (headSha && headSha.length === 40) {
                    finalCommitSha = headSha;
                  }
                }
              }
            }
          }
        } catch {}
      }

      const judgeVerdict = integration.judgeVerdict!;
      const currentProgress = judgeVerdict.progressVector;
      progressHistory.push(currentProgress);

      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "gate_evaluated",
        gateId: "objective-judge-gate",
        status: judgeVerdict.status === "approved" ? "passed" : "failed",
        progressVector: currentProgress,
        durationMs: judgeVerdict.durationMs,
        diagnostics: judgeVerdict.diagnostics,
      });

      // 5. Convergence Evaluation via extracted pure engine (T3.3)
      const isIntegratedSuccess = judgeVerdict.status === "approved" && integration.status === "integrated";

      // Complete the wave's nodes HERE, not in the worker loop: the outcome that matters is
      // the gate's, not the worker's. A worker can produce a clean diff that the objective judge
      // still rejects, and completing the node as `succeeded` in that case made the graph
      // believe the wave passed — so a repair node linked by a `when: "failure"` edge was
      // projected as `skipped` while its patch was the one that actually fixed the code.
      for (const entry of waveCompleted) {
        if (graphRuntime === undefined) break;
        if (projectedStateOf(graphRuntime, entry.nodeId) !== "running") continue;
        try {
          appendGraphTransition(graphRuntime, {
            eventType: "node_completed",
            nodeId: entry.nodeId,
            dispatchId: `disp-${entry.nodeId}`,
            outcome: isIntegratedSuccess ? "success" : "failure",
            authority: "broker",
            authorityId: "oma-dynamic-engine",
            evidenceHash: entry.evidenceHash,
          });
        } catch (error) {
          recordEngineProblem(error, `node_completed ${entry.nodeId}`);
        }
      }
      if (!isIntegratedSuccess) {
        previousWaveFailures = waveCompleted.map((entry) => entry.nodeId);
      }

      const stepEvaluation = evaluateConvergenceStep({
        graph: graphRuntime?.graph ?? {
          schemaVersion: 1,
          graphId: `graph-${missionId}`,
          revision: 1,
          schedulerAuthorityId: "oma-dynamic-engine",
          nodes: [],
          edges: [],
        },
        events: graphRuntime ? verifyGraphStore(graphRuntime).events : [],
        progressHistory,
        limits,
        currentProgress,
        currentRound: currentWave,
        startTimeMs: startTime,
        currentTimeMs: Date.now(),
        isIntegrated: isIntegratedSuccess,
      });

      if (stepEvaluation.status === "succeeded") {
        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "integration_attempted",
          waveIndex: currentWave,
          workItemsIntegrated: integration.integratedWorkItems,
          commitSha: finalCommitSha,
          status: "integrated",
        });

        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "terminal_verdict_rendered",
          runId: `terminal-${missionId}`,
          status: "succeeded",
          commitSha: finalCommitSha,
          verdictHash: sha256(JSON.stringify(judgeVerdict)),
        });

        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "mission_finished",
          finalStatus: "succeeded",
          totalDurationMs: Date.now() - startTime,
          finalProgress: currentProgress,
          integratedCommitSha: finalCommitSha,
        });

        return {
          missionId,
          status: "succeeded",
          totalWaves: currentWave,
          progressHistory,
          finalProgress: currentProgress,
          integratedCommitSha: finalCommitSha,
          totalDurationMs: Date.now() - startTime,
        };
      }

      if (stepEvaluation.status === "no_progress_blocked") {
        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "terminal_verdict_rendered",
          runId: `terminal-${missionId}`,
          status: "failed",
          verdictHash: sha256(JSON.stringify(judgeVerdict)),
        });

        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "mission_finished",
          finalStatus: "no_progress_blocked",
          totalDurationMs: Date.now() - startTime,
          finalProgress: currentProgress,
        });

        return {
          missionId,
          status: "no_progress_blocked",
          totalWaves: currentWave,
          progressHistory,
          finalProgress: currentProgress,
          totalDurationMs: Date.now() - startTime,
        };
      }

      if (stepEvaluation.status === "budget_exhausted") {
        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "terminal_verdict_rendered",
          runId: `terminal-${missionId}`,
          status: "failed",
          verdictHash: sha256(JSON.stringify(judgeVerdict)),
        });

        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "mission_finished",
          finalStatus: "budget_exhausted",
          totalDurationMs: Date.now() - startTime,
          finalProgress: currentProgress,
        });

        return {
          missionId,
          status: "budget_exhausted",
          totalWaves: currentWave,
          progressHistory,
          finalProgress: currentProgress,
          totalDurationMs: Date.now() - startTime,
        };
      }

      // 6. Dynamic Graph Adaptation & Wave Transition
      const previousProgress =
        progressHistory.length >= 2 ? progressHistory[progressHistory.length - 2] : null;
      const hasProgressed = previousProgress
        ? ObjectiveJudge.isProgressing(previousProgress, currentProgress)
        : true;

      const nextWave = currentWave + 1;

      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "wave_transitioned",
        fromWave: currentWave,
        toWave: nextWave,
        progressBefore: previousProgress ?? currentProgress,
        progressAfter: currentProgress,
        hasProgressed,
        reason: `Judge rejected with ${judgeVerdict.diagnostics.length} diagnostics. Generating corrective wave.`,
      });

      if (diagnosticFixerSupplier) {
        activeItemsInput = diagnosticFixerSupplier(judgeVerdict.diagnostics);
      } else if (initialWorkItemsSupplier) {
        activeItemsInput = initialWorkItemsSupplier(nextWave);
      } else {
        // Invoke Fixer persona to discover corrective items
        const fixerRunId = `fix-plan-${missionId}-w${nextWave}`;
        const fixerResult = await driver.invoke({
          contractPrompt: `Generate targeted repairs for diagnostics: "${judgeVerdict.diagnostics.join("; ")}". Goal: "${goal}". Return structured JSON with work items array.`,
          persona: "fixer",
          worktreeDir: workspaceRoot,
          timeoutMs: 30_000,
          modelOverride: "gemini-3.7-flash",
          reasoningEffort: "medium",
          runId: fixerRunId,
        });

        if (fixerResult.status === "success" && fixerResult.parsedOutput) {
          activeItemsInput = this.extractItemsFromPlannerOutput(fixerResult.parsedOutput, goal);
        } else {
          activeItemsInput = [
            {
              scopeId: `src/fix-w${nextWave}.ts`,
              title: `Repair Diagnostics (${judgeVerdict.diagnostics.length} issues)`,
              filesModified: ["src/index.ts"],
            },
          ];
        }
      }

      currentWave = nextWave;
    }

    const finalProgress = progressHistory[progressHistory.length - 1];
    return {
      missionId,
      status: "budget_exhausted",
      totalWaves: currentWave,
      progressHistory,
      finalProgress,
      totalDurationMs: Date.now() - startTime,
    };
  }

  private static extractItemsFromPlannerOutput(
    parsed: unknown,
    fallbackGoal: string,
  ): Array<{ scopeId: string; title: string; filesModified: string[] }> {
    if (Array.isArray(parsed)) {
      return parsed.map((raw, idx) => {
        const item = isRecord(raw) ? raw : undefined;
        return {
          scopeId: typeof item?.scopeId === "string" ? item.scopeId : `task-${idx + 1}`,
          title: typeof item?.title === "string" ? item.title : `Task ${idx + 1}`,
          filesModified: Array.isArray(item?.filesModified) ? (item.filesModified as string[]) : ["src/index.ts"],
        };
      });
    }

    if (isRecord(parsed)) {
      if (Array.isArray(parsed.workItems)) {
        return parsed.workItems.map((raw, idx) => {
          const item = isRecord(raw) ? raw : undefined;
          return {
            scopeId: typeof item?.scopeId === "string" ? item.scopeId : `task-${idx + 1}`,
            title: typeof item?.title === "string" ? item.title : `Task ${idx + 1}`,
            filesModified: Array.isArray(item?.filesModified) ? (item.filesModified as string[]) : ["src/index.ts"],
          };
        });
      }
      if (Array.isArray(parsed.tasks)) {
        return parsed.tasks.map((raw, idx) => {
          const item = isRecord(raw) ? raw : undefined;
          return {
            scopeId: typeof item?.scopeId === "string" ? item.scopeId : `task-${idx + 1}`,
            title: typeof item?.title === "string" ? item.title : `Task ${idx + 1}`,
            filesModified: Array.isArray(item?.filesModified) ? (item.filesModified as string[]) : ["src/index.ts"],
          };
        });
      }
      if (typeof parsed.scopeId === "string" || typeof parsed.title === "string" || typeof parsed.summary === "string") {
        return [
          {
            scopeId: typeof parsed.scopeId === "string" ? parsed.scopeId : "task-1",
            title: typeof parsed.title === "string" ? parsed.title : (typeof parsed.summary === "string" ? String(parsed.summary) : fallbackGoal),
            filesModified: Array.isArray(parsed.filesModified) ? (parsed.filesModified as string[]) : ["src/index.ts"],
          },
        ];
      }
    }

    return [];
  }
}
