import { sha256 } from "../ledger/canonical.js";
import { SecretScrubber, defaultSecretScrubber } from "./secret-scrubber.js";
import type {
  DriverExecutionResult,
  DriverInvocationOptions,
  DriverStatus,
  IAgyDriver,
} from "./agy-driver.js";

export interface MockScenarioMatcher {
  persona?: string | RegExp;
  contractSubstring?: string;
  contractPattern?: RegExp;
  worktreeSubstring?: string;
  callIndex?: number;
}

export interface MockScenarioResponse {
  exitCode?: number;
  status?: DriverStatus;
  payload?: Record<string, unknown> | string;
  rawStderr?: string;
  delayMs?: number;
  simulateTimeout?: boolean;
  simulateOom?: boolean;
  simulateCrash?: boolean;
}

export interface MockScenario {
  id?: string;
  matcher: MockScenarioMatcher;
  response: MockScenarioResponse;
  consumeOnce?: boolean;
}

export interface MockInvocationRecord {
  index: number;
  options: DriverInvocationOptions;
  timestamp: string;
  result: DriverExecutionResult;
}

export interface MockAgyDriverOptions {
  secretScrubber?: SecretScrubber;
  defaultPayload?: Record<string, unknown>;
  instantTimeout?: boolean; // Si true, ne dort pas pendant timeoutMs lors des tests rapides
}

export class MockAgyDriver implements IAgyDriver {
  private scenarios: MockScenario[] = [];
  private invocations: MockInvocationRecord[] = [];
  private readonly scrubber: SecretScrubber;
  private readonly defaultPayload: Record<string, unknown>;
  private readonly instantTimeout: boolean;

  constructor(options: MockAgyDriverOptions = {}) {
    this.scrubber = options.secretScrubber ?? defaultSecretScrubber;
    this.defaultPayload = options.defaultPayload ?? {
      status: "success",
      summary: "Default mock execution completed successfully.",
      artifacts: [],
    };
    this.instantTimeout = options.instantTimeout ?? true;
  }

  public registerScenario(scenario: MockScenario): this {
    this.scenarios.push(scenario);
    return this;
  }

  public registerSuccess(
    persona: string | RegExp,
    payload: Record<string, unknown>,
    contractSubstring?: string,
  ): this {
    return this.registerScenario({
      matcher: { persona, contractSubstring },
      response: { exitCode: 0, status: "success", payload },
    });
  }

  public registerFailure(
    persona: string | RegExp,
    errorMessage: string,
    exitCode: number = 1,
    contractSubstring?: string,
  ): this {
    return this.registerScenario({
      matcher: { persona, contractSubstring },
      response: {
        exitCode,
        status: "failed",
        rawStderr: errorMessage,
        payload: { status: "failed", error: errorMessage },
      },
    });
  }

  public registerTimeout(persona: string | RegExp, contractSubstring?: string): this {
    return this.registerScenario({
      matcher: { persona, contractSubstring },
      response: { simulateTimeout: true },
    });
  }

  public clearScenarios(): void {
    this.scenarios = [];
  }

  public reset(): void {
    this.scenarios = [];
    this.invocations = [];
  }

  public getInvocations(): readonly MockInvocationRecord[] {
    return [...this.invocations];
  }

  public getInvocationsForPersona(persona: string): MockInvocationRecord[] {
    return this.invocations.filter((inv) => inv.options.persona === persona);
  }

  public getInvocationCount(): number {
    return this.invocations.length;
  }

  public lastInvocation(): MockInvocationRecord | undefined {
    return this.invocations[this.invocations.length - 1];
  }

