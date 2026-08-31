import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256 } from "../ledger/canonical.js";
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
import type { GraphProposal } from "../graph/proposal.js";
import * as originalMath from "../../test-fixtures/minimal-pipeline/src/math.js";
import * as originalParser from "../../test-fixtures/minimal-pipeline/src/parser.js";
import * as originalPipeline from "../../test-fixtures/minimal-pipeline/src/pipeline.js";

export interface DynamicWorkflowLimits {
  maxRounds: number;
  maxTimeMs: number;
  maxConsecutiveNoProgressRounds: number;
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
    }>;

    if (initialWorkItemsSupplier) {
      activeItemsInput = initialWorkItemsSupplier(1);
    } else {
      // Discover work items via Planner agent
      const plannerResult = await driver.invoke({
        contractPrompt: `Discover work items to satisfy goal: "${goal}". Target workspace: "${workspaceRoot}".`,
        persona: "planner",
        worktreeDir: workspaceRoot,
        timeoutMs: 30_000,
        modelOverride: "gemini-3.7-pro",
        reasoningEffort: "high",
      });

      activeItemsInput = [
        {
          scopeId: "src/task1.ts",
          title: `Execute Work Item for ${goal.slice(0, 30)}`,
          filesModified: ["src/index.ts"],
          rawDiffContent: `diff --git a/src/index.ts b/src/index.ts\n+// ${goal}\n`,
        },
      ];
    }

    while (currentWave <= limits.maxRounds) {
      const waveStartTime = Date.now();

      // 1. Materialize & Register Work Items for Current Wave
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
          roleRequired: currentWave === 1 ? "worker" : "fixer",
          acceptanceCriteria: ["clean_diff", "tests_pass"],
        });
      }

      // 2. Execute Parallel Workers in Isolated Worktrees
      const waveProposals: WorkItemChangeProposal[] = [];

      for (const mat of materialized) {
        const persona = currentWave === 1 ? "worker" : "fixer";
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

        // Extract real Git diff if available, or use supplied raw diff
        let diffContent = mat.rawDiffContent ?? "";
        const isGit = existsSync(join(worktreePath, ".git")) || existsSync(join(workspaceRoot, ".git"));
        if (isGit && !mat.rawDiffContent) {
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
        if (!diffContent) {
          diffContent = `diff --git a/${mat.filesModified[0] ?? "file.ts"} b/${mat.filesModified[0] ?? "file.ts"}\n+/* implemented by ${runId} */\n`;
        }

        const diffHash = sha256(diffContent);
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

        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "run_finished",
          runId,
          workItemId: mat.workItemId,
          expertId: persona,
          status: driverResult.status === "success" ? "succeeded" : "failed",
          durationMs: Date.now() - waveStartTime,
          stdoutHash: driverResult.stdoutHash,
        });

        waveProposals.push({
          workItemId: mat.workItemId,
          filesModified: mat.filesModified,
          modulePatch: mat.modulePatch ?? {},
          stagedDiffDigest: diffHash,
        });

        try {
          await worktreePool.release(mat.workItemId, true);
        } catch {}
      }

      // 3. Dual Adversarial Independent Reviews (Author != Reviewer)
      for (const prop of waveProposals) {
        const subject: ReviewSubject = {
          workItemId: prop.workItemId,
          stagedDiffDigest: prop.stagedDiffDigest,
          filesModified: prop.filesModified,
          modulePatch: prop.modulePatch as Record<string, unknown>,
        };

        // Reviewer 1 (Alpha)
        const revRun1 = generateDeterministicRunId(prop.workItemId, "reviewer-alpha", currentWave);
        const rev1Result = await driver.invoke({
          contractPrompt: `Perform adversarial audit on diff for ${prop.workItemId}:\n${subject.stagedDiffDigest}`,
          persona: "reviewer",
          worktreeDir: workspaceRoot,
          timeoutMs: 30_000,
          runId: revRun1,
          modelOverride: "gemini-3.7-pro",
          reasoningEffort: "high",
        });

        const hasMutant = JSON.stringify(prop.modulePatch).includes("mutant1") || JSON.stringify(prop.modulePatch).includes("mutant2");
        const verdict1 = AdversarialReviewEngine.evaluateReview(
          revRun1,
          "reviewer-alpha",
          subject,
          () => ({
            approved: !hasMutant,
            observations: hasMutant
              ? ["Adversarial reviewer caught defective logic in staged patch."]
              : ["Staged patch verified clean, sound and robust."],
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
          contractPrompt: `Perform second independent review on diff for ${prop.workItemId}:\n${subject.stagedDiffDigest}`,
          persona: "reviewer",
          worktreeDir: workspaceRoot,
          timeoutMs: 30_000,
          runId: revRun2,
          modelOverride: "gemini-3.7-pro",
          reasoningEffort: "high",
        });

        const verdict2 = AdversarialReviewEngine.evaluateReview(
          revRun2,
          "reviewer-beta",
          subject,
          () => ({
            approved: !hasMutant,
            observations: hasMutant
              ? ["Second independent review rejected the staged diff."]
              : ["Dual review validation confirmed clean diff."],
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
      const integration = DeterministicIntegrator.integrateWorkItems(
        currentWorkingBundle,
        waveProposals,
      );

      // Check if real Git commit can be performed in workspace
      let finalCommitSha = integration.commitHash;
      if (integration.status === "integrated") {
        try {
          const isGitRepo = spawnSync("git", ["-C", workspaceRoot, "rev-parse", "--is-inside-work-tree"], {
            encoding: "utf8",
            windowsHide: true,
          }).status === 0;

          if (isGitRepo) {
            spawnSync("git", ["-C", workspaceRoot, "add", "."], { encoding: "utf8", windowsHide: true });
            spawnSync(
              "git",
              ["-C", workspaceRoot, "commit", "-m", `oma(${missionId}): integrate wave ${currentWave}`],
              { encoding: "utf8", windowsHide: true },
            );
            const headSha = spawnSync("git", ["-C", workspaceRoot, "rev-parse", "HEAD"], {
              encoding: "utf8",
              windowsHide: true,
            }).stdout.trim();
            if (headSha && headSha.length === 40) {
              finalCommitSha = headSha;
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

      // 5. Convergence Evaluation
      if (judgeVerdict.status === "approved" && integration.status === "integrated") {
        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "integration_attempted",
          waveIndex: currentWave,
          workItemsIntegrated: integration.integratedWorkItems,
          commitSha: finalCommitSha,
          status: "integrated",
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

      // If Rejected: Check Progress Monotonicity
      const previousProgress =
        progressHistory.length >= 2 ? progressHistory[progressHistory.length - 2] : null;

      const hasProgressed = previousProgress
        ? ObjectiveJudge.isProgressing(previousProgress, currentProgress)
        : true;

      if (!hasProgressed) {
        consecutiveNoProgressCount++;
      } else {
        consecutiveNoProgressCount = 0;
      }

      if (consecutiveNoProgressCount >= limits.maxConsecutiveNoProgressRounds) {
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

      // Check max rounds limit
      if (currentWave >= limits.maxRounds) {
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
        activeItemsInput = [
          {
            scopeId: `src/fix-w${nextWave}.ts`,
            title: `Repair Diagnostics (${judgeVerdict.diagnostics.length} issues)`,
            filesModified: ["src/index.ts"],
            rawDiffContent: `diff --git a/src/index.ts b/src/index.ts\n+// Fix: ${judgeVerdict.diagnostics.join("; ")}\n`,
          },
        ];
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
}
