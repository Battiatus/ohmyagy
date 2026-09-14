import { spawnSync } from "node:child_process";
import { AgyDriver, type IAgyDriver } from "../runtime/agy-driver.js";
import type { ExpertSpec } from "../runtime/capability-resolver.js";
import type { Reformulator, StructuredSummary } from "./summarizer.js";
import { MEMORY_DIMENSIONS, type MemoryDimension } from "./types.js";

/**
 * Gemini Flash reformulator: the compact mini-agent that always passes over an
 * interaction and compresses it into context + actions for the Neural Brain.
 *
 * It runs through the existing {@link AgyDriver} on the `fast` model class, read-only,
 * with a tight timeout and low effort — cheap enough to run on every exchange. Any
 * failure returns `null` so the caller falls back to a raw capture; the summarizer must
 * never break the session.
 */

/** Used only when the CLI cannot be asked. Verified present in AntiGravity 1.2.1. */
const FALLBACK_FLASH_MODEL = "gemini-3.8-flash-low";
const DEFAULT_TIMEOUT_MS = 25_000;

let cachedFlashModel: string | undefined;

/**
 * Which Flash slug to invoke.
 *
 * The installed build decides which slugs exist, and they churn. This module used to
 * hardcode `gemini-2.5-flash`, which is not a known model in AntiGravity 1.2.1 — and
 * because the process runner also swallowed the child's error, every reformulation
 * failed silently. Ask the CLI instead of pinning a name that rots.
 */
export function resolveFlashModel(): string {
  const override = process.env.OMA_FLASH_MODEL?.trim();
  if (override !== undefined && override.length > 0) return override;
  if (cachedFlashModel !== undefined) return cachedFlashModel;
  cachedFlashModel = pickFlashModel(listAgyModels()) ?? FALLBACK_FLASH_MODEL;
  return cachedFlashModel;
}

/** Prefer the cheapest Flash tier: memory summarisation is not a reasoning task. */
export function pickFlashModel(slugs: readonly string[]): string | undefined {
  return (
    slugs.find((slug) => /flash-low$/u.test(slug)) ??
    slugs.find((slug) => /flash-medium$/u.test(slug)) ??
    slugs.find((slug) => /flash-high$/u.test(slug)) ??
    slugs.find((slug) => slug.includes("flash"))
  );
}

/** `agy models` prints `<slug>\t<display name>` per line. Exit status is unreliable. */
function listAgyModels(): string[] {
  try {
    const binary = AgyDriver.resolveAgyBinary();
    if (binary === undefined || binary.length === 0) return [];
    const result = spawnSync(binary, ["models"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    return String(result.stdout ?? "")
      .split(/\r?\n/u)
      .map((line) => line.split("\t")[0].trim())
      .filter((slug) => /^[a-z0-9][a-z0-9.-]*$/u.test(slug));
  } catch {
    return [];
  }
}

const SUMMARIZER_PERSONA: ExpertSpec = {
  id: "oma-summarizer",
  role: "explorer",
  taskKinds: ["summarize"],
  modelClass: "fast",
  effort: "low",
  tools: [],
  readOnly: true,
};

function buildPrompt(text: string, projectName: string): string {
  const dimensions = MEMORY_DIMENSIONS.join(", ");
  return [
    "You are OMA's memory summarizer. Compress the following interaction from",
    `project "${projectName}" into a dense, factual record for a persistent memory store.`,
    "",
    "Return ONLY a single JSON object, no prose, with this exact shape:",
    "{",
    '  "context": "one or two sentences: user intent, starting situation, and context for this round",',
    '  "actions": "one or two sentences: what was actually done and the concrete outcome",',
    `  "memory": { "dimension": one of [${dimensions}], "title": "short title", "content": "durable fact worth keeping", "tags": ["..."] }`,
    "}",
    'Omit the "memory" field entirely unless a durable decision, error, preference or',
    "project fact genuinely emerged. Be terse. Do not invent facts not present below.",
    "",
    "=== INTERACTION ===",
    text,
    "=== END ===",
  ].join("\n");
}

export interface FlashReformulatorOptions {
  driver?: IAgyDriver;
  worktreeDir?: string;
  timeoutMs?: number;
}

/**
 * Create a {@link Reformulator} backed by a real Gemini Flash invocation.
 * The driver is injectable for testing.
 */
export function createFlashReformulator(
  options: FlashReformulatorOptions = {},
): Reformulator {
  const driver = options.driver ?? new AgyDriver();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (text, ctx) => {
    try {
      const result = await driver.invoke({
        contractPrompt: buildPrompt(text, ctx.projectName),
        persona: SUMMARIZER_PERSONA,
        worktreeDir: options.worktreeDir ?? process.cwd(),
        timeoutMs,
        modelOverride: resolveFlashModel(),
        reasoningEffort: "low",
        sandboxMode: "read-only",
        useSandbox: false,
        bare: true,
      });
      if (result.status !== "success") {
        return null;
      }
      return coerceSummary(result.parsedOutput) ?? coerceSummary(extractJson(result.rawStdout));
    } catch {
      return null;
    }
  };
}

/** Find the first balanced JSON object in a noisy stdout stream. */
function extractJson(stdout: string): unknown {
  if (typeof stdout !== "string") {
    return undefined;
  }
  const start = stdout.indexOf("{");
  if (start === -1) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stdout.length; i++) {
    const ch = stdout[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stdout.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Validate and normalise an untrusted parsed object into a StructuredSummary. */
function coerceSummary(value: unknown): StructuredSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const v = value as Record<string, unknown>;
  const context = asString(v.context) || asString(v.userIntent);
  const actions = asString(v.actions) || asString(v.actionsTaken);
  const outcome = asString(v.outcome);
  const nodeRef = asString(v.nodeRef) || asString(v.node_ref);

  if (!context && !actions && !outcome) {
    return null;
  }
  const summary: StructuredSummary = {
    context,
    actions,
    userIntent: context,
    actionsTaken: actions,
    outcome,
    ...(nodeRef ? { nodeRef } : {}),
  };

  const mem = v.memory;
  if (mem && typeof mem === "object") {
    const m = mem as Record<string, unknown>;
    const dimension = asString(m.dimension);
    const title = asString(m.title);
    if (MEMORY_DIMENSIONS.includes(dimension as MemoryDimension) && title) {
      summary.memory = {
        dimension: dimension as MemoryDimension,
        title,
        content: asString(m.content),
        tags: Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === "string") : undefined,
      };
    }
  }
  return summary;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
