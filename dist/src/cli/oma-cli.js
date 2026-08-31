import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OmaDoctor } from "../runtime/doctor.js";
import { installWorkspacePlugin } from "../packaging/install.js";
import { MissionEventsStore } from "../ledger/mission-events.js";
import { MissionProjectionEngine } from "../graph/mission-projections.js";
export async function runOmaCli(args, workspaceRoot = process.cwd()) {
    try {
        const command = args[0];
        if (!command || command === "--help" || command === "-h" || command === "help") {
            printHelp();
            return 0;
        }
        if (command === "doctor") {
            const report = OmaDoctor.diagnoseEnvironment(workspaceRoot);
            console.log(JSON.stringify(report, null, 2));
            return 0;
        }
        if (command === "plugin" && args[1] === "install-workspace") {
            const force = args.includes("--force") || args.includes("-f");
            const install = installWorkspacePlugin(workspaceRoot, { force });
            console.log(JSON.stringify(install, null, 2));
            return 0;
        }
        if (command === "benchmark") {
            const trialsFlagIdx = args.indexOf("--trials");
            let trials = 1;
            if (trialsFlagIdx !== -1 && args[trialsFlagIdx + 1]) {
                const parsedTrials = parseInt(args[trialsFlagIdx + 1], 10);
                if (!Number.isNaN(parsedTrials) && parsedTrials > 0) {
                    trials = parsedTrials;
                }
            }
            const { BenchmarkRunner } = await import("../benchmark/benchmark-runner.js");
            console.log(`[OMA] Starting empirical benchmark (${trials} trial(s) per variant)...`);
            const benchmarkResult = await BenchmarkRunner.executeBenchmark({
                workspaceRoot,
                trialsPerVariant: trials,
            });
            console.log(JSON.stringify(benchmarkResult.summary, null, 2));
            console.log(`[OMA] Benchmark results written to: ${benchmarkResult.resultsFilePath}`);
            return 0;
        }
        if (command === "status") {
            const isJson = args.includes("--json");
            const missionFlagIdx = args.indexOf("--mission");
            const missionId = missionFlagIdx !== -1 ? args[missionFlagIdx + 1] : findActiveMissionId(workspaceRoot);
            if (!missionId) {
                if (isJson) {
                    console.log(JSON.stringify({ error: "No active or specified mission found in workspace." }, null, 2));
                }
                else {
                    console.error("No active or specified mission found in .oma/missions/");
                }
                return 1;
            }
            const eventsPath = join(workspaceRoot, ".oma", "missions", missionId, "events.jsonl");
            const events = MissionEventsStore.readEvents(eventsPath);
            const projection = MissionProjectionEngine.project(events);
            if (isJson) {
                console.log(JSON.stringify(projection, null, 2));
            }
            else {
                console.log(`=== OMA Mission Status: ${missionId} ===`);
                console.log(`Status: ${projection.status.toUpperCase()}`);
                console.log(`Current Wave: ${projection.currentWave}`);
                console.log(`WorkItems Ready: [${projection.workGraph.readySet.join(", ")}]`);
                console.log(`WorkItems Running: [${projection.workGraph.runningSet.join(", ")}]`);
                console.log(`WorkItems Accepted: [${projection.workGraph.acceptedSet.join(", ")}]`);
                console.log(`Progress: ${projection.progress.acceptedWorkItems}/${projection.progress.totalWorkItems} accepted, ${projection.progress.hiddenTestsFailing} hidden fails, ${projection.progress.gateFailures} gate fails`);
                if (projection.provenance.terminalVerdict) {
                    console.log(`Terminal Verdict: ${projection.provenance.terminalVerdict.status.toUpperCase()} (Commit: ${projection.provenance.terminalVerdict.commitSha ?? "none"})`);
                }
            }
            return 0;
        }
        if (command === "inspect") {
            const isJson = args.includes("--json");
            const missionFlagIdx = args.indexOf("--mission");
            const missionId = missionFlagIdx !== -1 ? args[missionFlagIdx + 1] : findActiveMissionId(workspaceRoot);
            if (!missionId) {
                if (isJson) {
                    console.log(JSON.stringify({ error: "No active mission found." }, null, 2));
                }
                else {
                    console.error("No active mission found.");
                }
                return 1;
            }
            const eventsPath = join(workspaceRoot, ".oma", "missions", missionId, "events.jsonl");
            const events = MissionEventsStore.readEvents(eventsPath);
            const projection = MissionProjectionEngine.project(events);
            if (isJson) {
                console.log(JSON.stringify(projection.provenance, null, 2));
            }
            else {
                console.log(`=== OMA Provenance Inspection: ${missionId} ===`);
                console.log(`Total Events in Chain: ${events.length}`);
                console.log(`Artifacts Produced (${Object.keys(projection.provenance.artifacts).length}):`);
                for (const art of Object.values(projection.provenance.artifacts)) {
                    console.log(`  - [${art.kind}] ${art.path} (Hash: ${art.hash.slice(0, 12)}... by ${art.producedByRunId})`);
                }
                console.log(`Reviews Attested (${projection.provenance.reviews.length}):`);
                for (const rev of projection.provenance.reviews) {
                    console.log(`  - Reviewer ${rev.reviewerExpertId} (${rev.reviewerRunId}) -> ${rev.workItemId}: ${rev.verdict.toUpperCase()}`);
                }
            }
            return 0;
        }
        if (command === "run") {
            let missionId = `mission-${Date.now()}`;
            let goal = "Execute multi-agent development mission with specialized experts";
            const goalIdx = args.findIndex((a) => a === "--goal" || a === "-g");
            if (goalIdx !== -1 && args[goalIdx + 1]) {
                goal = args[goalIdx + 1];
            }
            // Check for positional missionId (e.g. oma run my-mission --goal "...")
            if (args[1] && !args[1].startsWith("-")) {
                missionId = args[1];
            }
            else {
                const missionFlagIdx = args.indexOf("--mission");
                if (missionFlagIdx !== -1 && args[missionFlagIdx + 1]) {
                    missionId = args[missionFlagIdx + 1];
                }
            }
            const { DynamicConvergenceEngine } = await import("../orchestration/dynamic-engine.js");
            console.log(`[OMA] Starting mission execution: ${missionId}`);
            console.log(`[OMA] Goal: "${goal}"`);
            const report = await DynamicConvergenceEngine.execute({
                workspaceRoot,
                missionId,
                goal,
            });
            console.log(JSON.stringify(report, null, 2));
            return report.status === "succeeded" ? 0 : 1;
        }
        if (command === "resume") {
            const missionFlagIdx = args.indexOf("--mission");
            let missionId = missionFlagIdx !== -1 ? args[missionFlagIdx + 1] : undefined;
            if (!missionId && args[1] && !args[1].startsWith("-")) {
                missionId = args[1];
            }
            if (!missionId) {
                missionId = findActiveMissionId(workspaceRoot);
            }
            if (!missionId) {
                console.error("No mission specified or found to resume.");
                return 1;
            }
            const { MissionResumptionEngine } = await import("../orchestration/mission-resumption.js");
            console.log(`[OMA] Resuming mission: ${missionId}`);
            const report = await MissionResumptionEngine.resume({
                workspaceRoot,
                missionId,
            });
            console.log(JSON.stringify(report, null, 2));
            return report.status === "succeeded" ? 0 : 1;
        }
        console.error(`Unknown command: oma ${args.join(" ")}`);
        printHelp();
        return 1;
    }
    catch (error) {
        console.error(`[OMA ERROR] ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
}
function findActiveMissionId(workspaceRoot) {
    const missionsDir = join(workspaceRoot, ".oma", "missions");
    if (!existsSync(missionsDir))
        return undefined;
    const entries = readdirSync(missionsDir);
    return entries.length > 0 ? entries[entries.length - 1] : undefined;
}
function printHelp() {
    console.log(`Oh My Antigravity (OMA) CLI

Usage:
  oma doctor                                    Diagnose local Antigravity environment and capabilities
  oma status [--json] [--mission <id>]          Inspect live mission state, progress vector, and queues
  oma inspect [--json] [--mission <id>]         Inspect full provenance chain, artifacts, and reviews
  oma plugin install-workspace [--force|-f]     Install OMA plugin and experts into current workspace
  oma benchmark [--trials <n>]                  Run empirical causal benchmark across 4 harness variants
  oma run <mission-id>                          Execute an end-to-end multi-agent mission
  oma resume [--mission <id>]                   Resume an interrupted mission from durable journal
`);
}
