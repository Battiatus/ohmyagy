import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { sha256 } from "../ledger/canonical.js";
import { RealMissionExecutor, type RealMissionReport } from "../orchestration/real-mission.js";
import { WorktreePool, type IWorktreePool } from "../orchestration/worktree-pool.js";
import { AgyDriver, type DriverExecutionResult, type IAgyDriver } from "../runtime/agy-driver.js";
import type { OracleGate } from "../oracle/executor.js";

export type RealBenchmarkVariant = "vanilla_agy" | "skills_only" | "oma_static_wave" | "oma_dynamic_workflow";

export interface RealBenchmarkManifest {
  schemaVersion: 1;
  baselineCommitSha: string;
  task: {
    id: string;
    prompt: string;
  };
  model: string;
  effort: "low" | "medium" | "high";
  timeoutMs: number;
  trialsPerVariant: number;
  maxDynamicWaves: number;
  skillsOnlyPrompt: string;
  gates: OracleGate[];
}

export interface RealBenchmarkGateResult {
  id: string;
  exitCode: number;
  durationMs: number;
  stdoutHash: string;
  stderrHash: string;
}

export interface RealBenchmarkTrial {
  variant: RealBenchmarkVariant;
  trialIndex: number;
  trialId: string;
  timestamp: string;
  baselineCommitSha: string;
  worktreeHead: string;
  model: string;
  effort: "low" | "medium" | "high";
  durationMs: number;
  totalTokens: number | null;
  status: "succeeded" | "failed" | "timed_out" | "blocked";
  gatesPassed: boolean;
  gateResults: RealBenchmarkGateResult[];
  diffHash: string | null;
  receiptHashes: string[];
  commitShas: string[];
  runsCount: number;
  wavesCount: number;
  diagnostics: string[];
  intervention: "bare_agy" | "static_skill_prompt" | "oma_one_wave" | "oma_dynamic_graph";
  evidencePath: string | null;
}

export interface RealBenchmarkSummary {
  taskId: string;
  baselineCommitSha: string;
  trialsPerVariant: number;
  resultsByVariant: Record<RealBenchmarkVariant, {
    successRate: number;
    meanDurationMs: number;
    meanTokens: number | null;
    meanRuns: number;
    meanWaves: number;
  }>;
  interpretation: string[];
}

export interface RealBenchmarkOptions {
  workspaceRoot: string;
  manifest: RealBenchmarkManifest;
  driver?: IAgyDriver;
  worktreePool?: IWorktreePool;
}

export class RealBenchmarkRunner {
  public static async execute(options: RealBenchmarkOptions): Promise<{
    summary: RealBenchmarkSummary;
    rawResults: RealBenchmarkTrial[];
    resultsFilePath: string;
    reportFilePath: string;
  }> {
    const workspaceRoot = resolve(options.workspaceRoot);
    const manifest = validateManifest(options.manifest);
    ensureBenchmarkBaseline(workspaceRoot, manifest.baselineCommitSha);
    const benchmarkDir = join(workspaceRoot, ".oma", "benchmark");
    mkdirSync(benchmarkDir, { recursive: true });
    const driver = options.driver ?? new AgyDriver();
    const pool = options.worktreePool ?? new WorktreePool({ workspaceRoot });
    const variants: RealBenchmarkVariant[] = ["vanilla_agy", "skills_only", "oma_static_wave", "oma_dynamic_workflow"];
    const results: RealBenchmarkTrial[] = [];

    for (let trialIndex = 1; trialIndex <= manifest.trialsPerVariant; trialIndex += 1) {
      const rotated = variants.map((_, index) => variants[(index + trialIndex - 1) % variants.length]!);
      for (const variant of rotated) {
        results.push(await executeTrial({ workspaceRoot, manifest, driver, pool, variant, trialIndex }));
      }
    }

    const summary = summarize(manifest, results);
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const resultsFilePath = join(benchmarkDir, `real-results-${timestamp}.json`);
    const reportFilePath = join(benchmarkDir, `real-report-${timestamp}.md`);
    writeFileSync(resultsFilePath, JSON.stringify({ manifest, summary, rawResults: results }, null, 2), "utf8");
    writeFileSync(reportFilePath, renderMarkdown(summary, results), "utf8");
    return { summary, rawResults: results, resultsFilePath, reportFilePath };
  }
}

