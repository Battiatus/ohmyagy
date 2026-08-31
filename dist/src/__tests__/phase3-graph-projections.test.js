import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { MissionProjectionEngine, } from "../graph/mission-projections.js";
import { MissionEventsStore, generateDeterministicRunId, generateDeterministicWorkItemId, } from "../ledger/mission-events.js";
import { runOmaCli } from "../cli/oma-cli.js";
describe("Phase 3 — Projections Graph Engineering, Surfaces & Gate Observable", () => {
    it("Gate 3.1: Reconstruct projection.json identically from events.jsonl after deletion", () => {
        const testDir = join(process.cwd(), ".oma", "test-phase3-projection");
        const eventsPath = join(testDir, "events.jsonl");
        const projectionPath = join(testDir, "projection.json");
        rmSync(testDir, { recursive: true, force: true });
        mkdirSync(testDir, { recursive: true });
        try {
            const missionId = "mission-phase3-recon";
            const wiId = generateDeterministicWorkItemId("src/pipeline.ts");
            const runId = generateDeterministicRunId(wiId, "worker", 1);
            const revRunId1 = generateDeterministicRunId(wiId, "reviewer-alpha", 1);
            const revRunId2 = generateDeterministicRunId(wiId, "reviewer-beta", 2);
            // Populate events
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "mission_started",
                workflowDigest: "digest-phase3-v1",
                rulebookRevision: "rev-001",
                goal: "Test projection idempotence",
            });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "work_item_discovered",
                workItemId: wiId,
                title: "Build Pipeline",
                scope: ["src/pipeline.ts"],
                dependsOn: [],
                roleRequired: "worker",
                acceptanceCriteria: ["evaluatePipeline"],
            });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "run_started",
                runId,
                workItemId: wiId,
                expertId: "worker",
                model: "gemini-3.7-flash",
                effort: "medium",
            });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "artifact_created",
                runId,
                workItemId: wiId,
                artifactPath: "artifacts/diff-pipe.patch",
                artifactHash: "1".repeat(64),
                artifactKind: "diff",
            });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "run_finished",
                runId,
                workItemId: wiId,
                expertId: "worker",
                status: "succeeded",
                durationMs: 950,
            });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "review_attested",
                runId: wiId,
                reviewerRunId: revRunId1,
                reviewerExpertId: "reviewer-alpha",
                workItemId: wiId,
                subjectDiffDigest: "1".repeat(64),
                verdict: "approved",
                observations: ["Clean architecture"],
            });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "review_attested",
                runId: wiId,
                reviewerRunId: revRunId2,
                reviewerExpertId: "reviewer-beta",
                workItemId: wiId,
                subjectDiffDigest: "1".repeat(64),
                verdict: "approved",
                observations: ["Approved independent verification"],
            });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "gate_evaluated",
                gateId: "pipeline-gate",
                status: "passed",
                progressVector: {
                    hiddenTestsFailing: 0,
                    hiddenTestsPassed: 5,
                    visibleTestsFailing: 0,
                    visibleTestsPassed: 3,
                    gateFailures: 0,
                    openDiagnosticsCount: 0,
                    acceptedWorkItems: 1,
                    totalWorkItems: 1,
                },
                durationMs: 12,
                diagnostics: [],
            });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "mission_finished",
                finalStatus: "succeeded",
                totalDurationMs: 1200,
                finalProgress: {
                    hiddenTestsFailing: 0,
                    hiddenTestsPassed: 5,
                    visibleTestsFailing: 0,
                    visibleTestsPassed: 3,
                    gateFailures: 0,
                    openDiagnosticsCount: 0,
                    acceptedWorkItems: 1,
                    totalWorkItems: 1,
                },
                integratedCommitSha: "c".repeat(64),
            });
            // 1. First projection generation & persistence
            const eventsInitial = MissionEventsStore.readEvents(eventsPath);
            const proj1 = MissionProjectionEngine.project(eventsInitial);
            MissionProjectionEngine.persistProjection(projectionPath, proj1);
            const content1 = readFileSync(projectionPath, "utf8");
            // 2. Delete projection.json
            unlinkSync(projectionPath);
            assert.ok(!existsSync(projectionPath));
            // 3. Reconstruct projection from events.jsonl
            const eventsFresh = MissionEventsStore.readEvents(eventsPath);
            const proj2 = MissionProjectionEngine.project(eventsFresh);
            MissionProjectionEngine.persistProjection(projectionPath, proj2);
            const content2 = readFileSync(projectionPath, "utf8");
            // 4. Verify identical byte-for-byte reconstruction and digest matching
            assert.equal(content1, content2);
            assert.equal(proj1.projectionDigest, proj2.projectionDigest);
            assert.equal(proj2.status, "succeeded");
            assert.equal(proj2.workGraph.acceptedSet.length, 1);
            assert.equal(proj2.workGraph.acceptedSet[0], wiId);
        }
        finally {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
    it("Gate 3.2: oma status --json exposes mission, wave, queues, runs, models, gates and terminal verdict", async () => {
        const testDir = join(process.cwd(), ".oma", "test-phase3-cli");
        const missionId = "mission-cli-status-test";
        const missionDir = join(testDir, ".oma", "missions", missionId);
        mkdirSync(missionDir, { recursive: true });
        const eventsPath = join(missionDir, "events.jsonl");
        try {
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "mission_started",
                workflowDigest: "digest-status-test",
                rulebookRevision: "rev-001",
                goal: "CLI status verification",
            });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "work_item_discovered",
                workItemId: "work-item-1",
                title: "Test CLI Status",
                scope: ["src/test.ts"],
                dependsOn: [],
                roleRequired: "worker",
                acceptanceCriteria: ["pass"],
            });
            // Capture stdout
            const originalLog = console.log;
            let capturedJson = "";
            console.log = (msg) => {
                capturedJson = msg;
            };
            try {
                const exitCode = await runOmaCli(["status", "--json", "--mission", missionId], testDir);
                assert.equal(exitCode, 0);
                const parsed = JSON.parse(capturedJson);
                assert.equal(parsed.missionId, missionId);
                assert.equal(parsed.status, "in_progress");
                assert.equal(parsed.currentWave, 1);
                assert.ok(parsed.workGraph.readySet.includes("work-item-1"));
                assert.ok(parsed.capabilities.experts.worker.modelSlug.length > 0);
                assert.ok(parsed.workGraph.relations.length > 0);
            }
            finally {
                console.log = originalLog;
            }
        }
        finally {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
    it("Gate 3.3: Self-certification refusal — worker exit code 0 or claim alone never marks work item accepted", () => {
        const testDir = join(process.cwd(), ".oma", "test-phase3-nocert");
        const eventsPath = join(testDir, "events.jsonl");
        rmSync(testDir, { recursive: true, force: true });
        mkdirSync(testDir, { recursive: true });
        try {
            const missionId = "mission-no-self-cert";
            const wiId = generateDeterministicWorkItemId("src/unverified.ts");
            const runId = generateDeterministicRunId(wiId, "worker", 1);
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "mission_started",
                workflowDigest: "digest-v1",
                rulebookRevision: "rev-001",
                goal: "Prove no self-certification",
            });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "work_item_discovered",
                workItemId: wiId,
                title: "Unverified Task",
                scope: ["src/unverified.ts"],
                dependsOn: [],
                roleRequired: "worker",
                acceptanceCriteria: ["all"],
            });
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "run_started",
                runId,
                workItemId: wiId,
                expertId: "worker",
                model: "gemini-3.7-flash",
                effort: "medium",
            });
            // Worker finishes with exit code 0 / "succeeded" claim
            MissionEventsStore.appendEvent(eventsPath, missionId, {
                type: "run_finished",
                runId,
                workItemId: wiId,
                expertId: "worker",
                status: "succeeded",
                durationMs: 500,
                stdoutHash: "f".repeat(64),
            });
            const events = MissionEventsStore.readEvents(eventsPath);
            const projection = MissionProjectionEngine.project(events);
            // Task is state 'reviewed' (awaiting review), NOT 'accepted'!
            assert.equal(projection.workGraph.workItems[wiId].state, "reviewed");
            assert.equal(projection.workGraph.acceptedSet.includes(wiId), false, "Worker claim must not accept work item without dual review attestation");
        }
        finally {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
});
