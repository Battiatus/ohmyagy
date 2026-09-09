import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { OmaDoctor } from "../runtime/doctor.js";
import { installWorkspacePlugin } from "../packaging/install.js";
import { MissionEventsStore } from "../ledger/mission-events.js";
import { MissionProjectionEngine } from "../graph/mission-projections.js";
import {
  eventsPathFor,
  findActiveMissionId,
  loadMissionProjection,
  summarizeMission,
  type MissionProjection,
} from "../mission/read-model.js";
import { RealMissionExecutor } from "../orchestration/real-mission.js";
import { RealBenchmarkRunner, loadRealBenchmarkManifest } from "../benchmark/real-benchmark.js";
import type { OracleGate } from "../oracle/executor.js";

export async function runOmaCli(args: string[], workspaceRoot = process.cwd()): Promise<number> {
  try {
    const command = args[0];

    if (!command || command === "--help" || command === "-h" || command === "help") {
      printHelp();
      return 0;
    }

    if (command === "doctor") {
      const report = OmaDoctor.diagnoseEnvironment(workspaceRoot);
      console.log(JSON.stringify(report, null, 2));
      return args.includes("--strict") && !runtimeIsReady(report) ? 1 : 0;
    }

    if (command === "start") {
      return await startMission(args, workspaceRoot);
    }

    if (command === "watch") {
      return await watchMission(args, workspaceRoot);
    }

    if (command === "install" || command === "setup" || (command === "plugin" && args[1] === "install-workspace")) {
      const force = args.includes("--force") || args.includes("-f");
      const isGlobal = args.includes("--global") || args.includes("-g");
      const install = installWorkspacePlugin(workspaceRoot, { force, global: isGlobal });
      console.log(`[OMA] Successfully installed Oh My Antigravity (OMA):`);
      console.log(`  ✓ ${install.agentsInstalled.length} Native Agents in .agents/agents/:`);
      console.log(`    ${install.agentsInstalled.join(", ")}`);
      console.log(`  ✓ ${install.skillsInstalled.length} Native Skills in .agents/skills/:`);
      console.log(`    ${install.skillsInstalled.join(", ")}`);
      console.log(`  ✓ OMA Workflow Plugin in ${install.pluginDir}`);
      if (isGlobal) {
        console.log(`  ✓ Deployed globally to ~/.gemini/config/agents/`);
      }
      return 0;
    }

    if (command === "benchmark") {
      const manifestPath = requiredOption(args, "--manifest");
      const manifest = loadRealBenchmarkManifest(resolve(workspaceRoot, manifestPath));
      requireRuntime(workspaceRoot);
      console.log(`[OMA] Starting real comparison with ${manifest.trialsPerVariant} trial(s) per variant...`);
      const benchmarkResult = await RealBenchmarkRunner.execute({ workspaceRoot, manifest });
      console.log(JSON.stringify(benchmarkResult.summary, null, 2));
      console.log(`[OMA] Raw measurements written to: ${benchmarkResult.resultsFilePath}`);
      console.log(`[OMA] Human report written to: ${benchmarkResult.reportFilePath}`);
      return 0;
    }

    if (command === "status") {
      const isJson = args.includes("--json");
      const missionFlagIdx = args.indexOf("--mission");
      const missionId = missionFlagIdx !== -1 ? args[missionFlagIdx + 1] : findActiveMissionId(workspaceRoot);

      if (!missionId) {
        if (isJson) {
          console.log(JSON.stringify({ error: "No active or specified mission found in workspace." }, null, 2));
        } else {
          console.error("No active or specified mission found in .oma/missions/");
        }
        return 1;
      }

      const eventsPath = eventsPathFor(workspaceRoot, missionId);
      if (!existsSync(eventsPath)) {
        if (isJson) {
          const projection = MissionProjectionEngine.project([]);
          console.log(JSON.stringify(projection, null, 2));
          return 0;
        }
        console.error(`Mission '${missionId}' was not found.`);
        return 1;
      }

      const projection = loadMissionProjection(workspaceRoot, missionId);

      if (isJson) {
        console.log(JSON.stringify(projection, null, 2));
      } else {
        printMissionStatus(missionId, projection);
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
        } else {
          console.error("No active mission found.");
        }
        return 1;
      }

      const missionDir = join(workspaceRoot, ".oma", "missions", missionId);
      const eventsPath = join(missionDir, "events.jsonl");

      // Option: --diff [optional workItemId]
      if (args.includes("--diff")) {
        const diffFlagIdx = args.indexOf("--diff");
        const specificNode = args[diffFlagIdx + 1] && !args[diffFlagIdx + 1].startsWith("-") ? args[diffFlagIdx + 1] : undefined;
        const diffsDir = join(missionDir, "diffs");
        if (existsSync(diffsDir)) {
          const files = readdirSync(diffsDir).filter((f) => f.endsWith(".patch"));
          if (files.length === 0) {
            console.log(`No diff patches found for mission '${missionId}'.`);
          } else {
            for (const file of files) {
              const nodeName = file.replace(/\.patch$/, "");
              if (specificNode && nodeName !== specificNode) continue;
              console.log(`\n=== Unified Diff: ${nodeName} (${file}) ===`);
              const diffContent = readFileSync(join(diffsDir, file), "utf8");
              console.log(diffContent || "(empty diff)");
            }
          }
        } else {
          console.log(`No diffs directory found for mission '${missionId}'.`);
        }
        return 0;
      }

      // Option: --runs
      if (args.includes("--runs")) {
        const runsDir = join(missionDir, "runs");
        if (existsSync(runsDir)) {
          const runFiles = readdirSync(runsDir).filter((f) => f.endsWith(".log"));
          console.log(`=== OMA Agent Runs for Mission '${missionId}' (${runFiles.length} runs) ===`);
          for (const rf of runFiles) {
            const stat = statSync(join(runsDir, rf));
            console.log(`  - ${rf} (${stat.size} bytes)`);
          }
          console.log(`\nUse 'oma inspect --log <runId>' to inspect the full prompt & raw output.`);
        } else {
          console.log(`No runs directory found for mission '${missionId}'.`);
        }
        return 0;
      }

      // Option: --log <runId>
      const logFlagIdx = args.indexOf("--log");
      if (logFlagIdx !== -1 && args[logFlagIdx + 1]) {
        const targetRun = args[logFlagIdx + 1];
        const safeTarget = targetRun.replace(/[^a-zA-Z0-9_-]/g, "_");
        const directLog = join(missionDir, "runs", `${safeTarget}.log`);
        const fallbackLog = join(missionDir, "runs", `${targetRun}.log`);
        const targetFile = existsSync(directLog) ? directLog : existsSync(fallbackLog) ? fallbackLog : undefined;
        if (!targetFile) {
          console.error(`Run log '${targetRun}' not found in ${join(missionDir, "runs")}`);
          return 1;
        }
        console.log(readFileSync(targetFile, "utf8"));
        return 0;
      }

      // Option: --gates
      if (args.includes("--gates")) {
        const gateLogsDir = join(missionDir, "gate-logs");
        if (existsSync(gateLogsDir)) {
          const files = readdirSync(gateLogsDir).filter((f) => f.endsWith(".log"));
          console.log(`=== OMA Gate Evaluations for Mission '${missionId}' ===`);
          for (const gf of files) {
            console.log(`\n--- Gate Log: ${gf} ---`);
            console.log(readFileSync(join(gateLogsDir, gf), "utf8"));
          }
        } else {
          console.log(`No gate logs found for mission '${missionId}'.`);
        }
        return 0;
      }

      if (!existsSync(eventsPath)) {
        if (isJson) {
          const projection = MissionProjectionEngine.project([]);
          console.log(JSON.stringify(projection.provenance, null, 2));
          return 0;
        }
        console.error(`Mission '${missionId}' events file not found at ${eventsPath}`);
        return 1;
      }

      const events = MissionEventsStore.readEvents(eventsPath);
      const projection = MissionProjectionEngine.project(events);

      if (isJson) {
        console.log(JSON.stringify(projection.provenance, null, 2));
      } else {
        console.log(`=== OMA Mission Inspection: ${missionId} ===`);
        console.log(`Total Events in Cryptographic Chain: ${events.length}`);

        const missionStart = events.find((e) => e.type === "mission_started");
        if (missionStart && missionStart.type === "mission_started") {
          console.log(`Goal: "${missionStart.goal}"`);
        }

        console.log(`\nArtifacts Produced (${Object.keys(projection.provenance.artifacts).length}):`);
        for (const art of Object.values(projection.provenance.artifacts)) {
          console.log(`  - [${art.kind.toUpperCase()}] ${art.path} (Hash: ${art.hash.slice(0, 12)}... by ${art.producedByRunId})`);
        }

        console.log(`\nReviews Attested (${projection.provenance.reviews.length}):`);
        for (const rev of projection.provenance.reviews) {
          const verdictColor = rev.verdict === "approved" ? "\x1b[32mAPPROVED\x1b[0m" : "\x1b[31mREJECTED\x1b[0m";
          console.log(`  - ${rev.reviewerExpertId} -> ${rev.workItemId}: ${verdictColor}`);
        }

        const diffsDir = join(missionDir, "diffs");
        if (existsSync(diffsDir)) {
          const patches = readdirSync(diffsDir).filter((f) => f.endsWith(".patch"));
          if (patches.length > 0) {
            console.log(`\nDiff Patches Available (${patches.length}):`);
            for (const p of patches) {
              console.log(`  - ${p}`);
            }
          }
        }

        console.log(`\nInspect Details:`);
        console.log(`  oma inspect --diff          View unified code diffs`);
        console.log(`  oma inspect --runs          List individual agent executions`);
        console.log(`  oma inspect --log <runId>   View full LLM prompt & raw transcript`);
        console.log(`  oma inspect --gates         View external gate outcomes and test errors`);
      }
      return 0;
    }

    if (command === "run") {
      let missionId = `mission-${Date.now()}`;
      let goal = "Execute multi-agent development mission with specialized experts";

      const goalValue = optionValue(args, "--goal") ?? optionValue(args, "-g");
      if (goalValue) {
        goal = goalValue;
      }

      // Check for positional missionId (e.g. oma run my-mission --goal "...")
      if (args[1] && !args[1].startsWith("-")) {
        missionId = args[1];
      } else {
        const missionFlagIdx = args.indexOf("--mission");
        if (missionFlagIdx !== -1 && args[missionFlagIdx + 1]) {
          missionId = args[missionFlagIdx + 1];
        }
      }

      const defaultGatePath = existsSync(join(workspaceRoot, ".agents", "plugins", "oma", "gates.json"))
        ? join(workspaceRoot, ".agents", "plugins", "oma", "gates.json")
        : existsSync(join(workspaceRoot, "gates.json"))
        ? join(workspaceRoot, "gates.json")
        : undefined;

      const gatesArg = optionValue(args, "--gates");
      const resolvedGatePath = gatesArg ? resolve(workspaceRoot, gatesArg) : defaultGatePath;
      if (!resolvedGatePath || !existsSync(resolvedGatePath)) {
        throw new Error("Missing required option --gates and no default gates.json found at .agents/plugins/oma/gates.json.");
      }
      const gates = loadGateManifest(resolvedGatePath);
      requireRuntime(workspaceRoot);

      const verbose = args.includes("--verbose") || args.includes("-v");
      console.log(`[OMA] Starting mission execution: ${missionId}`);
      console.log(`[OMA] Goal: "${goal}"`);
      const report = await RealMissionExecutor.execute({
        workspaceRoot,
        missionId,
        goal,
        gates,
        model: optionValue(args, "--model"),
        effort: effortOption(args),
        timeoutMs: positiveOption(args, "--timeout-ms", 300_000),
        maxConcurrency: positiveOption(args, "--concurrency", 3),
        maxWaves: positiveOption(args, "--max-waves", 3),
        allowDirty: args.includes("--allow-dirty") || args.includes("-f") || args.includes("--force"),
        verbose,
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

      const defaultGatePath = existsSync(join(workspaceRoot, ".agents", "plugins", "oma", "gates.json"))
        ? join(workspaceRoot, ".agents", "plugins", "oma", "gates.json")
        : existsSync(join(workspaceRoot, "gates.json"))
        ? join(workspaceRoot, "gates.json")
        : undefined;

      const gatesArg = optionValue(args, "--gates");
      const resolvedGatePath = gatesArg ? resolve(workspaceRoot, gatesArg) : defaultGatePath;
      if (!resolvedGatePath || !existsSync(resolvedGatePath)) {
        throw new Error("Missing required option --gates and no default gates.json found at .agents/plugins/oma/gates.json.");
      }
      const gates = loadGateManifest(resolvedGatePath);
      requireRuntime(workspaceRoot);

      const verbose = args.includes("--verbose") || args.includes("-v");
      console.log(`[OMA] Resuming mission: ${missionId}`);
      const report = await RealMissionExecutor.resume({
        workspaceRoot,
        missionId,
        gates,
        model: optionValue(args, "--model"),
        effort: effortOption(args),
        timeoutMs: positiveOption(args, "--timeout-ms", 300_000),
        maxConcurrency: positiveOption(args, "--concurrency", 3),
        maxWaves: positiveOption(args, "--max-waves", 3),
        verbose,
      });

      console.log(JSON.stringify(report, null, 2));
      return report.status === "succeeded" ? 0 : 1;
    }

    console.error(`Unknown command: oma ${args.join(" ")}`);
    printHelp();
    return 1;
  } catch (error) {
    console.error(`[OMA ERROR] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function startMission(args: string[], workspaceRoot: string): Promise<number> {
  const supplied = args.slice(1);
  const positionalGoal = supplied[0] && !supplied[0].startsWith("-") ? supplied[0] : undefined;
  const goal = optionValue(supplied, "--goal") ?? optionValue(supplied, "-g") ?? positionalGoal;
  if (!goal) {
    throw new Error('oma start requires an objective. Example: oma start "Analyse this repository"');
  }

  ensureWorkspacePlugin(workspaceRoot);
  const forwarded = positionalGoal ? supplied.slice(1) : supplied;
  return runOmaCli(["run", "--goal", goal, ...forwarded], workspaceRoot);
}

function ensureWorkspacePlugin(workspaceRoot: string): void {
  const pluginDir = join(workspaceRoot, ".agents", "plugins", "oma");
  if (existsSync(pluginDir)) return;
  installWorkspacePlugin(workspaceRoot);
  console.log("[OMA] Workspace plugin initialized.");
}

async function watchMission(args: string[], workspaceRoot: string): Promise<number> {
  validateWatchArguments(args);
  const positionalMissionId = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
  const missionId = optionValue(args, "--mission") ?? positionalMissionId ?? findActiveMissionId(workspaceRoot);
  if (!missionId) {
    console.error("No active mission found. Specify one with 'oma watch --mission <id>'.");
    return 1;
  }

  const once = args.includes("--once");
  const intervalMs = boundedInterval(args);
  do {
    const projection = loadMissionProjection(workspaceRoot, missionId);
    printMissionStatus(missionId, projection);
    if (projection.status === "succeeded") return 0;
    if (projection.status === "failed" || projection.status === "blocked") return 1;
    if (once) return 0;
    await new Promise<void>((done) => setTimeout(done, intervalMs));
  } while (true);
}

function printMissionStatus(missionId: string, projection: MissionProjection): void {
  const summary = summarizeMission(missionId, projection);
  console.log(`=== OMA Mission Status: ${missionId} ===`);
  console.log(`Status: ${summary.missionStatus.toUpperCase()}`);
  console.log(`Phase: ${summary.phase}`);
  console.log(`Current Wave: ${summary.currentWave}`);
  console.log(`Active Runs: [${summary.activeRuns.join(", ")}]`);
  console.log(`WorkItems Ready: [${summary.ready.join(", ")}]`);
  console.log(`WorkItems Running: [${summary.running.join(", ")}]`);
  console.log(`WorkItems Accepted: [${summary.accepted.join(", ")}]`);
  if (summary.missionStatus === "in_progress" && summary.progress.totalWorkItems === 0) {
    console.log(`Progress: plan pending, ${summary.activeRuns.length} active run(s)`);
  } else {
    console.log(`Progress: ${summary.progress.acceptedWorkItems}/${summary.progress.totalWorkItems} accepted, ${summary.progress.hiddenTestsFailing} hidden fails, ${summary.progress.gateFailures} gate fails`);
  }
  if (summary.terminalVerdict) {
    console.log(`Terminal Verdict: ${summary.terminalVerdict.status.toUpperCase()} (Commit: ${summary.terminalVerdict.commitSha ?? "none"})`);
  }
}

function validateWatchArguments(args: string[]): void {
  const valueOptions = new Set(["--mission", "--interval-ms"]);
  const flagOptions = new Set(["--once"]);
  let positionalMissionSeen = false;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (flagOptions.has(argument)) continue;
    if (valueOptions.has(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${argument}. Use 'oma watch --mission <id>'.`);
      }
      index += 1;
      continue;
    }
    const inlineValueOption = [...valueOptions].find((option) => argument.startsWith(`${option}=`));
    if (inlineValueOption) {
      if (argument.slice(inlineValueOption.length + 1).length === 0) {
        throw new Error(`Missing value for ${inlineValueOption}. Use 'oma watch --mission <id>'.`);
      }
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown watch option '${argument}'. Use 'oma watch --mission <id>'.`);
    }
    if (positionalMissionSeen) {
      throw new Error(`Unexpected watch argument '${argument}'. Use 'oma watch --mission <id>'.`);
    }
    positionalMissionSeen = true;
  }
}

function boundedInterval(args: string[]): number {
  const intervalMs = positiveOption(args, "--interval-ms", 1_000);
  if (intervalMs < 250 || intervalMs > 60_000) {
    throw new Error("--interval-ms must be between 250 and 60000.");
  }
  return intervalMs;
}

function requireRuntime(workspaceRoot: string): void {
  const report = OmaDoctor.diagnoseEnvironment(workspaceRoot);
  if (!runtimeIsReady(report)) {
    throw new Error("OMA requires a verified AntiGravity runtime and a live-attested workspace plugin. Run 'oma doctor --strict'.");
  }
}

function runtimeIsReady(report: ReturnType<typeof OmaDoctor.diagnoseEnvironment>): boolean {
  return report.agyCli.available && report.pluginDiscovery.valid;
}

function requiredOption(args: string[], name: string): string {
  const value = optionValue(args, name);
  if (!value) throw new Error(`Missing required option ${name}.`);
  return value;
}

function optionValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length).replace(/^["']|["']$/gu, "");
    }
  }
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

function effortOption(args: string[]): "low" | "medium" | "high" | undefined {
  const effort = optionValue(args, "--effort");
  if (effort === undefined) return undefined;
  if (effort !== "low" && effort !== "medium" && effort !== "high") {
    throw new Error("--effort must be low, medium or high.");
  }
  return effort;
}

function positiveOption(args: string[], name: string, fallback: number): number {
  const raw = optionValue(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function loadGateManifest(path: string): OracleGate[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to read gate manifest '${path}': ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.gates) || value.gates.length === 0) {
    throw new Error("Gate manifest must contain schemaVersion 1 and a non-empty gates array.");
  }
  const ids = new Set<string>();
  return value.gates.map((entry): OracleGate => {
    if (!isRecord(entry)) {
      throw new Error("Gate manifest contains an invalid, unavailable or duplicate gate.");
    }
    const id = entry.id;
    const program = entry.program;
    const timeoutMs = entry.timeoutMs;
    const args = gateArguments(entry.args);
    if (typeof id !== "string" || typeof program !== "string" || typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || !isAbsolute(program) || !existsSync(program) || ids.has(id)) {
      throw new Error("Gate manifest contains an invalid, unavailable or duplicate gate.");
    }
    ids.add(id);
    return { id, program, args, timeoutMs };
  });
}

function gateArguments(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Gate manifest contains an invalid, unavailable or duplicate gate.");
  return value.map((argument) => {
    if (typeof argument !== "string") throw new Error("Gate manifest contains an invalid, unavailable or duplicate gate.");
    return argument;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printHelp(): void {
  console.log(`Oh My Antigravity (OMA) CLI

Usage:
  oma install [--force|-f] [--global|-g]         Install all OMA experts, skills, and plugins (workspace or global)
  oma doctor [--strict]                          Diagnose local Antigravity environment and capabilities
  oma start <goal> [run options]                 Start a mission without supplying a mission id
  oma run <mission-id> --goal <goal> [options]   Execute multi-agent development mission
      Options:
        --verbose, -v                            Stream live agent output directly to console
        --allow-dirty, -f, --force               Allow starting mission with dirty Git workspace
        --gates <file>                           Path to gates.json manifest
        --model <id>                             Override AI model slug
        --effort <low|medium|high>               Set reasoning effort
        --timeout-ms <n>                         Per-task timeout in milliseconds
        --concurrency <n>                        Maximum concurrent executors (default: 3)
        --max-waves <n>                          Maximum dynamic workflow waves (default: 3)
  oma resume [--mission <id>] [--gates <file>]   Resume a real graph mission from its durable journal
  oma watch [--mission <id>] [--once]            Follow the active mission from its durable journal
  oma status [--json] [--mission <id>]          Inspect live mission state, progress vector, and queues
  oma inspect [options] [--mission <id>]        Interactive inspection and debugging
      Options:
        --diff [nodeId]                          Display unified Git diff(s) produced by executors
        --runs                                   List all agent executions with status and durations
        --log <runId>                            Display full prompt, live transcript, and raw outputs
        --gates                                  Display external gate evaluation outputs and error logs
        --json                                   Output machine-readable provenance JSON
  oma plugin install-workspace [--force|-f]     Install OMA plugin and experts into current workspace
  oma benchmark --manifest <file>                Run an empirical 4-variant comparison from a pinned manifest
`);
}