export function loadRealBenchmarkManifest(path: string): RealBenchmarkManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to read benchmark manifest '${path}': ${messageOf(error)}`);
  }
  return validateManifest(raw);
}

async function executeTrial(input: {
  workspaceRoot: string;
  manifest: RealBenchmarkManifest;
  driver: IAgyDriver;
  pool: IWorktreePool;
  variant: RealBenchmarkVariant;
  trialIndex: number;
}): Promise<RealBenchmarkTrial> {
  const { workspaceRoot, manifest, driver, pool, variant, trialIndex } = input;
  const trialId = `benchmark-${variant}-${trialIndex}-${Date.now()}`;
  const startedAt = Date.now();
  let trialRoot = "";
  try {
    trialRoot = await pool.acquire(trialId, manifest.baselineCommitSha);
    const worktreeHead = git(trialRoot, ["rev-parse", "HEAD"]).trim();
    if (worktreeHead !== manifest.baselineCommitSha) {
      throw new Error(`Trial worktree HEAD ${worktreeHead} differs from pinned baseline ${manifest.baselineCommitSha}.`);
    }

    if (variant === "oma_static_wave" || variant === "oma_dynamic_workflow") {
      installTrialPlugin(workspaceRoot, trialRoot);
      const report = await RealMissionExecutor.execute({
        workspaceRoot: trialRoot,
        missionId: trialId,
        goal: manifest.task.prompt,
        driver,
        model: manifest.model,
        effort: manifest.effort,
        timeoutMs: manifest.timeoutMs,
        maxWaves: variant === "oma_static_wave" ? 1 : manifest.maxDynamicWaves,
        gates: manifest.gates,
      });
      const evidencePath = preserveOmaTrialEvidence(workspaceRoot, trialRoot, trialId);
      return fromOmaReport({ variant, trialIndex, trialId, manifest, trialRoot, report, startedAt, evidencePath });
    }

    assertBaselineIsolation(trialRoot);
    const prompt = variant === "skills_only"
      ? `${manifest.task.prompt}\n\nStatic skill instructions:\n${manifest.skillsOnlyPrompt}`
      : manifest.task.prompt;
    const result = await driver.invoke({
      contractPrompt: prompt,
      persona: "worker",
      worktreeDir: trialRoot,
      timeoutMs: manifest.timeoutMs,
      modelOverride: manifest.model,
      reasoningEffort: manifest.effort,
      executionMode: "accept-edits",
      bare: true,
      runId: trialId,
    });
    const gateResults = executeGates(trialRoot, manifest.gates);
    const gatesPassed = gateResults.every((gate) => gate.exitCode === 0);
    const diff = git(trialRoot, ["diff", "--binary", "HEAD", "--"]);
    const evidencePath = preserveBareTrialEvidence(workspaceRoot, trialId, result, gateResults, diff);
    return {
      variant,
      trialIndex,
      trialId,
      timestamp: new Date().toISOString(),
      baselineCommitSha: manifest.baselineCommitSha,
      worktreeHead,
      model: manifest.model,
      effort: manifest.effort,
      durationMs: Date.now() - startedAt,
      totalTokens: tokenCount(result.parsedOutput),
      status: statusFromDriver(result, gatesPassed),
      gatesPassed,
      gateResults,
      diffHash: diff.trim().length === 0 ? null : sha256(diff),
      receiptHashes: [result.receipt.receiptHash],
      commitShas: [],
      runsCount: 1,
      wavesCount: 1,
      diagnostics: result.error ? [result.error] : gateResults.filter((gate) => gate.exitCode !== 0).map((gate) => `Gate failed: ${gate.id}`),
      intervention: variant === "vanilla_agy" ? "bare_agy" : "static_skill_prompt",
      evidencePath,
    };
  } catch (error) {
    return {
      variant,
      trialIndex,
      trialId,
      timestamp: new Date().toISOString(),
      baselineCommitSha: manifest.baselineCommitSha,
      worktreeHead: trialRoot && existsSync(trialRoot) ? tryGitHead(trialRoot) : "unavailable",
      model: manifest.model,
      effort: manifest.effort,
      durationMs: Date.now() - startedAt,
      totalTokens: null,
      status: "blocked",
      gatesPassed: false,
      gateResults: [],
      diffHash: null,
      receiptHashes: [],
      commitShas: [],
      runsCount: 0,
      wavesCount: 0,
      diagnostics: [messageOf(error)],
      intervention: interventionFor(variant),
      evidencePath: null,
    };
  } finally {
    if (trialRoot) {
      await pool.release(trialId, true);
    }
  }
}

function fromOmaReport(input: {
  variant: RealBenchmarkVariant;
  trialIndex: number;
  trialId: string;
  manifest: RealBenchmarkManifest;
  trialRoot: string;
  report: RealMissionReport;
  startedAt: number;
  evidencePath: string | null;
}): RealBenchmarkTrial {
  const eventsPath = join(input.trialRoot, ".oma", "missions", input.trialId, "events.jsonl");
  const events = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8").split(/\r?\n/u).filter(Boolean) : [];
  const receipts = events
    .filter((event) => event.includes("\"artifact_created\""))
    .map((event) => sha256(event));
  const gatesPassed = input.report.status === "succeeded";
  return {
    variant: input.variant,
    trialIndex: input.trialIndex,
    trialId: input.trialId,
    timestamp: new Date().toISOString(),
    baselineCommitSha: input.manifest.baselineCommitSha,
    worktreeHead: input.manifest.baselineCommitSha,
    model: input.manifest.model,
    effort: input.manifest.effort,
    durationMs: Date.now() - input.startedAt,
    totalTokens: null,
    status: input.report.status === "succeeded" ? "succeeded" : "failed",
    gatesPassed,
    gateResults: [],
    diffHash: input.report.commitShas.length > 0 ? sha256(input.report.commitShas.join("\n")) : null,
    receiptHashes: receipts,
    commitShas: input.report.commitShas,
    runsCount: events.filter((event) => event.includes("\"run_started\"")).length,
    wavesCount: input.report.totalWaves,
    diagnostics: input.report.diagnostics,
    intervention: input.variant === "oma_static_wave" ? "oma_one_wave" : "oma_dynamic_graph",
    evidencePath: input.evidencePath,
  };
}

function preserveOmaTrialEvidence(workspaceRoot: string, trialRoot: string, trialId: string): string | null {
  const source = join(trialRoot, ".oma", "missions", trialId);
  if (!existsSync(source)) return null;
  const target = join(workspaceRoot, ".oma", "benchmark", "trials", trialId, "mission");
  mkdirSync(join(workspaceRoot, ".oma", "benchmark", "trials", trialId), { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
  return benchmarkRelativePath(workspaceRoot, target);
}

function preserveBareTrialEvidence(
  workspaceRoot: string,
  trialId: string,
  result: DriverExecutionResult,
  gateResults: RealBenchmarkGateResult[],
  diff: string,
): string {
  const target = join(workspaceRoot, ".oma", "benchmark", "trials", trialId);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "run.json"), JSON.stringify({
    receipt: result.receipt,
    status: result.status,
    error: result.error,
    stdout: result.scrubbedStdout,
    stderr: result.scrubbedStderr,
    parsedOutput: result.parsedOutput,
    gateResults,
  }, null, 2), "utf8");
  writeFileSync(join(target, "worker.diff"), diff, "utf8");
  return benchmarkRelativePath(workspaceRoot, target);
}

function benchmarkRelativePath(workspaceRoot: string, path: string): string {
  return relative(workspaceRoot, path).replace(/\\/gu, "/");
}

function executeGates(cwd: string, gates: OracleGate[]): RealBenchmarkGateResult[] {
  return gates.map((gate) => {
    const startedAt = Date.now();
    const result = spawnSync(gate.program, gate.args, {
      cwd,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: gate.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      id: gate.id,
      exitCode: result.status ?? 124,
      durationMs: Date.now() - startedAt,
      stdoutHash: sha256(result.stdout ?? ""),
      stderrHash: sha256(result.stderr ?? result.error?.message ?? ""),
    };
  });
}

function summarize(manifest: RealBenchmarkManifest, trials: RealBenchmarkTrial[]): RealBenchmarkSummary {
  const variants: RealBenchmarkVariant[] = ["vanilla_agy", "skills_only", "oma_static_wave", "oma_dynamic_workflow"];
  const resultsByVariant = {} as RealBenchmarkSummary["resultsByVariant"];
  for (const variant of variants) {
    const sample = trials.filter((trial) => trial.variant === variant);
    const knownTokens = sample.map((trial) => trial.totalTokens).filter((tokens): tokens is number => tokens !== null);
    resultsByVariant[variant] = {
      successRate: sample.length === 0 ? 0 : sample.filter((trial) => trial.status === "succeeded" && trial.gatesPassed).length / sample.length,
      meanDurationMs: mean(sample.map((trial) => trial.durationMs)),
      meanTokens: knownTokens.length === sample.length ? mean(knownTokens) : null,
      meanRuns: mean(sample.map((trial) => trial.runsCount)),
      meanWaves: mean(sample.map((trial) => trial.wavesCount)),
    };
  }
  return {
    taskId: manifest.task.id,
    baselineCommitSha: manifest.baselineCommitSha,
    trialsPerVariant: manifest.trialsPerVariant,
    resultsByVariant,
    interpretation: [
      "Every trial starts from the same pinned Git commit and uses the same task, model, effort, timeout and external gates.",
      "vanilla_agy and skills_only run without an OMA plugin in their fresh worktree; OMA variants copy the plugin only for their own intervention.",
      "A missing token field remains null. The report never estimates tokens from text length.",
      "Differences are empirical results for this manifest and sample, not a general performance claim.",
    ],
  };
}

function renderMarkdown(summary: RealBenchmarkSummary, trials: RealBenchmarkTrial[]): string {
  const variants: RealBenchmarkVariant[] = ["vanilla_agy", "skills_only", "oma_static_wave", "oma_dynamic_workflow"];
  const rows = variants.map((variant) => {
    const value = summary.resultsByVariant[variant];
    const passed = trials.filter((trial) => trial.variant === variant && trial.gatesPassed).length;
    return `| ${variant} | ${passed}/${summary.trialsPerVariant} | ${(value.successRate * 100).toFixed(1)}% | ${value.meanDurationMs.toFixed(0)} | ${value.meanTokens === null ? "unavailable" : value.meanTokens.toFixed(0)} | ${value.meanRuns.toFixed(1)} | ${value.meanWaves.toFixed(1)} |`;
  });
  return [
    "# OMA empirical comparison",
    "",
    `Task: ${summary.taskId}`,
    `Pinned baseline: ${summary.baselineCommitSha}`,
    `Trials per variant: ${summary.trialsPerVariant}`,
    "",
    "| Variant | Gates passed | Success rate | Mean duration ms | Mean tokens | Mean runs | Mean waves |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
    "## Interpretation",
    ...summary.interpretation.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

function validateManifest(value: unknown): RealBenchmarkManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.task)) {
    throw new Error("Benchmark manifest must use schemaVersion 1 and contain a task object.");
  }
  const manifest: RealBenchmarkManifest = {
    schemaVersion: 1,
    baselineCommitSha: stringField(value, "baselineCommitSha"),
    task: { id: stringField(value.task, "id"), prompt: stringField(value.task, "prompt") },
    model: stringField(value, "model"),
    effort: effortField(value.effort),
    timeoutMs: positiveInteger(value.timeoutMs, "timeoutMs", 300_000),
    trialsPerVariant: positiveInteger(value.trialsPerVariant, "trialsPerVariant", 20),
    maxDynamicWaves: positiveInteger(value.maxDynamicWaves, "maxDynamicWaves", 10),
    skillsOnlyPrompt: stringField(value, "skillsOnlyPrompt"),
    gates: gateList(value.gates),
  };
  if (!/^[a-f0-9]{40}$/u.test(manifest.baselineCommitSha)) {
    throw new Error("Benchmark manifest baselineCommitSha must be a full 40-character Git SHA.");
  }
  if (manifest.trialsPerVariant < 3) {
    throw new Error("Benchmark manifest trialsPerVariant must be at least 3.");
  }
  return manifest;
}

function gateList(value: unknown): OracleGate[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Benchmark manifest requires at least one external gate.");
  const ids = new Set<string>();
  return value.map((gate): OracleGate => {
    if (!isRecord(gate)) throw new Error("Benchmark gate must be an object.");
    const parsed = {
      id: stringField(gate, "id"),
      program: stringField(gate, "program"),
      args: stringArray(gate.args, "gate args"),
      timeoutMs: positiveInteger(gate.timeoutMs, "gate timeoutMs", 300_000),
    };
    if (ids.has(parsed.id) || !isAbsolute(parsed.program) || !existsSync(parsed.program)) {
      throw new Error(`Invalid or duplicate benchmark gate '${parsed.id}'.`);
    }
    ids.add(parsed.id);
    return parsed;
  });
}

function ensureBenchmarkBaseline(workspaceRoot: string, baselineCommitSha: string): void {
  const current = git(workspaceRoot, ["rev-parse", "HEAD"]).trim();
  if (current !== baselineCommitSha) {
    throw new Error(`Benchmark workspace HEAD ${current} does not equal manifest baselineCommitSha ${baselineCommitSha}.`);
  }
  const status = git(workspaceRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).oma/**", ":(exclude).agents/plugins/oma/**"]);
  if (status.trim().length > 0) {
    throw new Error("Benchmark requires a clean target Git workspace outside .oma.");
  }
}

function installTrialPlugin(sourceRoot: string, trialRoot: string): void {
  const source = join(sourceRoot, ".agents", "plugins", "oma");
  if (!existsSync(source)) {
    throw new Error("OMA benchmark variants require the workspace plugin at .agents/plugins/oma.");
  }
  const target = join(trialRoot, ".agents", "plugins", "oma");
  mkdirSync(join(trialRoot, ".agents", "plugins"), { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
}

function assertBaselineIsolation(trialRoot: string): void {
  if (existsSync(join(trialRoot, ".agents", "plugins", "oma"))) {
    throw new Error("Bare benchmark trial contains an OMA plugin and is not a valid baseline.");
  }
}

function statusFromDriver(result: DriverExecutionResult, gatesPassed: boolean): RealBenchmarkTrial["status"] {
  if (result.status === "timed_out") return "timed_out";
  return result.status === "success" && gatesPassed ? "succeeded" : "failed";
}

function tokenCount(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const direct = numberField(value.totalTokens) ?? numberField(value.total_tokens);
  if (direct !== null) return direct;
  if (!isRecord(value.usage)) return null;
  return numberField(value.usage.totalTokens) ?? numberField(value.usage.total_tokens);
}

function interventionFor(variant: RealBenchmarkVariant): RealBenchmarkTrial["intervention"] {
  if (variant === "vanilla_agy") return "bare_agy";
  if (variant === "skills_only") return "static_skill_prompt";
  return variant === "oma_static_wave" ? "oma_one_wave" : "oma_dynamic_graph";
}

function tryGitHead(root: string): string {
  try {
    return git(root, ["rev-parse", "HEAD"]).trim();
  } catch {
    return "unavailable";
  }
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr ?? "").trim()}`);
  }
  return result.stdout ?? "";
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stringField(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || value[key].trim().length === 0) throw new Error(`Benchmark manifest field '${key}' must be a non-empty string.`);
  return value[key].trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`Benchmark ${label} must be an array of strings.`);
  return [...value];
}

function effortField(value: unknown): "low" | "medium" | "high" {
  if (value !== "low" && value !== "medium" && value !== "high") throw new Error("Benchmark manifest effort must be low, medium or high.");
  return value;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > maximum) throw new Error(`Benchmark manifest ${label} must be an integer from 1 to ${maximum}.`);
  return value;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
