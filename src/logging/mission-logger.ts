import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RunLoggerMetadata {
  runId: string;
  expertId: string;
  persona: string;
  model?: string;
  effort?: string;
  worktree?: string;
  prompt?: string;
}

export interface RunFinalizeOptions {
  exitCode: number;
  status: string;
  durationMs: number;
  parsedOutput?: unknown;
  error?: string;
}

export class RunLogger {
  private readonly logPath: string;
  private readonly expertId: string;
  private readonly verbose: boolean;
  private readonly streamConsole: boolean;
  private stdoutBuffer = "";

  constructor(
    logPath: string,
    metadata: RunLoggerMetadata,
    options: { verbose?: boolean; streamConsole?: boolean } = {},
  ) {
    this.logPath = logPath;
    this.expertId = metadata.expertId;
    this.verbose = options.verbose ?? false;
    this.streamConsole = options.streamConsole ?? false;

    const header = [
      "=".repeat(80),
      `OMA RUN LOG: ${metadata.runId}`,
      `Expert: ${metadata.expertId} (${metadata.persona})`,
      `Model: ${metadata.model ?? "default"} | Effort: ${metadata.effort ?? "default"}`,
      `Worktree: ${metadata.worktree ?? "N/A"}`,
      `Started: ${new Date().toISOString()}`,
      "=".repeat(80),
      metadata.prompt ? `\n--- CONTRACT PROMPT ---\n${metadata.prompt}\n-----------------------\n` : "",
      "--- LIVE OUTPUT STREAM ---\n",
    ].join("\n");

    writeFileSync(this.logPath, header, { encoding: "utf8" });
  }

  public getLogPath(): string {
    return this.logPath;
  }

  public handleStdoutChunk(chunk: string): void {
    try {
      appendFileSync(this.logPath, chunk, { encoding: "utf8" });
    } catch {}

    if (this.streamConsole || this.verbose) {
      const lines = (this.stdoutBuffer + chunk).split("\n");
      this.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length > 0) {
          process.stdout.write(`  [${this.expertId}] ${line}\n`);
        }
      }
    }
  }

  public handleStderrChunk(chunk: string): void {
    try {
      appendFileSync(this.logPath, `\n[STDERR] ${chunk}\n`, { encoding: "utf8" });
    } catch {}

    if (this.streamConsole || this.verbose) {
      process.stderr.write(`  [${this.expertId}:err] ${chunk}`);
    }
  }

  public finalize(summary: RunFinalizeOptions): void {
    if (this.stdoutBuffer.trim().length > 0 && (this.streamConsole || this.verbose)) {
      process.stdout.write(`  [${this.expertId}] ${this.stdoutBuffer}\n`);
      this.stdoutBuffer = "";
    }

    const parsedPreview = summary.parsedOutput
      ? `\n--- PARSED OUTPUT PREVIEW ---\n${JSON.stringify(summary.parsedOutput, null, 2)}\n`
      : "";

    const footer = [
      "\n" + "-".repeat(80),
      `FINISHED: status=${summary.status} exitCode=${summary.exitCode} duration=${summary.durationMs}ms`,
      summary.error ? `ERROR: ${summary.error}` : "",
      parsedPreview,
      "=".repeat(80),
      "",
    ].filter(Boolean).join("\n");

    try {
      appendFileSync(this.logPath, footer, { encoding: "utf8" });
    } catch {}
  }
}

export class MissionLogger {
  private readonly missionDir: string;
  private readonly missionLogPath: string;
  private readonly runsDir: string;
  private readonly diffsDir: string;
  private readonly gateLogsDir: string;
  private readonly verbose: boolean;

  constructor(missionDir: string, options: { verbose?: boolean } = {}) {
    this.missionDir = missionDir;
    this.verbose = options.verbose ?? false;
    this.missionLogPath = join(missionDir, "mission.log");
    this.runsDir = join(missionDir, "runs");
    this.diffsDir = join(missionDir, "diffs");
    this.gateLogsDir = join(missionDir, "gate-logs");

    mkdirSync(this.missionDir, { recursive: true });
    mkdirSync(this.runsDir, { recursive: true });
    mkdirSync(this.diffsDir, { recursive: true });
    mkdirSync(this.gateLogsDir, { recursive: true });
  }

  public log(tag: string, message: string, level: "INFO" | "WARN" | "ERROR" | "SUCCESS" = "INFO"): void {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] [${level}] [OMA:${tag}] ${message}`;

    try {
      appendFileSync(this.missionLogPath, formatted + "\n", { encoding: "utf8" });
    } catch {}

    const consolePrefix = `[OMA:${tag}]`;
    if (level === "ERROR") {
      console.error(`${consolePrefix} \x1b[31m${message}\x1b[0m`);
    } else if (level === "SUCCESS") {
      console.log(`${consolePrefix} \x1b[32m${message}\x1b[0m`);
    } else if (level === "WARN") {
      console.warn(`${consolePrefix} \x1b[33m${message}\x1b[0m`);
    } else {
      console.log(`${consolePrefix} ${message}`);
    }
  }

  public createRunLogger(
    metadata: RunLoggerMetadata,
    options: { streamConsole?: boolean } = {},
  ): RunLogger {
    const safeRunId = metadata.runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const logPath = join(this.runsDir, `${safeRunId}.log`);
    return new RunLogger(logPath, metadata, {
      verbose: this.verbose,
      streamConsole: options.streamConsole ?? this.verbose,
    });
  }

  public saveDiff(workItemId: string, diff: string): string {
    const safeId = workItemId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const diffPath = join(this.diffsDir, `${safeId}.patch`);
    try {
      writeFileSync(diffPath, diff, { encoding: "utf8" });
    } catch {}
    return diffPath;
  }

  public logGateResult(
    gateId: string,
    status: "passed" | "failed",
    diagnostics: string[],
    rawOutput?: string,
  ): void {
    const timestamp = new Date().toISOString();
    const safeGateId = gateId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const gateLogPath = join(this.gateLogsDir, `${safeGateId}.log`);

    const logContent = [
      `Timestamp: ${timestamp}`,
      `Gate: ${gateId}`,
      `Status: ${status.toUpperCase()}`,
      diagnostics.length > 0 ? `Diagnostics:\n${diagnostics.map((d) => `  - ${d}`).join("\n")}` : "",
      rawOutput ? `\n--- RAW GATE PROCESS OUTPUT ---\n${rawOutput}` : "",
    ].filter(Boolean).join("\n");

    try {
      appendFileSync(gateLogPath, logContent + "\n" + "-".repeat(60) + "\n", { encoding: "utf8" });
    } catch {}

    if (status === "failed") {
      this.log(`Gate:${gateId}`, `Gate REJECTED. Diagnostics: ${diagnostics.join("; ")} (Details: ${gateLogPath})`, "ERROR");
    } else {
      this.log(`Gate:${gateId}`, `Gate PASSED.`, "SUCCESS");
    }
  }

  public getMissionDir(): string {
    return this.missionDir;
  }
}
