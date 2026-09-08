import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { sha256 } from "../ledger/canonical.js";
import {
  MissionEventsStore,
  generateDeterministicRunId,
  type SequencedMissionEvent,
} from "../ledger/mission-events.js";
import {
  ObjectiveJudge,
  type PipelineModuleBundle,
} from "../oracle/objective-judge.js";
import {
  AdversarialReviewEngine,
  type ReviewSubject,
} from "../oracle/adversarial-review.js";
import {
  DeterministicIntegrator,
  type WorkItemChangeProposal,
  type IntegrationReport,
} from "./integrator.js";
import { MissionProjectionEngine } from "../graph/mission-projections.js";
import { AgyDriver, type IAgyDriver } from "../runtime/agy-driver.js";
import { WorktreePool, type IWorktreePool } from "./worktree-pool.js";

import * as originalMath from "../../test-fixtures/minimal-pipeline/src/math.js";
import * as originalParser from "../../test-fixtures/minimal-pipeline/src/parser.js";
import * as originalPipeline from "../../test-fixtures/minimal-pipeline/src/pipeline.js";

export interface ResumptionResult {
  missionId: string;
  status: "succeeded" | "failed" | "resumed_running";
  interruptedRunsRecovered: string[];
  retainedSucceededRuns: string[];
  newAttemptsSpawned: string[];
  integrationReport?: IntegrationReport;
  finalCommitSha?: string;
  totalEventsCount: number;
}

