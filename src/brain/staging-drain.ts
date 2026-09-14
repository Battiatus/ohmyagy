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
import {
  bindConversation,
  readConversationBinding,
  readRegisteredWorkspaces,
  sameWorkspacePath,
} from "./workspace-registry.js";

/**
 * Fold the project-agnostic capture journal into the project-scoped Neural Brain.
 *
 * The hook cannot know which project it belongs to (its `cwd` is its plugin
 * directory and the payload carries no workspace root), so it only appends. This
 * drain runs on the side that *does* know the workspace, and performs the three
 * steps the hook must not: attribution, transcript condensation, and Flash
 * reformulation.
 *
 * Attribution is decided by evidence, never by the draining project's own reach:
 * an existing conversation binding, then the host's stated `workspacePaths`, then a
 * **unique** registered project among the paths the conversation touched. Anything
 * else — several candidates, or none — leaves the conversation in the journal and is
 * reported. The old rule accepted a conversation as soon as any observed path fell
 * inside the draining workspace, which is precisely how another project's records were
 * poured into this one.
 *
 * Everything is fail-open and idempotent: a conversation is only consumed once
 * its cursor has advanced.
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
  /** Bound to a different project. Never drained here, never rebound. */
  skippedOtherProject: number;
  /** Evidence names several registered projects. Refused rather than guessed. */
  skippedAmbiguous: number;
  /** No binding and no unambiguous evidence: left in the journal. */
  skippedUnattributed: number;
  errors: string[];
}

type Attribution =
  | { kind: "this-project"; source: string }
  | { kind: "other-project"; workspaceRoot: string }
  | { kind: "ambiguous"; candidates: readonly string[] }
  | { kind: "unknown" };

/**
 * Decide which project a captured conversation belongs to, by evidence only.
 *
 * Order matters, and every step is a statement rather than a guess:
 *
 *  1. an existing conversation binding — exact, and never re-derived;
 *  2. the host's own `workspacePaths` for those steps — the host stating its workspace;
 *  3. a **unique** registered project among the paths the conversation touched.
 *
 * The previous rule accepted a conversation as soon as *any* observed path fell inside
 * the draining workspace, which is how one project's records were poured into another:
 * an agent working in project B that reads a file in project A looks exactly like an
 * A conversation to that rule. Ambiguity is now refused and reported instead.
 */
function resolveAttribution(
  conversationId: string,
  records: readonly StagedCaptureRecord[],
  workspaceRoot: string,
  homeDirectory?: string,
): Attribution {
  const binding = readConversationBinding(conversationId, homeDirectory);
  if (binding !== undefined) {
    return sameWorkspacePath(binding.workspaceRoot, workspaceRoot)
      ? { kind: "this-project", source: binding.source }
      : { kind: "other-project", workspaceRoot: binding.workspaceRoot };
  }

  const declared = [
    ...new Set(records.flatMap((record) => record.workspacePaths ?? [])),
  ];
  if (declared.length === 1) {
    return sameWorkspacePath(declared[0], workspaceRoot)
      ? { kind: "this-project", source: "host-workspacePaths" }
      : { kind: "other-project", workspaceRoot: declared[0] };
  }
  if (declared.length > 1) return { kind: "ambiguous", candidates: declared };

  const candidates = readRegisteredWorkspaces(homeDirectory).filter((registration) =>
    records.some((record) => isRecordAttributedTo(record, registration.root)),
  );
  if (candidates.length > 1) {
    return { kind: "ambiguous", candidates: candidates.map((candidate) => candidate.root) };
  }
  if (candidates.length === 1) {
    return sameWorkspacePath(candidates[0].root, workspaceRoot)
      ? { kind: "this-project", source: `registry:${candidates[0].source}` }
      : { kind: "other-project", workspaceRoot: candidates[0].root };
  }
  return { kind: "unknown" };
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
    skippedOtherProject: 0,
    skippedAmbiguous: 0,
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
    const attribution = resolveAttribution(
      conversationId,
      records,
      options.workspaceRoot,
      options.homeDirectory,
    );
    if (attribution.kind === "other-project") {
      result.skippedOtherProject += 1;
      continue;
    }
    if (attribution.kind === "ambiguous") {
      result.skippedAmbiguous += 1;
      result.errors.push(
        `${conversationId}: evidence names several projects (${attribution.candidates.join(", ")}); left in the journal. Bind it explicitly if it belongs here.`,
      );
      continue;
    }
    if (attribution.kind === "unknown") {
      result.skippedUnattributed += 1;
      continue;
    }
    result.conversationsAttributed += 1;
    // Remember the decision so the next drain is exact rather than re-derived.
    try {
      bindConversation({
        conversationId,
        workspaceRoot: options.workspaceRoot,
        source: attribution.source,
        homeDirectory: options.homeDirectory,
      });
    } catch (error) {
      result.errors.push(
        `${conversationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const transcriptPath = transcriptPathOf(records);
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
