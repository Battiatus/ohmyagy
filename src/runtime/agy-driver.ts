import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { canonicalJson, sha256 } from "../ledger/canonical.js";
import { ProcessRunner, type ProcessRunResult } from "./process-runner.js";
import { SecretScrubber, defaultSecretScrubber } from "./secret-scrubber.js";
import { CapabilityResolver, type ExpertSpec, type ResolvedCapability } from "./capability-resolver.js";

export type DriverStatus =
  | "success"
  | "failed"
  | "timed_out"
  | "oom_killed"
  | "fatal_crash";

export interface DriverInvocationOptions {
  contractPrompt: string;
  persona: string | ExpertSpec;
  worktreeDir: string;
  timeoutMs: number;
  runId?: string;
  extraArgs?: string[];
  modelTier?: "frontier" | "balanced" | "fast";
  modelOverride?: string;
  reasoningEffort?: "low" | "medium" | "high";
  sandboxMode?: "workspace-write" | "read-only";
  executionMode?: "accept-edits" | "plan";
  useSandbox?: boolean;
  bare?: boolean;
  jsonSchemaPath?: string;
  env?: Record<string, string>;
  verbose?: boolean;
  streamToConsole?: boolean;
  consolePrefix?: string;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  preserveAgent?: boolean;
}

/**
 * How much longer the outer watchdog waits than the `--print-timeout` handed to agy.
 *
 * Strictly greater, so agy always gets to report its own timeout as JSON before the
 * harness kills it. A real dispatch loads a large global context: measured 69 s and 85 s
 * for a one-line answer, so this is a margin around a genuinely slow operation, not a
 * workaround for a hang.
 */
const WATCHDOG_GRACE_MS = 15_000;

export interface ExecutionReceipt {
  runId: string;
  expertId: string;
  model: string;
  effort: string;
  sandbox: string;
  durationMs: number;
  exitCode: number;
  status: DriverStatus;
  stdoutHash: string;
  scrubbedStdoutHash: string;
  receiptHash: string;
}

export interface DriverExecutionResult {
  exitCode: number;
  status: DriverStatus;
  timedOut: boolean;
  parsedOutput?: unknown;
  rawStdout: string;
  rawStderr: string;
  scrubbedStdout: string;
  scrubbedStderr: string;
  stdoutHash: string;
  scrubbedStdoutHash: string;
  durationMs: number;
  receipt: ExecutionReceipt;
  error?: string;
}

export interface IAgyDriver {
  invoke(options: DriverInvocationOptions): Promise<DriverExecutionResult>;
}

export interface AgyDriverOptions {
  executablePath?: string;
  secretScrubber?: SecretScrubber;
  processRunner?: typeof ProcessRunner;
  maxMemoryMb?: number;
}

export class AgyDriver implements IAgyDriver {
  private readonly executablePath: string;
  private readonly scrubber: SecretScrubber;
  private readonly processRunner: typeof ProcessRunner;
  private readonly maxMemoryMb: number;

  constructor(options: AgyDriverOptions = {}) {
    this.executablePath = options.executablePath ?? AgyDriver.resolveAgyBinary();
    this.scrubber = options.secretScrubber ?? defaultSecretScrubber;
    this.processRunner = options.processRunner ?? ProcessRunner;
    this.maxMemoryMb = options.maxMemoryMb ?? 4096;
  }

