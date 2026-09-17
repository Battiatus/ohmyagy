import { captureProcessIdentity, isRecord, writeProbeRecord, type ProbeTarget } from "./log.js";
import { probeHookLogDir } from "./paths.js";

/**
 * Probe hook: what does the host hand a hook, per tool call?
 *
 * The hook is the one surface measured so far that *does* state the workspace
 * (`workspacePaths` non-empty on 216 of 529 captured records), and it always carries a
 * `conversationId`. This probe records both verbatim, together with the hook's own
 * `cwd` and parent pid, so the report can decide whether the hook channel is enough to
 * identify a project per session — and whether it can be joined to an MCP server
 * instance.
 *
 * Two rules from the host contract, both non-negotiable:
 *  * `PostToolUse` must emit `{}`. Any other shape fails protojson decoding and the host
 *    reports a tool-execution error to the agent.
 *  * `PreToolUse` must never get in the way: this probe observes, it does not police.
 *    The words "observation only" are in the reason so a live session can never be
 *    misread as strict-mode enforcement by OMA's own gate.
 */

const READ_TIMEOUT_MS = 5_000;
const MAX_RAW_CHARS = 32_000;

const ENV_OF_INTEREST =
  /WORKSPACE|PROJECT|ROOT|FOLDER|CWD|PWD|SESSION|CONVERSATION|OMA|AGY|ANTIGRAVITY|GEMINI|CODEX/i;

export interface ProbeHookOptions {
  logDir?: string;
  event?: string;
  payload?: string;
  env?: NodeJS.ProcessEnv;
}

function readStdin(): Promise<string> {
  return new Promise<string>((settle) => {
    if (process.stdin.isTTY) {
      settle("");
      return;
    }
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, READ_TIMEOUT_MS);
    timer.unref();
    process.stdin.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

export function decideProbeOutput(event: string): Record<string, unknown> {
  // PreToolUse was measured accepting a decision object; every other event must receive
  // `{}`, which decodes into any of the host's per-event result messages.
  return event === "PreToolUse"
    ? { decision: "allow", reason: "oma-probe: observation only, this hook never polices." }
    : {};
}

export function describePayload(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { parsed: false, raw: raw.slice(0, MAX_RAW_CHARS) };
  }
  if (!isRecord(parsed)) return { parsed: false, raw: raw.slice(0, MAX_RAW_CHARS) };

  const toolCall = isRecord(parsed.toolCall) ? parsed.toolCall : undefined;
  const args = toolCall !== undefined && isRecord(toolCall.args) ? toolCall.args : undefined;
  const workspacePaths = Array.isArray(parsed.workspacePaths)
    ? parsed.workspacePaths.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    parsed: true,
    payloadKeys: Object.keys(parsed).sort(),
    conversationId: typeof parsed.conversationId === "string" ? parsed.conversationId : undefined,
    stepIdx: typeof parsed.stepIdx === "number" ? parsed.stepIdx : undefined,
    transcriptPath: typeof parsed.transcriptPath === "string" ? parsed.transcriptPath : undefined,
    artifactDirectoryPath:
      typeof parsed.artifactDirectoryPath === "string" ? parsed.artifactDirectoryPath : undefined,
    workspacePaths,
    hasWorkspacePaths: workspacePaths.length > 0,
    toolName: toolCall !== undefined && typeof toolCall.name === "string" ? toolCall.name : undefined,
    toolArgs: args,
    toolCwd: args !== undefined && typeof args.Cwd === "string" ? args.Cwd : undefined,
    error: typeof parsed.error === "string" ? parsed.error : undefined,
    raw: raw.slice(0, MAX_RAW_CHARS),
  };
}

function envOfInterest(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (ENV_OF_INTEREST.test(key)) picked[key] = value.slice(0, 1_000);
  }
  return picked;
}

export async function runProbeHook(options: ProbeHookOptions = {}): Promise<void> {
  const event = options.event ?? process.argv[2] ?? "unknown";
  const startedAt = Date.now();
  let raw = options.payload;
  if (raw === undefined) {
    try {
      raw = await readStdin();
    } catch {
      raw = "";
    }
  }

  const env = options.env ?? process.env;
  const target: ProbeTarget = {
    dir: options.logDir ?? probeHookLogDir(),
    file: `${process.pid}-${startedAt}-${Math.random().toString(36).slice(2, 8)}.jsonl`,
  };
  writeProbeRecord(target, "hook_invocation", {
    ...captureProcessIdentity(),
    event,
    eventFromArgv: process.argv[2],
    stdinBytes: raw.length,
    elapsedToLogMs: Date.now() - startedAt,
    envKeys: Object.keys(env).sort(),
    envOfInterest: envOfInterest(env),
    ...describePayload(raw),
  });
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("hook-probe.js") || process.argv[1].endsWith("hook-probe.ts"))
) {
  const event = process.argv[2] ?? "unknown";
  try {
    await runProbeHook({ event });
  } catch {
    // A probe that throws is a probe that breaks the session it measures.
  }
  process.stdout.write(`${JSON.stringify(decideProbeOutput(event))}\n`);
}
