import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
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

/**
 * OMA's per-user state root.
 *
 * `OMA_HOME` overrides it so a test suite never writes into the developer's real
 * `~/.oma`: the registry and the capture journal are machine-wide by design, which is
 * exactly why they must be redirectable.
 */
export function omaHomeDir(homeDirectory?: string): string {
  const override = homeDirectory ?? process.env.OMA_HOME;
  const base = override !== undefined && override.length > 0 ? override : homedir();
  return join(base, ".oma");
}

export function workspaceRegistryDir(homeDirectory?: string): string {
  return join(omaHomeDir(homeDirectory), "workspaces");
}

/**
 * Durable trace of every attempt to bind a workspace.
 *
 * Whether the host answers `roots/list` decides which project a session governs, and there is no
 * way to ask after the fact: the session is over. One append-only line per broker start records
 * the outcome, so the next `doctor` can say what actually happened instead of leaving it to
 * whoever was watching the terminal.
 */
export function bindAttemptsPath(homeDirectory?: string): string {
  return join(omaHomeDir(homeDirectory), "bind-attempts.jsonl");
}

export type BindOutcome = "roots/list" | "explicit" | "unresolved" | "refused-install-tree";

export interface BindAttempt {
  at: string;
  /** What the broker believed it governed, when it got that far. */
  root: string | null;
  outcome: BindOutcome;
  cwd: string;
  detail?: string;
}

export function recordBindAttempt(
  attempt: Omit<BindAttempt, "at"> & { at?: string; homeDirectory?: string },
): void {
  const record: BindAttempt = {
    at: attempt.at ?? new Date().toISOString(),
    root: attempt.root,
    outcome: attempt.outcome,
    cwd: attempt.cwd,
    ...(attempt.detail !== undefined ? { detail: attempt.detail } : {}),
  };
  try {
    mkdirSync(omaHomeDir(attempt.homeDirectory), { recursive: true });
    appendFileSync(
      bindAttemptsPath(attempt.homeDirectory),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
  } catch {
    // A missing trace costs diagnosis, never correctness.
  }
}

/** The most recent bind attempts, newest first. */
export function readBindAttempts(
  options: { homeDirectory?: string; limit?: number } = {},
): BindAttempt[] {
  const path = bindAttemptsPath(options.homeDirectory);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const attempts: BindAttempt[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) continue;
      if (typeof parsed.outcome !== "string" || typeof parsed.cwd !== "string") continue;
      attempts.push({
        at: typeof parsed.at === "string" ? parsed.at : new Date(0).toISOString(),
        root: typeof parsed.root === "string" ? parsed.root : null,
        outcome: parsed.outcome as BindOutcome,
        cwd: parsed.cwd,
        ...(typeof parsed.detail === "string" ? { detail: parsed.detail } : {}),
      });
    } catch {
      continue;
    }
  }
  const limit = options.limit ?? 20;
  return attempts.slice(-limit).reverse();
}

/**
 * One file per workspace, named after a digest of its root.
 *
 * A single `workspaces.json` was read-modify-written by every broker, so two sessions
 * open at once clobbered each other: the last writer won and the other project vanished
 * from the registry. Measured 2026-09-14 as a flaky isolation test. A file per root has
 * no shared state to race over.
 */
function workspaceRegistrationPath(workspaceRoot: string, homeDirectory?: string): string {
  const digest = createHash("sha256").update(samePathKey(workspaceRoot)).digest("hex");
  return join(workspaceRegistryDir(homeDirectory), `${digest.slice(0, 32)}.json`);
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
  return samePathKey(left) === samePathKey(right);
}

function samePathKey(value: string): string {
  return process.platform === "win32"
    ? resolve(value).toLocaleLowerCase("en-US")
    : resolve(value);
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
  const dir = workspaceRegistryDir(homeDirectory);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const registrations: WorkspaceRegistration[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const { root, source, lastSeenAt } = parsed;
    if (typeof root !== "string" || root.length === 0) continue;
    if (typeof source !== "string") continue;
    const key = samePathKey(root);
    if (seen.has(key)) continue;
    seen.add(key);
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
    mkdirSync(workspaceRegistryDir(options.homeDirectory), { recursive: true });
    writeJsonAtomically(workspaceRegistrationPath(root, options.homeDirectory), {
      root,
      source: options.source,
      lastSeenAt: at,
    });
  } catch {
    // A missing registration costs reporting precision, never correctness.
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
