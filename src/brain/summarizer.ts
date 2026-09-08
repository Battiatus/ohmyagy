import type { BrainStore } from "./brain-store.js";
import type { CompactionOptions, CompactionResult, MemoryDimension } from "./types.js";
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
  /** Canonical context: user intent, situation, and starting state this round. */
  context?: string;
  /** Canonical actions: what was done and the concrete outcome. */
  actions?: string;
  /** Backward-compatible alias for context. */
  userIntent?: string;
  /** Backward-compatible alias for actions. */
  actionsTaken?: string;
  outcome?: string;
  /** Optional node reference this exchange pertains to. */
  nodeRef?: string;
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
  compaction?: CompactionResult;
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
  nodeRef?: string;
  /** Auto-compaction trigger interval in rounds. Default: 10. Set to 0 to disable. */
  autoCompactInterval?: number;
  /** Optional compaction options passed to brain.compact. */
  compactionOptions?: CompactionOptions;
}): Promise<SummarizerResult> {
  const { brain, projectId, sessionId, projectName, text, reformulate, nodeRef } = params;

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
    const roundNumber = brain.getNextRoundNumber(sessionId);

    let interactionId: string;
    let memoryId: string | undefined;
    let summarized: boolean;

    if (!summary) {
      // Fail-open fallback: never lose the raw interaction.
      const interaction = brain.recordInteraction({
        sessionId,
        roundNumber,
        userIntent: null,
        actionsTaken: null,
        outcome: truncate(trimmed, MAX_RAW_OUTCOME),
        nodeRef: nodeRef ?? null,
      });
      interactionId = interaction.id;
      summarized = false;
    } else {
      const resolvedContext = summary.context || summary.userIntent || null;
      const resolvedActions = summary.actions || summary.actionsTaken || null;
      const resolvedNodeRef = nodeRef ?? summary.nodeRef ?? null;

      const interaction = brain.recordInteraction({
        sessionId,
        roundNumber,
        userIntent: resolvedContext,
        actionsTaken: resolvedActions,
        outcome: summary.outcome || null,
        nodeRef: resolvedNodeRef,
      });
      interactionId = interaction.id;
      summarized = true;

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
    }

    // Hook automatic compaction after N rounds in fail-open mode
    const autoCompactInterval = params.autoCompactInterval ?? 10;
    let compaction: CompactionResult | undefined;
    if (autoCompactInterval > 0 && (roundNumber + 1) % autoCompactInterval === 0) {
      try {
        compaction = brain.compact({
          projectId,
          ...params.compactionOptions,
        });
      } catch {
        // Fail-open: memory compaction failure must never break capture
      }
    }

    return {
      recorded: true,
      summarized,
      interactionId,
      ...(memoryId ? { memoryId } : {}),
      ...(reformulateError ? { error: reformulateError } : {}),
      ...(compaction ? { compaction } : {}),
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
