import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as originalMath from "../../test-fixtures/minimal-pipeline/src/math.js";
import * as originalParser from "../../test-fixtures/minimal-pipeline/src/parser.js";
import * as originalPipeline from "../../test-fixtures/minimal-pipeline/src/pipeline.js";
import * as mutant1Math from "../../test-fixtures/minimal-pipeline/src/mutants/mutant1-math.js";
import * as mutant2Parser from "../../test-fixtures/minimal-pipeline/src/mutants/mutant2-parser.js";
import { DynamicConvergenceEngine, } from "../orchestration/dynamic-engine.js";
import { MissionEventsStore } from "../ledger/mission-events.js";
describe("Phase 4 — Dynamic Workflow, Convergence & Gate Observable", () => {
    const baseBundle = {
        math: originalMath,
        parser: originalParser,
        pipeline: originalPipeline,
    };
    it("Gate 4.1 & 4.2: Red gate in wave 1 triggers dynamic wave 2 which converges to green with new Runs & diagnostics", async () => {
        const testDir = join(process.cwd(), ".oma", "test-phase4-converge");
        rmSync(testDir, { recursive: true, force: true });
        mkdirSync(testDir, { recursive: true });
        try {
            const report = await DynamicConvergenceEngine.execute({
                workspaceRoot: testDir,
                missionId: "mission-converge-success",
                baseBundle,
                limits: { maxRounds: 3, maxConsecutiveNoProgressRounds: 2 },
                initialWorkItemsSupplier: (wave) => {
                    // Wave 1: Worker introduces Mutant 1 (fails hidden tests)
                    return [
                        {
                            scopeId: "src/math.ts",
                            title: "Implement Math Module",
                            filesModified: ["src/math.ts"],
                            modulePatch: { math: mutant1Math }, // Red gate injection!
                            rawDiffContent: "diff --git a/src/math.ts b/src/math.ts\n+mutant1",
                        },
                    ];
                },
                diagnosticFixerSupplier: (diagnostics) => {
                    // Wave 2: Fixer repairs Math module based on judge diagnostics
                    return [
                        {
                            scopeId: "src/math-fix.ts",
                            title: "Fix Math Module Edge Cases",
                            filesModified: ["src/math.ts"],
                            modulePatch: { math: originalMath }, // Repaired!
                            rawDiffContent: "diff --git a/src/math.ts b/src/math.ts\n+repaired clean math",
                        },
                    ];
                },
            });
            assert.equal(report.status, "succeeded");
            assert.equal(report.totalWaves, 2, "Must converge on exactly wave 2");
            assert.equal(report.finalProgress.hiddenTestsFailing, 0);
            assert.equal(report.finalProgress.gateFailures, 0);
            assert.ok(report.integratedCommitSha);
            // Verify event log has wave_transitioned linking diagnostics and new Runs
            const eventsPath = join(testDir, ".oma", "missions", "mission-converge-success", "events.jsonl");
            const events = MissionEventsStore.readEvents(eventsPath);
            const waveTransition = events.find((e) => e.type === "wave_transitioned");
            assert.ok(waveTransition);
            if (waveTransition && waveTransition.type === "wave_transitioned") {
                assert.equal(waveTransition.fromWave, 1);
                assert.equal(waveTransition.toWave, 2);
                assert.ok(waveTransition.reason.includes("diagnostics"));
            }
            // Check run IDs: Wave 1 worker vs Wave 2 worker have distinct run IDs
            const runStartedEvents = events.filter((e) => e.type === "run_started");
            assert.equal(runStartedEvents.length, 2);
            assert.notEqual(runStartedEvents[0].runId, runStartedEvents[1].runId);
        }
        finally {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
    it("Gate 4.3: Two consecutive waves without ProgressVector improvement produce no_progress_blocked", async () => {
        const testDir = join(process.cwd(), ".oma", "test-phase4-noprogress");
        rmSync(testDir, { recursive: true, force: true });
        mkdirSync(testDir, { recursive: true });
        try {
            const report = await DynamicConvergenceEngine.execute({
                workspaceRoot: testDir,
                missionId: "mission-no-progress",
                baseBundle,
                limits: { maxRounds: 5, maxConsecutiveNoProgressRounds: 2 },
                initialWorkItemsSupplier: (wave) => {
                    // Stagnant mutant repeating identical failure
                    return [
                        {
                            scopeId: "src/math.ts",
                            title: `Stagnant Attempt ${wave}`,
                            filesModified: ["src/math.ts"],
                            modulePatch: { math: mutant1Math },
                            rawDiffContent: `diff --git a/src/math.ts b/src/math.ts\n+stagnant attempt ${wave}`,
                        },
                    ];
                },
            });
            assert.equal(report.status, "no_progress_blocked");
            assert.ok(report.totalWaves <= 3);
            const eventsPath = join(testDir, ".oma", "missions", "mission-no-progress", "events.jsonl");
            const events = MissionEventsStore.readEvents(eventsPath);
            const finishedEvent = events.find((e) => e.type === "mission_finished");
            assert.equal(finishedEvent?.finalStatus, "no_progress_blocked");
        }
        finally {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
    it("Gate 4.4: Budget exhausted limit halts mission when maxRounds exceeded", async () => {
        const testDir = join(process.cwd(), ".oma", "test-phase4-budget");
        rmSync(testDir, { recursive: true, force: true });
        mkdirSync(testDir, { recursive: true });
        try {
            let counter = 0;
            const report = await DynamicConvergenceEngine.execute({
                workspaceRoot: testDir,
                missionId: "mission-budget-exhausted",
                baseBundle,
                limits: { maxRounds: 2, maxConsecutiveNoProgressRounds: 5 },
                initialWorkItemsSupplier: (wave) => {
                    counter++;
                    return [
                        {
                            scopeId: "src/parser.ts",
                            title: `Attempt ${wave}`,
                            filesModified: ["src/parser.ts"],
                            modulePatch: { parser: mutant2Parser },
                            rawDiffContent: `diff --git a/src/parser.ts b/src/parser.ts\n+attempt ${wave}`,
                        },
                    ];
                },
            });
            assert.equal(report.status, "budget_exhausted");
            assert.equal(report.totalWaves, 2);
        }
        finally {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
});
