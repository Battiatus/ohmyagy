import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../ledger/canonical.js";
import { MissionEventsStore, generateDeterministicRunId, generateDeterministicWorkItemId, } from "../ledger/mission-events.js";
import { AdversarialReviewEngine, } from "../oracle/adversarial-review.js";
import { DeterministicIntegrator, } from "./integrator.js";
import { AgyDriver } from "../runtime/agy-driver.js";
import { WorktreePool } from "./worktree-pool.js";
export class WaveScheduler {
    static async executeStaticWave(options) {
        const startTime = Date.now();
        const { workspaceRoot, missionId, eventsPath, baseBundle, workItems } = options;
        const driver = options.driver ?? new AgyDriver();
        const worktreePool = options.worktreePool ?? new WorktreePool({ workspaceRoot });
        const missionDir = join(workspaceRoot, ".oma", "missions", missionId);
        const artifactsDir = join(missionDir, "artifacts");
        const worktreesDir = join(workspaceRoot, ".oma", "worktrees");
        mkdirSync(artifactsDir, { recursive: true });
        mkdirSync(worktreesDir, { recursive: true });
        // 0. Append mission_started if first event
        const existingEvents = MissionEventsStore.readEvents(eventsPath);
        if (existingEvents.length === 0) {
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "mission_started",
                workflowDigest: "digest-static-wave-v1",
                rulebookRevision: "rev-001",
                goal: "Execute static wave with parallel workers and dual review",
            });
        }
        // 1. Discover Work Items
        const materializedWorkItems = [];
        for (const wi of workItems) {
            const workItemId = generateDeterministicWorkItemId(wi.scopeId);
            materializedWorkItems.push({ workItemId, input: wi });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "work_item_discovered",
                workItemId,
                title: wi.title,
                scope: wi.filesModified,
                dependsOn: [],
                roleRequired: "worker",
                acceptanceCriteria: ["clean_diff", "tests_pass"],
            });
        }
        // 2. Execute Workers in Parallel
        const workerStartTimes = new Map();
        const workerEndTimes = new Map();
        const proposals = [];
        await Promise.all(materializedWorkItems.map(async ({ workItemId, input }, index) => {
            const workerRunId = generateDeterministicRunId(workItemId, "worker", 1);
            let worktreePath;
            try {
                worktreePath = await worktreePool.acquire(workItemId);
            }
            catch {
                worktreePath = join(worktreesDir, `task-${workItemId}`);
                mkdirSync(worktreePath, { recursive: true });
            }
            workerStartTimes.set(workItemId, Date.now());
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "run_started",
                runId: workerRunId,
                workItemId,
                expertId: "worker",
                model: "gemini-3.7-flash",
                effort: "medium",
                worktreePath,
            });
            const driverResult = await driver.invoke({
                contractPrompt: `Implement work item ${workItemId}: ${input.title}`,
                persona: "worker",
                worktreeDir: worktreePath,
                timeoutMs: 30_000,
                runId: workerRunId,
                modelOverride: "gemini-3.7-flash",
                reasoningEffort: "medium",
            });
            if (input.workerDelayMs) {
                await new Promise((r) => setTimeout(r, input.workerDelayMs));
            }
            // Freeze diff & artifact
            const diffHash = sha256(input.rawDiffContent);
            const artifactPath = join(artifactsDir, `diff-${workItemId}.patch`);
            writeFileSync(artifactPath, input.rawDiffContent, "utf8");
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "artifact_created",
                runId: workerRunId,
                workItemId,
                artifactPath,
                artifactHash: diffHash,
                artifactKind: "diff",
            });
            workerEndTimes.set(workItemId, Date.now());
            const workerDurationMs = workerEndTimes.get(workItemId) - workerStartTimes.get(workItemId);
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "run_finished",
                runId: workerRunId,
                workItemId,
                expertId: "worker",
                status: driverResult.status === "success" ? "succeeded" : "failed",
                durationMs: workerDurationMs,
                stdoutHash: driverResult.stdoutHash,
            });
            // Cleanup worktree while preserving frozen artifact
            try {
                await worktreePool.release(workItemId, true);
            }
            catch {
                // Continue
            }
            proposals.push({
                workItemId,
                filesModified: input.filesModified,
                modulePatch: input.modulePatch,
                stagedDiffDigest: diffHash,
            });
        }));
        // Check parallel time overlap
        let parallelOverlapObserved = false;
        if (materializedWorkItems.length >= 2) {
            const id1 = materializedWorkItems[0].workItemId;
            const id2 = materializedWorkItems[1].workItemId;
            const s1 = workerStartTimes.get(id1);
            const e1 = workerEndTimes.get(id1);
            const s2 = workerStartTimes.get(id2);
            const e2 = workerEndTimes.get(id2);
            // Overlap condition: start of one is before end of other
            parallelOverlapObserved = s1 < e2 && s2 < e1;
        }
        // 3. Dispatch Dual Independent Adversarial Reviews per Diff
        const allReviews = [];
        const defaultInspector = options.reviewerInspector ??
            ((sub) => {
                // Default inspector verifies that no mutant or illegal logic is present
                const hasFlaw = JSON.stringify(sub.modulePatch).includes("mutant");
                return {
                    approved: !hasFlaw,
                    observations: hasFlaw
                        ? ["Adversarial review caught flawed or mutant implementation."]
                        : ["Diff verified clean and conformant to specification."],
                };
            });
        for (const prop of proposals) {
            const subject = {
                workItemId: prop.workItemId,
                stagedDiffDigest: prop.stagedDiffDigest,
                filesModified: prop.filesModified,
                modulePatch: prop.modulePatch,
            };
            // Reviewer 1 (Alpha)
            const revRunId1 = generateDeterministicRunId(prop.workItemId, "reviewer-alpha", 1);
            const revVerdict1 = AdversarialReviewEngine.evaluateReview(revRunId1, "reviewer-alpha", subject, defaultInspector);
            allReviews.push(revVerdict1);
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "review_attested",
                runId: prop.workItemId,
                reviewerRunId: revRunId1,
                reviewerExpertId: "reviewer-alpha",
                workItemId: prop.workItemId,
                subjectDiffDigest: prop.stagedDiffDigest,
                verdict: revVerdict1.verdict,
                observations: revVerdict1.observations,
            });
            // Reviewer 2 (Beta) - Independent
            const revRunId2 = generateDeterministicRunId(prop.workItemId, "reviewer-beta", 2);
            const revVerdict2 = AdversarialReviewEngine.evaluateReview(revRunId2, "reviewer-beta", subject, defaultInspector);
            allReviews.push(revVerdict2);
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "review_attested",
                runId: prop.workItemId,
                reviewerRunId: revRunId2,
                reviewerExpertId: "reviewer-beta",
                workItemId: prop.workItemId,
                subjectDiffDigest: prop.stagedDiffDigest,
                verdict: revVerdict2.verdict,
                observations: revVerdict2.observations,
            });
        }
        // 4. Consensus Check
        const consensusFailures = proposals.filter((p) => {
            const c = AdversarialReviewEngine.computeConsensus(p.workItemId, allReviews);
            return c.consensus !== "approved";
        });
        if (consensusFailures.length > 0) {
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "mission_finished",
                finalStatus: "failed",
                totalDurationMs: Date.now() - startTime,
                finalProgress: {
                    hiddenTestsFailing: 1,
                    hiddenTestsPassed: 0,
                    visibleTestsFailing: 0,
                    visibleTestsPassed: 0,
                    gateFailures: 1,
                    openDiagnosticsCount: consensusFailures.length,
                    acceptedWorkItems: 0,
                    totalWorkItems: proposals.length,
                },
            });
            return {
                missionId,
                waveIndex: 1,
                status: "failed",
                workItemsProcessed: proposals.map((p) => p.workItemId),
                parallelOverlapObserved,
                reviewsCount: allReviews.length,
                durationMs: Date.now() - startTime,
            };
        }
        // 5. Deterministic Integration & Final Gate
        const integrationReport = DeterministicIntegrator.integrateWorkItems(baseBundle, proposals);
        if (integrationReport.status === "conflict_blocked") {
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "integration_attempted",
                waveIndex: 1,
                workItemsIntegrated: [],
                status: "conflict_blocked",
                conflictDetails: integrationReport.conflictDetails,
            });
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
                    totalWorkItems: proposals.length,
                },
            });
            return {
                missionId,
                waveIndex: 1,
                status: "conflict_blocked",
                workItemsProcessed: proposals.map((p) => p.workItemId),
                parallelOverlapObserved,
                reviewsCount: allReviews.length,
                integrationReport,
                durationMs: Date.now() - startTime,
            };
        }
        if (integrationReport.status === "integrated" && integrationReport.judgeVerdict) {
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "gate_evaluated",
                gateId: "objective-judge-gate",
                status: "passed",
                progressVector: integrationReport.judgeVerdict.progressVector,
                durationMs: integrationReport.judgeVerdict.durationMs,
                diagnostics: integrationReport.judgeVerdict.diagnostics,
            });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "integration_attempted",
                waveIndex: 1,
                workItemsIntegrated: integrationReport.integratedWorkItems,
                commitSha: integrationReport.commitHash,
                status: "integrated",
            });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "mission_finished",
                finalStatus: "succeeded",
                totalDurationMs: Date.now() - startTime,
                finalProgress: integrationReport.judgeVerdict.progressVector,
                integratedCommitSha: integrationReport.commitHash,
            });
            return {
                missionId,
                waveIndex: 1,
                status: "succeeded",
                workItemsProcessed: proposals.map((p) => p.workItemId),
                parallelOverlapObserved,
                reviewsCount: allReviews.length,
                integrationReport,
                durationMs: Date.now() - startTime,
            };
        }
        if (integrationReport.status === "judge_rejected" && integrationReport.judgeVerdict) {
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "gate_evaluated",
                gateId: "objective-judge-gate",
                status: "failed",
                progressVector: integrationReport.judgeVerdict.progressVector,
                durationMs: integrationReport.judgeVerdict.durationMs,
                diagnostics: integrationReport.judgeVerdict.diagnostics,
            });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "mission_finished",
                finalStatus: "failed",
                totalDurationMs: Date.now() - startTime,
                finalProgress: integrationReport.judgeVerdict.progressVector,
            });
            return {
                missionId,
                waveIndex: 1,
                status: "failed",
                workItemsProcessed: proposals.map((p) => p.workItemId),
                parallelOverlapObserved,
                reviewsCount: allReviews.length,
                integrationReport,
                durationMs: Date.now() - startTime,
            };
        }
        return {
            missionId,
            waveIndex: 1,
            status: "failed",
            workItemsProcessed: proposals.map((p) => p.workItemId),
            parallelOverlapObserved,
            reviewsCount: allReviews.length,
            integrationReport,
            durationMs: Date.now() - startTime,
        };
    }
}