  public static resolveAgyBinary(): string {
    const explicit = process.env.OMA_AGY_BIN?.trim();
    if (explicit) {
      return explicit;
    }

    const isWindows = process.platform === "win32";
    const localAppData = process.env.LOCALAPPDATA;
    const appData = process.env.APPDATA;
    const userProfile = process.env.USERPROFILE;
    const programFiles = process.env.ProgramFiles;
    const wellKnownWindows = [
      localAppData ? join(localAppData, "agy", "bin", "agy.exe") : undefined,
      localAppData ? join(localAppData, "agy", "bin", "agy.cmd") : undefined,
      appData ? join(appData, "npm", "gemini.cmd") : undefined,
      appData ? join(appData, "npm", "gemini") : undefined,
      userProfile ? join(userProfile, "AppData", "Local", "agy", "bin", "agy.exe") : undefined,
      userProfile ? join(userProfile, "AppData", "Roaming", "npm", "gemini.cmd") : undefined,
      programFiles ? join(programFiles, "Google", "Antigravity", "agy.exe") : undefined,
      programFiles ? join(programFiles, "Antigravity", "agy.exe") : undefined,
    ].filter((candidate): candidate is string => Boolean(candidate));

    if (isWindows) {
      for (const wk of wellKnownWindows) {
        if (isRealAgyBinary(wk)) {
          try {
            return realpathSync(wk);
          } catch {
            return wk;
          }
        }
      }
    }

    const candidates = isWindows
      ? ["agy.exe", "agy.cmd", "gemini.cmd", "gemini.exe", "agy", "gemini"]
      : ["agy", "gemini"];

    for (const bin of candidates) {
      try {
        const proc = spawnSync(isWindows ? "where.exe" : "which", [bin], {
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
        if (proc.status === 0 && proc.stdout) {
          const lines = proc.stdout
            .trim()
            .split(/\r?\n/)
            .map((l: string) => l.trim())
            .filter(Boolean);

          for (const found of lines) {
            if (isRealAgyBinary(found)) {
              try {
                return realpathSync(found);
              } catch {
                return found;
              }
            }
          }
        }
      } catch {
        // Continue
      }
    }

    return isWindows ? "agy.exe" : "agy";
  }

  public async invoke(options: DriverInvocationOptions): Promise<DriverExecutionResult> {
    const resolvedCap: ResolvedCapability = CapabilityResolver.resolve(options.persona, {
      modelOverride: options.modelOverride,
      effortOverride: options.reasoningEffort,
    });

    const args = this.buildCliArguments(options, resolvedCap);

    const isStreamingConsole =
      options.streamToConsole ??
      options.verbose ??
      (process.env.OMA_VERBOSE === "true");

    const consolePrefix = options.consolePrefix ?? `[OMA:${resolvedCap.expertId}]`;

    const onStdoutChunk = (chunk: string) => {
      options.onStdoutChunk?.(chunk);
      if (isStreamingConsole) {
        process.stdout.write(`  ${consolePrefix} ${chunk}`);
      }
    };

    const onStderrChunk = (chunk: string) => {
      options.onStderrChunk?.(chunk);
      if (isStreamingConsole) {
        process.stderr.write(`  ${consolePrefix}:err ${chunk}`);
      }
    };

    const processResult: ProcessRunResult = await this.processRunner.execute({
      executable: this.executablePath,
      args,
      cwd: options.worktreeDir,
      env: options.env,
      // The watchdog must outlive agy's own `--print-timeout`, which is set from the same
      // `options.timeoutMs`. With both equal, the watchdog killed the child at the exact
      // instant agy would have returned its own timeout as a clean JSON error, so the
      // driver reported an empty stdout instead of the reason. Measured 2026-09-14: a
      // role dispatch was killed at 180 651 ms with `--print-timeout 180s` and produced
      // the empty-string hash.
      timeoutMs: options.timeoutMs + WATCHDOG_GRACE_MS,
      maxMemoryMb: this.maxMemoryMb,
      onStdoutChunk,
      onStderrChunk,
      scrubber: this.scrubber,
    });

    const rawStdout = processResult.stdout;
    const rawStderr = processResult.stderr;
    const scrubbedStdout = this.scrubber.scrub(rawStdout);
    const scrubbedStderr = this.scrubber.scrub(rawStderr);
    const stdoutHash = sha256(rawStdout);
    const scrubbedStdoutHash = sha256(scrubbedStdout);

    // Extraction & parsing du JSON structuré
    let { parsed, parseError } = this.extractStructuredOutput(rawStdout);
    if (isEmptyAgySuccessEnvelope(parsed)) {
      parsed = undefined;
      parseError = "AGY returned a successful envelope with an empty response";
    } else {
      parsed = unwrapAgyResponse(parsed);
    }

    // Classification du statut d'exécution
    let status: DriverStatus;
    let errorMessage: string | undefined;

    if (processResult.timedOut || processResult.exitCode === 124 || processResult.exitCode === 143) {
      status = "timed_out";
      errorMessage = "Task execution timed out by watchdog.";
    } else if (processResult.exitCode === 137) {
      status = "oom_killed";
      errorMessage = "Process terminated due to out-of-memory limits.";
    } else if (processResult.exitCode === 255) {
      status = "fatal_crash";
      errorMessage = `Process failed to start or crashed: ${scrubbedStderr || processResult.stderr}`;
    } else if (processResult.exitCode !== 0) {
      status = "failed";
      const parsedError =
        typeof parsed === "object" && parsed !== null && "error" in parsed && typeof (parsed as Record<string, unknown>).error === "string"
          ? String((parsed as Record<string, unknown>).error).trim()
          : undefined;
      errorMessage = `Process exited with non-zero code ${processResult.exitCode}: ${parsedError || scrubbedStderr || "Task failed"}`;
    } else {
      if (parsed !== undefined) {
        status = "success";
      } else {
        status = "failed";
        errorMessage = `Process returned exit code 0 but failed to provide valid JSON output: ${parseError}`;
      }
    }

    const runId = options.runId ?? `run-${Date.now()}`;
    const rawReceipt = {
      runId,
      expertId: resolvedCap.expertId,
      model: options.modelOverride ?? "agy-default",
      effort: options.reasoningEffort ?? "agy-default",
      sandbox: resolvedCap.sandbox,
      durationMs: processResult.durationMs,
      exitCode: processResult.exitCode,
      status,
      stdoutHash,
      scrubbedStdoutHash,
    };
    const receiptHash = sha256(canonicalJson(rawReceipt));
    const receipt: ExecutionReceipt = { ...rawReceipt, receiptHash };

    return {
      exitCode: processResult.exitCode,
      status,
      timedOut: processResult.timedOut || status === "timed_out",
      parsedOutput: parsed,
      rawStdout,
      rawStderr,
      scrubbedStdout,
      scrubbedStderr,
      stdoutHash,
      scrubbedStdoutHash,
      durationMs: processResult.durationMs,
      receipt,
      error: errorMessage,
    };
  }

  public buildCliArguments(
    options: DriverInvocationOptions,
    resolvedCap?: ResolvedCapability,
  ): string[] {
    const cap =
      resolvedCap ??
      CapabilityResolver.resolve(options.persona, {
        modelOverride: options.modelOverride,
        effortOverride: options.reasoningEffort,
      });

    const args: string[] = [
      "-p",
      options.contractPrompt,
      "--output-format",
      "json",
      "--add-dir",
      options.worktreeDir,
    ];

    // AGY otherwise attaches print-mode calls made from a temporary worktree to the
    // persistent `default-cli-project`. A run then inherits unrelated conversation state and
    // skills. OMA executes every graph node as an isolated, bounded turn, so it must receive
    // an isolated AGY project as well.
    if (options.modelOverride) {
      args.splice(2, 0, "--model", cap.modelSlug);
    }

    const supportsEffort =
      Boolean(options.modelOverride) &&
      !cap.modelSlug.toLowerCase().includes("pro") &&
      (cap.modelSlug.toLowerCase().includes("flash") ||
        cap.modelSlug.toLowerCase().includes("thinking"));

    if (options.reasoningEffort && supportsEffort) {
      args.push("--effort", options.reasoningEffort);
    }

    args.push("--print-timeout", `${Math.max(1, Math.ceil(options.timeoutMs / 1000))}s`);

    // Write-mode runs are non-interactive (`-p`) and must not name a custom `--agent`:
    //   1. agy 1.1.x hangs indefinitely when a custom agent is combined with
    //      `--mode accept-edits`, producing an empty diff until the watchdog kills it.
    //      A bare invocation performs the same edit and returns cleanly. The worker's
    //      real instructions travel in the prompt, so dropping `--agent` loses nothing.
    //   2. Without auto-approval agy also blocks waiting for interactive permission on
    //      each edit tool call. Safety is enforced at OMA's promotion layer (isolated
    //      worktree, dual review, external gates); the sandbox bounds the auto-approval.
    const autoApproveWrites = options.executionMode === "accept-edits";
    const preserveAgent =
      options.preserveAgent ??
      (process.env.OMA_PRESERVE_AGENT === "true");

    if (!options.bare && (!autoApproveWrites || preserveAgent)) {
      args.splice(2, 0, "--agent", cap.agentName);
    }

    if (options.executionMode) {
      args.push("--mode", options.executionMode);
    }

    if (autoApproveWrites) {
      args.push("--dangerously-skip-permissions");
    }

    if (options.useSandbox || autoApproveWrites) {
      args.push("--sandbox");
    }

    if (options.jsonSchemaPath) {
      args.push("--json-schema", options.jsonSchemaPath);
    }

    // Isolate every run in its own AGY project. Without it, a print-mode call made from a
    // temporary worktree is attached to the persistent `default-cli-project` and inherits
    // unrelated conversation state and skills across missions.
    args.push("--new-project");

    if (options.extraArgs && options.extraArgs.length > 0) {
      args.push(...options.extraArgs);
    }

    return args;
  }

  public extractStructuredOutput(stdout: string): { parsed?: unknown; parseError?: string } {
    if (!stdout || stdout.trim().length === 0) {
      return { parseError: "Empty stdout" };
    }

    const cleanStdout = stdout.replace(/\u001b\[[0-9;]*m/g, "").trim();

    try {
      const direct = JSON.parse(cleanStdout);
      return { parsed: direct };
    } catch {
      // Continue
    }

    const codeBlockMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(cleanStdout);
    if (codeBlockMatch && codeBlockMatch[1]) {
      try {
        const parsedCodeBlock = JSON.parse(codeBlockMatch[1].trim());
        return { parsed: parsedCodeBlock };
      } catch {
        // Continue
      }
    }

    const lines = cleanStdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const jsonObjects: unknown[] = [];
    for (const line of lines) {
      if ((line.startsWith("{") && line.endsWith("}")) || (line.startsWith("[") && line.endsWith("]"))) {
        try {
          const parsedLine = JSON.parse(line);
          jsonObjects.push(parsedLine);
        } catch {
          // Ignore non-json lines
        }
      }
    }

    if (jsonObjects.length > 0) {
      const terminalResult = jsonObjects
        .slice()
        .reverse()
        .find(
          (obj): obj is Record<string, unknown> =>
            typeof obj === "object" &&
            obj !== null &&
            (("type" in obj && (obj.type === "result" || obj.type === "completion")) ||
              "status" in obj ||
              "verdict" in obj),
        );

      if (terminalResult) {
        return { parsed: terminalResult };
      }

      return { parsed: jsonObjects[jsonObjects.length - 1] };
    }

    const firstBrace = cleanStdout.indexOf("{");
    const lastBrace = cleanStdout.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const candidate = cleanStdout.substring(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(candidate);
        return { parsed };
      } catch (err) {
        return {
          parseError: `Failed to parse extracted JSON candidate: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return { parseError: "No valid JSON structure found in output" };
  }
}

export function unwrapAgyResponse(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return parsed;
  const response = (parsed as Record<string, unknown>).response;
  if (typeof response !== "string") return parsed;
  try {
    return JSON.parse(response) as unknown;
  } catch {
    return parsed;
  }
}

/**
 * True when AGY reported a successful turn but its `response` field is empty.
 *
 * Measured on AGY 1.2.5 (2026-09-17): a print-mode run that hit the 3-minute
 * `--print-timeout` while a tool turn was still in progress exited 0 and emitted
 * `{"status":"SUCCESS","response":"","num_turns":1,...}`. The envelope is a success
 * shell around no answer at all, so treating it as a real result let a node be marked
 * `succeeded` with nothing produced. It is a failure: the driver must surface it as one
 * so the graph does not integrate an empty diff or attribute a verdict to no work.
 */
export function isEmptyAgySuccessEnvelope(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status.toUpperCase() : undefined;
  if (status !== "SUCCESS") return false;
  if (!("response" in record)) return false;
  const response = record.response;
  return typeof response === "string" && response.trim().length === 0;
}

function isRealAgyBinary(candidate: string): boolean {
  if (!candidate) return false;
  try {
    if (!existsSync(candidate)) return false;
  } catch {
    return false;
  }

  const normalizedName = basename(candidate).toLocaleLowerCase("en-US");
  if (process.platform === "win32") {
    return (
      normalizedName === "agy.exe" ||
      normalizedName === "agy.cmd" ||
      normalizedName === "gemini.cmd" ||
      normalizedName === "gemini.exe" ||
      normalizedName === "agy" ||
      normalizedName === "gemini"
    );
  }

  return normalizedName === "agy" || normalizedName === "gemini";
}
