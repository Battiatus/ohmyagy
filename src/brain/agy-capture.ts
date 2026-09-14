import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * AntiGravity capture primitives for the Neural Brain.
 *
 * Design constraint, captured on AGY 1.2.1 (see
 * `docs/audits/2026-09-11-oma-host-contract/REPORT.md`): a hook runs with
 * `cwd` set to its **plugin directory** and receives `workspacePaths: []`, so it
 * **cannot** determine which project it belongs to — the workspace root is
 * absent from the payload and from the transcript.
 *
 * Therefore the hook does the only thing it can do reliably: it appends a
 * cheap, project-agnostic record to a durable journal keyed by
 * `conversationId`. Attribution to a project, transcript condensation and the
 * Flash reformulation all happen later on the side that does know the workspace
 * (see `staging-drain.ts`).
 *
 * When the host *does* state a workspace (`workspacePaths`), the hook records it
 * verbatim and binds the conversation to it: a statement is not an inference, and it
 * is the only project signal the hook can be handed.
 *
 * Everything here is fail-open and side-effect-light: the hook must never be
 * able to damage the session it observes.
 */

export interface AgyToolCall {
  name?: string;
  args?: Record<string, unknown>;
}

export interface AgyHookPayload {
  conversationId?: string;
  stepIdx?: number;
  modelName?: string;
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  workspacePaths?: string[];
  toolCall?: AgyToolCall;
  error?: string;
}

/** One durable capture entry. Deliberately small: no transcript text here. */
export interface StagedCaptureRecord {
  at: string;
  conversationId: string;
  stepIdx: number | null;
  tool: string | null;
  failed: boolean;
  /** Absolute paths mentioned by the tool call; used later for attribution. */
  paths: string[];
  /**
   * The host's own `workspacePaths` for this step, when it sends any. Empty on the
   * hosts measured so far, but when present this is a statement rather than an
   * inference and it binds the conversation exactly.
   */
  workspacePaths: string[];
  transcriptPath?: string;
}

export interface TranscriptEntry {
  type?: string;
  step_index?: number;
  source?: string;
  content?: unknown;
  thinking?: unknown;
  tool_calls?: unknown;
  created_at?: string;
}

export interface CondensedTranscript {
  text: string;
  /** Highest `step_index` included, for cursor advancement. */
  lastStep: number;
  truncated: boolean;
}

const MAX_WALK_DEPTH = 6;
const MAX_COLLECTED_PATHS = 32;
const MAX_CONDENSED_CHARS = 4_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tolerant parse of a hook payload. Returns undefined rather than throwing. */
export function parseAgyHookPayload(raw: string): AgyHookPayload | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isPlainObject(decoded)) return undefined;

  const payload: AgyHookPayload = {};
  if (typeof decoded.conversationId === "string") payload.conversationId = decoded.conversationId;
  if (typeof decoded.stepIdx === "number") payload.stepIdx = decoded.stepIdx;
  if (typeof decoded.modelName === "string") payload.modelName = decoded.modelName;
  if (typeof decoded.transcriptPath === "string") payload.transcriptPath = decoded.transcriptPath;
  if (typeof decoded.artifactDirectoryPath === "string") {
    payload.artifactDirectoryPath = decoded.artifactDirectoryPath;
  }
  if (typeof decoded.error === "string") payload.error = decoded.error;
  if (Array.isArray(decoded.workspacePaths)) {
    payload.workspacePaths = decoded.workspacePaths.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  if (isPlainObject(decoded.toolCall)) {
    const toolCall: AgyToolCall = {};
    if (typeof decoded.toolCall.name === "string") toolCall.name = decoded.toolCall.name;
    if (isPlainObject(decoded.toolCall.args)) {
      toolCall.args = decoded.toolCall.args as Record<string, unknown>;
    }
    payload.toolCall = toolCall;
  }
  return payload;
}

/**
 * The host session key. AGY names it `conversationId`; the Claude and Gemini
 * spellings are accepted as fallbacks so a payload from another harness still
 * scopes correctly.
 */
export function resolveConversationId(payload: AgyHookPayload): string | undefined {
  const candidates = [payload.conversationId];
  if (isPlainObject(payload)) {
    const extra = payload as Record<string, unknown>;
    if (typeof extra.session_id === "string") candidates.push(extra.session_id);
    if (typeof extra.sessionId === "string") candidates.push(extra.sessionId);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/gu, "_");
  return cleaned.length > 0 ? cleaned : "unknown";
}

/** Global, project-agnostic staging root. Lives beside the Brain, not inside a project. */
export function omaStagingDir(homeDirectory: string = homedir()): string {
  return join(homeDirectory, ".oma", "staging");
}