  public async invoke(options: DriverInvocationOptions): Promise<DriverExecutionResult> {
    const callIndex = this.invocations.length;
    const startTime = Date.now();

    // Recherche d'un scénario correspondant
    const matchIndex = this.scenarios.findIndex((s) => this.matches(s.matcher, options, callIndex));

    let matchedScenario: MockScenario | undefined;
    if (matchIndex !== -1) {
      matchedScenario = this.scenarios[matchIndex];
      if (matchedScenario.consumeOnce) {
        this.scenarios.splice(matchIndex, 1);
      }
    }

    const response = matchedScenario?.response ?? {};

    // Simulation du délai
    if (response.delayMs && response.delayMs > 0) {
      await new Promise((r) => setTimeout(r, response.delayMs));
    }

    const runId = options.runId ?? `mock-run-${callIndex}`;
    const expertId = typeof options.persona === "string" ? options.persona : options.persona.id;
    const makeReceipt = (st: DriverStatus, code: number, outHash: string, sOutHash: string, dur: number) => {
      const raw = {
        runId,
        expertId,
        model: options.modelOverride ?? "mock-model",
        effort: options.reasoningEffort ?? "medium",
        sandbox: options.sandboxMode ?? "workspace-write",
        durationMs: dur,
        exitCode: code,
        status: st,
        stdoutHash: outHash,
        scrubbedStdoutHash: sOutHash,
      };
      return { ...raw, receiptHash: sha256(JSON.stringify(raw)) };
    };

    // Gestion du timeout
    if (response.simulateTimeout || (response.delayMs && response.delayMs > options.timeoutMs)) {
      if (!this.instantTimeout && response.delayMs) {
        await new Promise((r) => setTimeout(r, Math.min(options.timeoutMs, response.delayMs!)));
      }

      const dur = response.delayMs ?? options.timeoutMs;
      const outH = sha256("");
      const result: DriverExecutionResult = {
        exitCode: 124,
        status: "timed_out",
        timedOut: true,
        rawStdout: "",
        rawStderr: "Watchdog timer expired (simulated mock timeout).",
        scrubbedStdout: "",
        scrubbedStderr: "Watchdog timer expired (simulated mock timeout).",
        stdoutHash: outH,
        scrubbedStdoutHash: outH,
        durationMs: dur,
        receipt: makeReceipt("timed_out", 124, outH, outH, dur),
        error: "Task execution timed out by watchdog.",
      };

      this.recordInvocation(callIndex, options, result);
      return result;
    }

    // Simulation OOM
    if (response.simulateOom) {
      const dur = Date.now() - startTime;
      const outH = sha256("");
      const result: DriverExecutionResult = {
        exitCode: 137,
        status: "oom_killed",
        timedOut: false,
        rawStdout: "",
        rawStderr: "Process terminated due to simulated out-of-memory limits.",
        scrubbedStdout: "",
        scrubbedStderr: "Process terminated due to simulated out-of-memory limits.",
        stdoutHash: outH,
        scrubbedStdoutHash: outH,
        durationMs: dur,
        receipt: makeReceipt("oom_killed", 137, outH, outH, dur),
        error: "Process terminated due to out-of-memory limits.",
      };
      this.recordInvocation(callIndex, options, result);
      return result;
    }

    // Simulation Crash
    if (response.simulateCrash) {
      const dur = Date.now() - startTime;
      const outH = sha256("");
      const result: DriverExecutionResult = {
        exitCode: 255,
        status: "fatal_crash",
        timedOut: false,
        rawStdout: "",
        rawStderr: response.rawStderr ?? "Simulated fatal harness crash.",
        scrubbedStdout: "",
        scrubbedStderr: response.rawStderr ?? "Simulated fatal harness crash.",
        stdoutHash: outH,
        scrubbedStdoutHash: outH,
        durationMs: dur,
        receipt: makeReceipt("fatal_crash", 255, outH, outH, dur),
        error: "Process failed to start or crashed.",
      };
      this.recordInvocation(callIndex, options, result);
      return result;
    }

    // Construction de la charge utile (payload)
    const payload = response.payload ?? this.defaultPayload;
    let rawStdout: string;
    let parsedOutput: unknown;

    if (typeof payload === "string") {
      rawStdout = payload;
      try {
        parsedOutput = JSON.parse(payload);
      } catch {
        parsedOutput = undefined;
      }
    } else {
      rawStdout = JSON.stringify(payload, null, 2);
      parsedOutput = payload;
    }

    const exitCode = response.exitCode ?? 0;
    const rawStderr = response.rawStderr ?? "";
    const scrubbedStdout = this.scrubber.scrub(rawStdout);
    const scrubbedStderr = this.scrubber.scrub(rawStderr);

    let status: DriverStatus = response.status ?? (exitCode === 0 ? "success" : "failed");
    if (exitCode === 0 && parsedOutput === undefined) {
      status = "failed";
    }

    const dur = Date.now() - startTime;
    const outH = sha256(rawStdout);
    const sOutH = sha256(scrubbedStdout);

    const result: DriverExecutionResult = {
      exitCode,
      status,
      timedOut: false,
      parsedOutput,
      rawStdout,
      rawStderr,
      scrubbedStdout,
      scrubbedStderr,
      stdoutHash: outH,
      scrubbedStdoutHash: sOutH,
      durationMs: dur,
      receipt: makeReceipt(status, exitCode, outH, sOutH, dur),
      error:
        exitCode !== 0
          ? scrubbedStderr || "Task failed"
          : parsedOutput === undefined
            ? "Invalid JSON output"
            : undefined,
    };

    this.recordInvocation(callIndex, options, result);
    return result;
  }

  private matches(
    matcher: MockScenarioMatcher,
    options: DriverInvocationOptions,
    callIndex: number,
  ): boolean {
    if (matcher.callIndex !== undefined && matcher.callIndex !== callIndex) {
      return false;
    }

    const personaStr = typeof options.persona === "string" ? options.persona : options.persona.id;

    if (matcher.persona !== undefined) {
      if (typeof matcher.persona === "string" && matcher.persona !== personaStr) {
        return false;
      }
      if (matcher.persona instanceof RegExp && !matcher.persona.test(personaStr)) {
        return false;
      }
    }

    if (matcher.contractSubstring !== undefined && !options.contractPrompt.includes(matcher.contractSubstring)) {
      return false;
    }

    if (matcher.contractPattern !== undefined && !matcher.contractPattern.test(options.contractPrompt)) {
      return false;
    }

    if (matcher.worktreeSubstring !== undefined && !options.worktreeDir.includes(matcher.worktreeSubstring)) {
      return false;
    }

    return true;
  }

  private recordInvocation(
    index: number,
    options: DriverInvocationOptions,
    result: DriverExecutionResult,
  ): void {
    this.invocations.push({
      index,
      options: { ...options },
      timestamp: new Date().toISOString(),
      result,
    });
  }
}
