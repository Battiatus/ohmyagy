import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { BrainStore } from "./brain-store.js";
import { createFlashReformulator } from "./flash-summarizer.js";
import { captureInteraction, type Reformulator } from "./summarizer.js";
import {
  condenseTranscript,
  isRecordAttributedTo,
  omaStagingDir,
  readStagedRecords,
  readStagingCursor,
  readTranscriptEntries,
  writeStagingCursor,
  type StagedCaptureRecord,
} from "./agy-capture.js";

/**
 * Fold the project-agnostic capture journal into the project-scoped Neural Brain.
 *
 * The hook cannot know which project it belongs to (its `cwd` is its plugin
 * directory and the payload carries no workspace root), so it only appends. This
 * drain runs on the side that *does* know the workspace — the MCP broker, which
 * has `OMA_WORKSPACE_ROOT` — and performs the three steps the hook must not:
 * attribution, transcript condensation, and Flash reformulation.
 *
 * Everything is fail-open and idempotent: a conversation is only consumed once
 * its cursor has advanced, and an unattributable conversation is left in the
 * journal rather than poured into the wrong project.
 */

export interface DrainStagedOptions {
  brain: BrainStore;
  workspaceRoot: string;
  /** Overridable for tests; defaults to `os.homedir()`. */
  homeDirectory?: string;
  /** Injected in tests; defaults to the Flash reformulator. */
  reformulate?: Reformulator;
  maxCharsPerConversation?: number;
}

export interface DrainStagedResult {
  conversationsInspected: number;
  conversationsAttributed: number;
  captured: number;
  skippedUnattributed: number;
  errors: string[];
}

const DEFAULT_MAX_CHARS = 4_000;

/**
 * Map a host conversation to a durable Brain session, persisted under
 * `.oma/brain-session.json`. A new host session starts a fresh Brain session but
 * stays scoped to the same project, so project memory carries across sessions —
 * which is exactly what the host key (`conversationId`) is for.
 */
export function resolveBrainSessionId(
  brain: BrainStore,
  workspaceRoot: string,
  projectId: string,
  conversationId: string,
): string {
  const linkPath = join(workspaceRoot, ".oma", "brain-session.json");
  let link: Record<string, string> = {};
  if (existsSync(linkPath)) {
    try {
      const parsed = JSON.parse(readFileSync(linkPath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        link = parsed as Record<string, string>;
      }
    } catch {
      link = {};
    }
  }

  const key = conversationId.trim().length > 0 ? conversationId : "default";
  const existing = link[key];
  if (existing && brain.getSession(existing)) return existing;

  const session = brain.startSession({ projectId });
  link[key] = session.id;
  try {
    mkdirSync(join(workspaceRoot, ".oma"), { recursive: true });
    writeFileSync(linkPath, `${JSON.stringify(link, null, 2)}\n`, "utf8");
  } catch {
    // A missing mapping costs a new session next time; never fatal.
  }
  return session.id;
}

function transcriptPathOf(records: readonly StagedCaptureRecord[]): string | undefined {
  for (const record of records) {
    if (record.transcriptPath && existsSync(record.transcriptPath)) return record.transcriptPath;
  }
  return undefined;
}

export async function drainStagedCapture(
  options: DrainStagedOptions,
): Promise<DrainStagedResult> {
  const result: DrainStagedResult = {
    conversationsInspected: 0,
    conversationsAttributed: 0,
    captured: 0,
    skippedUnattributed: 0,
    errors: [],
  };

  const stagingDir = omaStagingDir(options.homeDirectory);
  let journals: string[];
  try {
    if (!existsSync(stagingDir)) return result;
    journals = readdirSync(stagingDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(stagingDir, name));
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }

  const project = options.brain.ensureProject({
    name: basename(options.workspaceRoot) || "workspace",
    rootPath: options.workspaceRoot,
  });
  const reformulate =
    options.reformulate ?? createFlashReformulator({ worktreeDir: options.workspaceRoot });
  const maxChars = options.maxCharsPerConversation ?? DEFAULT_MAX_CHARS;

  for (const journalPath of journals) {
    const records = readStagedRecords(journalPath);
    if (records.length === 0) continue;
    result.conversationsInspected += 1;

    const conversationId = records[0].conversationId;
    const attributed = records.filter((record) =>
      isRecordAttributedTo(record, options.workspaceRoot),
    );
    if (attributed.length === 0) {
      result.skippedUnattributed += 1;
      continue;
    }
    result.conversationsAttributed += 1;

    try {
      const transcriptPath = transcriptPathOf(attributed);
      if (!transcriptPath) continue;

      const fromStep = readStagingCursor(options.workspaceRoot, conversationId);
      const condensed = condenseTranscript(
        readTranscriptEntries(transcriptPath),
        fromStep,
        maxChars,
      );
      if (condensed.text.trim().length === 0) continue;

      const sessionId = resolveBrainSessionId(
        options.brain,
        options.workspaceRoot,
        project.id,
        conversationId,
      );

      await captureInteraction({
        brain: options.brain,
        projectId: project.id,
        sessionId,
        projectName: project.name,
        text: condensed.text,
        reformulate,
      });

      writeStagingCursor(options.workspaceRoot, conversationId, condensed.lastStep);
      result.captured += 1;
    } catch (error) {
      result.errors.push(
        `${conversationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return result;
}