export function stagingJournalPath(conversationId: string, homeDirectory?: string): string {
  return join(
    omaStagingDir(homeDirectory ?? homedir()),
    `${safeSegment(conversationId)}.jsonl`,
  );
}

/** Cursor of the last transcript step already folded into the Brain, per project. */
export function stagingCursorPath(
  workspaceRoot: string,
  conversationId: string,
): string {
  return join(
    resolve(workspaceRoot),
    ".oma",
    "staging-cursors",
    `${safeSegment(conversationId)}.json`,
  );
}

/** Collect absolute paths mentioned anywhere in a tool-call argument tree. */
export function collectAbsolutePaths(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_COLLECTED_PATHS) return;
    if (typeof node === "string") {
      if (node.length > 0 && isAbsolute(node)) found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1);
      return;
    }
    if (isPlainObject(node)) {
      for (const entry of Object.values(node)) walk(entry, depth + 1);
    }
  };
  walk(value, 0);
  return [...new Set(found)];
}

/** Project one payload into a durable record, or undefined when nothing is capturable. */
export function toStagedRecord(
  payload: AgyHookPayload,
  at: string = new Date().toISOString(),
): StagedCaptureRecord | undefined {
  const conversationId = resolveConversationId(payload);
  if (!conversationId) return undefined;

  const record: StagedCaptureRecord = {
    at,
    conversationId,
    stepIdx: typeof payload.stepIdx === "number" ? payload.stepIdx : null,
    tool: payload.toolCall?.name ?? null,
    failed: typeof payload.error === "string" && payload.error.length > 0,
    paths: collectAbsolutePaths(payload.toolCall?.args),
    workspacePaths: (payload.workspacePaths ?? []).filter((entry) => isAbsolute(entry)),
  };
  if (payload.transcriptPath) record.transcriptPath = payload.transcriptPath;
  return record;
}

/** Bytes read from the journal tail to find the last recorded step. */
const JOURNAL_TAIL_BYTES = 8_192;

/**
 * Last recorded step, read from the journal tail only.
 *
 * This hook fires on *every* tool call, so a whole-file read would make capture
 * cost grow with session length. Scanning the tail keeps it O(1); a partial first
 * line from a non-boundary read is simply skipped, which is harmless because the
 * scan runs backwards.
 */
function lastRecordedStep(journalPath: string): number | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(journalPath, "r");
    const size = fstatSync(descriptor).size;
    if (size === 0) return null;
    const length = Math.min(size, JOURNAL_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    const lines = buffer
      .toString("utf8")
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]) as unknown;
        if (isPlainObject(parsed) && typeof parsed.stepIdx === "number") return parsed.stepIdx;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Closing a failed handle is not actionable.
      }
    }
  }
  return null;
}

/**
 * Append a record to the durable journal, skipping a step already recorded.
 *
 * Never throws: a capture failure must not surface to the session. Returns
 * whether the record was actually appended.
 */