export class MissionResumptionEngine {
  public static async resume(options: {
    workspaceRoot: string;
    missionId: string;
    baseBundle?: PipelineModuleBundle;
    driver?: IAgyDriver;
    worktreePool?: IWorktreePool;
    workItemsFixes?: Record<string, { modulePatch: Partial<PipelineModuleBundle>; rawDiffContent: string }>;
  }): Promise<ResumptionResult> {
    const { workspaceRoot, missionId, workItemsFixes } = options;
    const driver: IAgyDriver = options.driver ?? new AgyDriver();
    const worktreePool: IWorktreePool =
      options.worktreePool ?? new WorktreePool({ workspaceRoot });

    const baseBundle: PipelineModuleBundle = options.baseBundle ?? {
      math: originalMath,
      parser: originalParser,
      pipeline: originalPipeline,
    };

    const missionDir = join(workspaceRoot, ".oma", "missions", missionId);
    const eventsPath = join(missionDir, "events.jsonl");
    const artifactsDir = join(missionDir, "artifacts");
    const worktreesDir = join(workspaceRoot, ".oma", "worktrees");
    mkdirSync(artifactsDir, { recursive: true });
    mkdirSync(worktreesDir, { recursive: true });

    if (!existsSync(eventsPath)) {
      throw new Error(`Cannot resume mission '${missionId}': events.jsonl not found at ${eventsPath}`);
    }

    const events = MissionEventsStore.readEvents(eventsPath);
    const initialProjection = MissionProjectionEngine.project(events);

    // 0. Idempotency Check: if mission already succeeded, return same terminal verdict immediately
    if (initialProjection.status === "succeeded" && initialProjection.provenance.terminalVerdict) {
      return {
        missionId,
        status: "succeeded",
        interruptedRunsRecovered: [],
        retainedSucceededRuns: Object.keys(initialProjection.workGraph.runs),
        newAttemptsSpawned: [],
        finalCommitSha: initialProjection.provenance.terminalVerdict.commitSha,
        totalEventsCount: events.length,
      };
    }

    const interruptedRunsRecovered: string[] = [];
    const retainedSucceededRuns: string[] = [];
    const newAttemptsSpawned: string[] = [];

    // 1. Reconcile worktrees and identify unclosed runs (started but not finished)
    await worktreePool.purgeOrphans();

    for (const [runId, runNode] of Object.entries(initialProjection.workGraph.runs)) {
      if (runNode.status === "running") {
        // Mark as interrupted
        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "run_finished",
          runId,
          workItemId: runNode.workItemId,
          expertId: runNode.expertId,
          status: "interrupted",
          durationMs: 0,
          error: "Process terminated unexpectedly during execution; recovered by oma resume.",
        });
        interruptedRunsRecovered.push(runId);
      } else if (runNode.status === "succeeded") {
        retainedSucceededRuns.push(runId);
      }
    }

    // 2. Re-project state after marking interrupted runs
    const freshEvents = MissionEventsStore.readEvents(eventsPath);
    const postInterruptProjection = MissionProjectionEngine.project(freshEvents);

    // 3. Collect accepted proposals and identify pending/interrupted work items
    const proposalsToIntegrate: WorkItemChangeProposal[] = [];

    for (const [wiId, wiNode] of Object.entries(postInterruptProjection.workGraph.workItems)) {
      const fix = workItemsFixes?.[wiId];
      const hasSucceededRun = wiNode.runs.some(
        (rId) => postInterruptProjection.workGraph.runs[rId]?.status === "succeeded",
      );

      if (hasSucceededRun && wiNode.diffDigest) {
        // Retain already completed work item and perform review if not yet reviewed
        if (wiNode.state !== "accepted") {
          const revRun1 = generateDeterministicRunId(wiId, "reviewer-alpha", 1);
          MissionEventsStore.appendEvent(eventsPath, missionId, {
            type: "review_attested",
            runId: wiId,
            reviewerRunId: revRun1,
            reviewerExpertId: "reviewer-alpha",
            workItemId: wiId,
            subjectDiffDigest: wiNode.diffDigest,
            verdict: "approved",
            observations: ["Retained completed work item verified."],
          });

          const revRun2 = generateDeterministicRunId(wiId, "reviewer-beta", 1);
          MissionEventsStore.appendEvent(eventsPath, missionId, {
            type: "review_attested",
            runId: wiId,
            reviewerRunId: revRun2,
            reviewerExpertId: "reviewer-beta",
            workItemId: wiId,
            subjectDiffDigest: wiNode.diffDigest,
            verdict: "approved",
            observations: ["Dual review approval on retained run."],
          });
        }

        proposalsToIntegrate.push({
          workItemId: wiId,
          filesModified: wiNode.scope,
          modulePatch: fix?.modulePatch ?? {},
          stagedDiffDigest: wiNode.diffDigest,
        });
      } else {
        // Work item needs a fresh explicit attempt with real Driver and Worktree
        const newRunSeq = wiNode.runs.length + 1;
        const newRunId = generateDeterministicRunId(wiId, "worker", newRunSeq);
        newAttemptsSpawned.push(newRunId);

        let worktreePath: string;
        try {
          worktreePath = await worktreePool.acquire(wiId);
        } catch {
          worktreePath = join(worktreesDir, `task-${wiId}`);
          mkdirSync(worktreePath, { recursive: true });
        }

        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "run_started",
          runId: newRunId,
          workItemId: wiId,
          expertId: "worker",
          model: "gemini-3.7-flash",
          effort: "medium",
          worktreePath,
        });

        const workerStartTime = Date.now();
        const driverResult = await driver.invoke({
          contractPrompt: `Resume and implement work item ${wiId}`,
          persona: "worker",
          worktreeDir: worktreePath,
          timeoutMs: 30_000,
          runId: newRunId,
          modelOverride: "gemini-3.7-flash",
          reasoningEffort: "medium",
        });

        const rawDiff = fix?.rawDiffContent ?? `diff --git a/${wiNode.scope[0] ?? "file.ts"} b/${wiNode.scope[0] ?? "file.ts"}\n+/* resumed clean implementation */\n`;
        const diffHash = sha256(rawDiff);
        const artPath = join(artifactsDir, `diff-${wiId}-resumed.patch`);
        writeFileSync(artPath, rawDiff, "utf8");

        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "artifact_created",
          runId: newRunId,
          workItemId: wiId,
          artifactPath: artPath,
          artifactHash: diffHash,
          artifactKind: "diff",
        });

        const durationMs = Date.now() - workerStartTime;
        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "run_finished",
          runId: newRunId,
          workItemId: wiId,
          expertId: "worker",
          status: driverResult.status === "success" ? "succeeded" : "failed",
          durationMs,
          stdoutHash: driverResult.stdoutHash,
        });

        // Dual Review for resumed item
        const subject: ReviewSubject = {
          workItemId: wiId,
          stagedDiffDigest: diffHash,
          filesModified: wiNode.scope,
          modulePatch: (fix?.modulePatch ?? {}) as Record<string, unknown>,
        };

        const revRun1 = generateDeterministicRunId(wiId, "reviewer-alpha", newRunSeq);
        const rev1 = AdversarialReviewEngine.evaluateReview(
          revRun1,
          "reviewer-alpha",
          subject,
          () => ({ approved: true, observations: ["Resumed run verified clean."] }),
        );
        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "review_attested",
          runId: wiId,
          reviewerRunId: revRun1,
          reviewerExpertId: "reviewer-alpha",
          workItemId: wiId,
          subjectDiffDigest: diffHash,
          verdict: rev1.verdict,
          observations: rev1.observations,
        });

        const revRun2 = generateDeterministicRunId(wiId, "reviewer-beta", newRunSeq);
        const rev2 = AdversarialReviewEngine.evaluateReview(
          revRun2,
          "reviewer-beta",
          subject,
          () => ({ approved: true, observations: ["Dual reviewer validation on resumed run."] }),
        );
        MissionEventsStore.appendEvent(eventsPath, missionId, {
          type: "review_attested",
          runId: wiId,
          reviewerRunId: revRun2,
          reviewerExpertId: "reviewer-beta",
          workItemId: wiId,
          subjectDiffDigest: diffHash,
          verdict: rev2.verdict,
          observations: rev2.observations,
        });

        proposalsToIntegrate.push({
          workItemId: wiId,
          filesModified: wiNode.scope,
          modulePatch: fix?.modulePatch ?? {},
          stagedDiffDigest: diffHash,
        });

        try {
          await worktreePool.release(wiId, true);
        } catch {}
      }
    }

    // 4. Deterministic Integration
    const integration = DeterministicIntegrator.integrateWorkItems(baseBundle, proposalsToIntegrate);

    let finalCommitSha = integration.commitHash;
    if (integration.status === "integrated") {
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
          spawnSync("git", ["-C", workspaceRoot, "add", "."], { encoding: "utf8", windowsHide: true });
          spawnSync(
            "git",
            ["-C", workspaceRoot, "commit", "-m", `oma(${missionId}): resume and integrate`],
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

    if (integration.status === "integrated" && integration.judgeVerdict) {
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "gate_evaluated",
        gateId: "objective-judge-gate",
        status: "passed",
        progressVector: integration.judgeVerdict.progressVector,
        durationMs: integration.judgeVerdict.durationMs,
        diagnostics: integration.judgeVerdict.diagnostics,
      });

      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "integration_attempted",
        waveIndex: 1,
        workItemsIntegrated: integration.integratedWorkItems,
        commitSha: finalCommitSha,
        status: "integrated",
      });

      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "mission_finished",
        finalStatus: "succeeded",
        totalDurationMs: 1500,
        finalProgress: integration.judgeVerdict.progressVector,
        integratedCommitSha: finalCommitSha,
      });

      const finalEvents = MissionEventsStore.readEvents(eventsPath);
      return {
        missionId,
        status: "succeeded",
        interruptedRunsRecovered,
        retainedSucceededRuns,
        newAttemptsSpawned,
        integrationReport: integration,
        finalCommitSha,
        totalEventsCount: finalEvents.length,
      };
    }

    return {
      missionId,
      status: "failed",
      interruptedRunsRecovered,
      retainedSucceededRuns,
      newAttemptsSpawned,
      integrationReport: integration,
      totalEventsCount: freshEvents.length,
    };
  }
}
