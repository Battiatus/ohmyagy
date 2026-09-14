import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { safeSegment } from "./agy-capture.js";

/**
 * Project identity for the capture pipeline.
 *
 * A hook cannot know its project: AntiGravity runs it with `cwd` set to its plugin
 * directory and (measured on the CLI host) `workspacePaths: []`. The record it writes
 * is therefore project-agnostic, keyed by `conversationId`.
 *
 * Two durable artefacts close that gap **without inference**:
 *
 *  * a **workspace registry**, written by each broker that really did bind a workspace,
 *    so attribution can be decided against the set of known projects instead of against
 *    "does this touch my root" — the rule that poured another project's records into
 *    this one;
 *  * a **conversation binding**, which states which project a host conversation belongs
 *    to. Once bound, attribution is exact and never re-derived.
 *
 * Absent evidence, the answer is "unknown" and the records stay in the journal. Guessing
 * a project is the contamination bug, not a fallback.
 */

export interface WorkspaceRegistration {
  root: string;
  /** Who stated this workspace: `roots/list`, `OMA_WORKSPACE_ROOT`, `operator`, ... */
  source: string;
  lastSeenAt: string;
}

export interface ConversationBinding {
  conversationId: string;
  workspaceRoot: string;
  source: string;
  boundAt: string;
}

export function omaHomeDir(homeDirectory: string = homedir()): string {
  return join(homeDirectory, ".oma");
}

export function workspaceRegistryPath(homeDirectory?: string): string {
  return join(omaHomeDir(homeDirectory), "workspaces.json");
}

export function conversationBindingPath(
  conversationId: string,
  homeDirectory?: string,
): string {
  return join(
    omaHomeDir(homeDirectory),
    "conversations",
    `${safeSegment(conversationId)}.json`,
  );
}

/** Windows compares paths case-insensitively; POSIX does not. */
export function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? resolve(value).toLocaleLowerCase("en-US") : resolve(value);
  return normalize(left) === normalize(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJsonAtomically(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
}

export function readRegisteredWorkspaces(
  homeDirectory?: string,
): WorkspaceRegistration[] {
  const path = workspaceRegistryPath(homeDirectory);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const registrations: WorkspaceRegistration[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const { root, source, lastSeenAt } = entry;
    if (typeof root !== "string" || root.length === 0) continue;
    if (typeof source !== "string") continue;
    registrations.push({
      root: resolve(root),
      source,
      lastSeenAt: typeof lastSeenAt === "string" ? lastSeenAt : new Date(0).toISOString(),
    });
  }
  return registrations;
}

/**
 * Record that a broker really governs this workspace.
 *
 * Only a resolved identity may register: a broker that fell back to `process.cwd()`
 * has not established a project and must not put its directory into the set that
 * attribution is decided against.
 */
export function registerWorkspace(options: {
  workspaceRoot: string;
  source: string;
  homeDirectory?: string;
  at?: string;
}): void {
  const root = resolve(options.workspaceRoot);
  const at = options.at ?? new Date().toISOString();
  try {
    mkdirSync(omaHomeDir(options.homeDirectory), { recursive: true });
    const existing = readRegisteredWorkspaces(options.homeDirectory).filter(
      (registration) => !sameWorkspacePath(registration.root, root),
    );
    existing.push({ root, source: options.source, lastSeenAt: at });
    writeJsonAtomically(workspaceRegistryPath(options.homeDirectory), existing);
  } catch {
    // A missing registry costs attribution precision, never correctness.
  }
}

export function readConversationBinding(
  conversationId: string,
  homeDirectory?: string,
): ConversationBinding | undefined {
  const path = conversationBindingPath(conversationId, homeDirectory);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { workspaceRoot, source, boundAt } = parsed;
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) return undefined;
  return {
    conversationId,
    workspaceRoot: resolve(workspaceRoot),
    source: typeof source === "string" ? source : "unknown",
    boundAt: typeof boundAt === "string" ? boundAt : new Date(0).toISOString(),
  };
}

/** Bind a host conversation to exactly one project. An existing binding is never rewritten. */
export function bindConversation(options: {
  conversationId: string;
  workspaceRoot: string;
  source: string;
  homeDirectory?: string;
  at?: string;
  overwrite?: boolean;
}): ConversationBinding {
  const binding: ConversationBinding = {
    conversationId: options.conversationId,
    workspaceRoot: resolve(options.workspaceRoot),
    source: options.source,
    boundAt: options.at ?? new Date().toISOString(),
  };
  const existing = readConversationBinding(options.conversationId, options.homeDirectory);
  if (existing !== undefined && options.overwrite !== true) {
    if (!sameWorkspacePath(existing.workspaceRoot, binding.workspaceRoot)) {
      throw new Error(
        `Conversation '${options.conversationId}' is already bound to '${existing.workspaceRoot}' (${existing.source}); refusing to rebind it to '${binding.workspaceRoot}'.`,
      );
    }
    return existing;
  }
  try {
    mkdirSync(join(omaHomeDir(options.homeDirectory), "conversations"), { recursive: true });
    writeJsonAtomically(
      conversationBindingPath(options.conversationId, options.homeDirectory),
      binding,
    );
  } catch {
    // An unpersisted binding costs a re-derivation next time, never correctness.
  }
  return binding;
}