export function appendStagedRecord(
  record: StagedCaptureRecord,
  homeDirectory?: string,
): boolean {
  try {
    const journalPath = stagingJournalPath(record.conversationId, homeDirectory);
    if (record.stepIdx !== null) {
      const previous = lastRecordedStep(journalPath);
      if (previous !== null && record.stepIdx <= previous) return false;
    }
    mkdirSync(omaStagingDir(homeDirectory ?? homedir()), { recursive: true });
    appendFileSync(journalPath, `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function readStagedRecords(journalPath: string): StagedCaptureRecord[] {
  if (!existsSync(journalPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(journalPath, "utf8");
  } catch {
    return [];
  }
  const records: StagedCaptureRecord[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isPlainObject(parsed)) continue;
      const conversationId = parsed.conversationId;
      if (typeof conversationId !== "string") continue;
      records.push({
        at: typeof parsed.at === "string" ? parsed.at : new Date(0).toISOString(),
        conversationId,
        stepIdx: typeof parsed.stepIdx === "number" ? parsed.stepIdx : null,
        tool: typeof parsed.tool === "string" ? parsed.tool : null,
        failed: parsed.failed === true,
        paths: Array.isArray(parsed.paths)
          ? parsed.paths.filter((entry): entry is string => typeof entry === "string")
          : [],
        workspacePaths: Array.isArray(parsed.workspacePaths)
          ? parsed.workspacePaths.filter((entry): entry is string => typeof entry === "string")
          : [],
        transcriptPath:
          typeof parsed.transcriptPath === "string" ? parsed.transcriptPath : undefined,
      });
    } catch {
      continue;
    }
  }
  return records;
}

function containsPath(root: string, target: string): boolean {
  const fromRoot = relative(resolve(root), resolve(target));
  return (
    fromRoot.length === 0 ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

/**
 * Attribution rule: a record belongs to a workspace when one of its tool-call
 * paths lies inside that workspace. It is deliberately conservative — an
 * unattributable conversation is left in the journal rather than poured into the
 * wrong project.
 */
export function isRecordAttributedTo(
  record: StagedCaptureRecord,
  workspaceRoot: string,
): boolean {
  return record.paths.some((path) => containsPath(workspaceRoot, path));
}

/** Read a transcript tolerantly; a missing or partial file yields an empty list. */
export function readTranscriptEntries(transcriptPath: string): TranscriptEntry[] {
  if (!existsSync(transcriptPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isPlainObject(parsed)) continue;
      const entry: TranscriptEntry = {};
      if (typeof parsed.type === "string") entry.type = parsed.type;
      if (typeof parsed.step_index === "number") entry.step_index = parsed.step_index;
      if (typeof parsed.source === "string") entry.source = parsed.source;
      if (typeof parsed.created_at === "string") entry.created_at = parsed.created_at;
      if (parsed.content !== undefined) entry.content = parsed.content;
      if (parsed.thinking !== undefined) entry.thinking = parsed.thinking;
      if (parsed.tool_calls !== undefined) entry.tool_calls = parsed.tool_calls;
      entries.push(entry);
    } catch {
      continue;
    }
  }
  return entries;
}

function renderValue(value: unknown, limit = 600): string {
  if (typeof value === "string") return value.slice(0, limit);
  try {
    return JSON.stringify(value).slice(0, limit);
  } catch {
    return "";
  }
}

function toolNamesOf(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const names: string[] = [];
  for (const call of toolCalls) {
    if (isPlainObject(call)) {
      const name = call.name ?? (isPlainObject(call.function) ? call.function.name : undefined);
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

/**
 * Condense transcript entries newer than `fromStepExclusive` into compact text.
 *
 * The transcript is structured (`USER_INPUT`, `PLANNER_RESPONSE` with `thinking`
 * and `tool_calls`), so this is a rendering job — never a raw text scrape. The
 * output is bounded so a long session cannot grow the Brain without limit.
 */
export function condenseTranscript(
  entries: readonly TranscriptEntry[],
  fromStepExclusive = -1,
  maxChars = MAX_CONDENSED_CHARS,
): CondensedTranscript {
  const fresh = entries
    .filter(
      (entry) => typeof entry.step_index === "number" && entry.step_index > fromStepExclusive,
    )
    .sort((left, right) => (left.step_index ?? 0) - (right.step_index ?? 0));

  const lines: string[] = [];
  let lastStep = fromStepExclusive;
  let truncated = false;

  for (const entry of fresh) {
    if (typeof entry.step_index === "number") lastStep = Math.max(lastStep, entry.step_index);
    const step = entry.step_index ?? "?";
    if (entry.type === "USER_INPUT") {
      lines.push(`USER[${step}]: ${renderValue(entry.content)}`);
    } else if (entry.type === "PLANNER_RESPONSE") {
      if (entry.thinking !== undefined) {
        lines.push(`ASSISTANT_THINKING[${step}]: ${renderValue(entry.thinking)}`);
      }
      const tools = toolNamesOf(entry.tool_calls);
      if (tools.length > 0) lines.push(`ASSISTANT_TOOLS[${step}]: ${tools.join(", ")}`);
      if (entry.thinking === undefined && tools.length === 0 && entry.content !== undefined) {
        lines.push(`ASSISTANT[${step}]: ${renderValue(entry.content)}`);
      }
    } else if (entry.type) {
      lines.push(`${entry.type}[${step}]: ${renderValue(entry.content)}`);
    }
  }

  let text = lines.join("\n");
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n[...truncated]`;
    truncated = true;
  }

  return { text, lastStep, truncated };
}

export function readStagingCursor(workspaceRoot: string, conversationId: string): number {
  const path = stagingCursorPath(workspaceRoot, conversationId);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isPlainObject(parsed) && typeof parsed.lastStep === "number") return parsed.lastStep;
  } catch {
    // Absent cursor means nothing has been folded in yet.
  }
  return -1;
}

export function writeStagingCursor(
  workspaceRoot: string,
  conversationId: string,
  lastStep: number,
): void {
  const path = stagingCursorPath(workspaceRoot, conversationId);
  try {
    mkdirSync(join(resolve(workspaceRoot), ".oma", "staging-cursors"), { recursive: true });
    const temporaryPath = `${path}.tmp`;
    writeFileSync(
      temporaryPath,
      JSON.stringify({ conversationId, lastStep, at: new Date().toISOString() }),
      "utf8",
    );
    renameSync(temporaryPath, path);
  } catch {
    // A lost cursor costs a replay, never correctness.
  }
}
