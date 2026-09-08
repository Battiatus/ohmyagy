import type { BrainStore } from "./brain-store.js";
import type { MemoryDimension } from "./types.js";
import { MEMORY_DIMENSIONS } from "./types.js";

/**
 * Always-on interaction summarizer core.
 *
 * The product vision requires that *every* exchange be reformulated into
 * context + actions by a compact Gemini Flash mini-agent and persisted into the
 * Neural Brain — the claude-mem model — so a fresh session can resume a mission
 * with full continuity and OMA never repeats past mistakes.
 *
 * This module is the pure, side-effect-isolated core: it takes an already
 * extracted interaction text and an injected {@link Reformulator} (the Flash
 * call is dependency-injected so this logic is testable without an AGY binary),
 * reformulates, and persists. It is designed to **fail open** — a summarizer
 * failure must never break the user's session, and must never lose the raw
 * interaction.
 */

/** Structured summary produced by the Flash mini-agent. */
export interface StructuredSummary {
  userIntent: string;
  actionsTaken: string;
  outcome: string;
  /** Optional durable memory worth keeping beyond the interaction log. */
  memory?: {
    dimension: MemoryDimension;
    title: string;
    content: string;
    tags?: string[];
  };
}

/**
 * Reformulate a raw interaction text into a {@link StructuredSummary}. Returns
 * `null` when reformulation is unavailable or fails — the caller then falls back
 * to a raw, unsummarized capture so nothing is lost.
 */
export type Reformulator = (
  text: string,
  ctx: { projectName: string },
) => Promise<StructuredSummary | null>;

export interface SummarizerResult {
  recorded: boolean;
  summarized: boolean;
  interactionId?: string;
  memoryId?: string;
  skippedReason?: string;
  error?: string;
}

const MAX_RAW_OUTCOME = 600;

/**
 * Reformulate one interaction and persist it. Never throws; a failure is
 * reported in the result and degrades to a raw capture.
 */
export async function captureInteraction(params: {
  brain: BrainStore;
  projectId: string;
  sessionId: string;
  projectName: string;
  text: string;
  reformulate: Reformulator;
}): Promise<SummarizerResult> {
  const { brain, projectId, sessionId, projectName, text, reformulate } = params;

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { recorded: false, summarized: false, skippedReason: "empty_interaction" };
  }

  let summary: StructuredSummary | null = null;
  let reformulateError: string | undefined;
  try {
    summary = await reformulate(trimmed, { projectName });
  } catch (error) {
    reformulateError = error instanceof Error ? error.message : String(error);
  }

  try {
    const roundNumber = brain.listInteractions(sessionId).length;

    if (!summary) {
      // Fail-open fallback: never lose the raw interaction.
      const interaction = brain.recordInteraction({
        sessionId,
        roundNumber,
        userIntent: null,
        actionsTaken: null,
        outcome: truncate(trimmed, MAX_RAW_OUTCOME),
      });
      return {
        recorded: true,
        summarized: false,
        interactionId: interaction.id,
        error: reformulateError,
      };
    }

    const interaction = brain.recordInteraction({
      sessionId,
      roundNumber,
      userIntent: summary.userIntent || null,
      actionsTaken: summary.actionsTaken || null,
      outcome: summary.outcome || null,
    });

    let memoryId: string | undefined;
    if (summary.memory && isValidDimension(summary.memory.dimension) && summary.memory.title.trim()) {
      const entry = brain.storeMemory({
        projectId,
        sessionId,
        dimension: summary.memory.dimension,
        title: summary.memory.title,
        content: summary.memory.content,
        tags: sanitizeTags(summary.memory.tags),
      });
      memoryId = entry.id;
    }

    return {
      recorded: true,
      summarized: true,
      interactionId: interaction.id,
      memoryId,
    };
  } catch (error) {
    return {
      recorded: false,
      summarized: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Best-effort extraction of a compact interaction text from a hook payload.
 * Antigravity mirrors the Claude Code hook contract, so we defensively read the
 * fields a Stop / PostToolUse payload may carry, never assuming any are present.
 */
export function extractInteractionText(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const p = payload as Record<string, unknown>;
  const parts: string[] = [];

  pushString(parts, "prompt", p.prompt);
  pushString(parts, "user", p.user_message ?? p.userMessage);
  pushString(parts, "assistant", p.assistant_message ?? p.assistantMessage ?? p.response);

  const toolName = p.tool_name ?? p.toolName;
  if (typeof toolName === "string") {
    parts.push(`tool: ${toolName}`);
  }
  pushJson(parts, "tool_input", p.tool_input ?? p.toolInput);
  pushJson(parts, "tool_response", p.tool_response ?? p.toolResponse ?? p.tool_result);

  // A transcript array of {role, content} messages (last few carry the exchange).
  const messages = p.messages ?? p.transcript;
  if (Array.isArray(messages)) {
    for (const m of messages.slice(-6)) {
      if (m && typeof m === "object") {
        const role = String((m as Record<string, unknown>).role ?? "");
        const content = (m as Record<string, unknown>).content;
        const contentText =
          typeof content === "string" ? content : content ? JSON.stringify(content) : "";
        if (contentText) {
          parts.push(`${role}: ${contentText}`);
        }
      }
    }
  }

  return parts.join("\n").trim();
}

function pushString(parts: string[], label: string, value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    parts.push(`${label}: ${value.trim()}`);
  }
}

function pushJson(parts: string[], label: string, value: unknown): void {
  if (value !== undefined && value !== null) {
    try {
      parts.push(`${label}: ${JSON.stringify(value)}`);
    } catch {
      // Ignore non-serialisable payload fragments.
    }
  }
}

function isValidDimension(value: unknown): value is MemoryDimension {
  return typeof value === "string" && MEMORY_DIMENSIONS.includes(value as MemoryDimension);
}

function sanitizeTags(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) {
    return undefined;
  }
  return tags.filter((t): t is string => typeof t === "string");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
