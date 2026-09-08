import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase, type SqlDatabase, type SqlParam } from "./sqlite-adapter.js";
import {
  MEMORY_DIMENSIONS,
  SESSION_STATUSES,
  type EnsureProjectInput,
  type InteractionSummary,
  type MemoryDimension,
  type MemoryEntry,
  type ProjectRecord,
  type QueryMemoryInput,
  type RecordInteractionInput,
  type SessionRecord,
  type StartSessionInput,
  type StoreMemoryInput,
  type UpdateMemoryInput,
  type UpdateSessionInput,
} from "./types.js";

export type BrainStoreErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONSTRAINT_ERROR";

export class BrainStoreError extends Error {
  constructor(
    public readonly code: BrainStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrainStoreError";
  }
}

const DEFAULT_QUERY_LIMIT = 20;
const MAX_QUERY_LIMIT = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    tech_stack TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    objective TEXT,
    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'failed'))
);

CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    dimension TEXT NOT NULL CHECK(dimension IN (
        'architectural_decision',
        'past_error',
        'run_summary',
        'project_context',
        'user_preference'
    )),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT,
    confidence REAL DEFAULT 1.0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS interaction_summaries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL,
    user_intent TEXT,
    actions_taken TEXT,
    outcome TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mem_project_dim ON memory_entries(project_id, dimension);
CREATE INDEX IF NOT EXISTS idx_mem_session ON memory_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_interactions_session ON interaction_summaries(session_id);
`;

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  tech_stack: string | null;
  created_at: number;
  updated_at: number;
}

interface SessionRow {
  id: string;
  project_id: string;
  started_at: number;
  last_active_at: number;
  objective: string | null;
  status: SessionRecord["status"];
}

interface MemoryRow {
  id: string;
  project_id: string;
  session_id: string | null;
  dimension: MemoryDimension;
  title: string;
  content: string;
  tags: string | null;
  confidence: number;
  created_at: number;
  updated_at: number;
}

interface InteractionRow {
  id: string;
  session_id: string;
  round_number: number;
  user_intent: string | null;
  actions_taken: string | null;
  outcome: string | null;
  created_at: number;
}

/**
 * SQLite-backed persistent memory for OMA, strictly partitioned by project and
 * session. This class is the single test seam for Brain behaviour: all
 * persistence, isolation, and retrieval semantics are exercised through its
 * public TypeScript API rather than through implementation internals.
 */
export class BrainStore {
  private readonly db: SqlDatabase;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.db = openDatabase(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  /**
   * Return the project rooted at `rootPath`, creating it if absent. The root
   * path is the natural key, so repeated calls for the same repository are
   * idempotent and never duplicate a project.
   */
  ensureProject(input: EnsureProjectInput): ProjectRecord {
    const rootPath = requireNonEmpty(input.rootPath, "rootPath");
    const name = requireNonEmpty(input.name, "name");

    const existing = this.getProjectByRoot(rootPath);
    if (existing) {
      const now = Date.now();
      this.db
        .prepare(
          "UPDATE projects SET name = ?, tech_stack = ?, updated_at = ? WHERE id = ?",
        )
        .run(name, input.techStack ?? existing.techStack, now, existing.id);
      return this.getProject(existing.id)!;
    }

    const now = Date.now();
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, tech_stack, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, rootPath, input.techStack ?? null, now, now);
    return this.getProject(id)!;
  }

  getProject(id: string): ProjectRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get<ProjectRow>(id);
    return row ? toProjectRecord(row) : undefined;
  }

  getProjectByRoot(rootPath: string): ProjectRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE root_path = ?")
      .get<ProjectRow>(rootPath);
    return row ? toProjectRecord(row) : undefined;
  }

  listProjects(): ProjectRecord[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY updated_at DESC")
      .all<ProjectRow>()
      .map(toProjectRecord);
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  startSession(input: StartSessionInput): SessionRecord {
    const projectId = requireNonEmpty(input.projectId, "projectId");
    if (!this.getProject(projectId)) {
      throw new BrainStoreError(
        "NOT_FOUND",
        `Cannot start session: unknown project '${projectId}'`,
      );
    }
    const now = Date.now();
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, started_at, last_active_at, objective, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
      )
      .run(id, projectId, now, now, input.objective ?? null);
    return this.getSession(id)!;
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get<SessionRow>(id);
    return row ? toSessionRecord(row) : undefined;
  }

  listSessions(projectId: string): SessionRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE project_id = ? ORDER BY last_active_at DESC",
      )
      .all<SessionRow>(projectId)
      .map(toSessionRecord);
  }

  updateSession(id: string, patch: UpdateSessionInput): SessionRecord {
    const existing = this.getSession(id);
    if (!existing) {
      throw new BrainStoreError("NOT_FOUND", `Unknown session '${id}'`);
    }
    if (patch.status && !SESSION_STATUSES.includes(patch.status)) {
      throw new BrainStoreError(
        "VALIDATION_ERROR",
        `Invalid session status '${patch.status}'`,
      );
    }
    const objective =
      patch.objective !== undefined ? patch.objective : existing.objective;
    const status = patch.status ?? existing.status;
    this.db
      .prepare(
        "UPDATE sessions SET objective = ?, status = ?, last_active_at = ? WHERE id = ?",
      )
      .run(objective, status, Date.now(), id);
    return this.getSession(id)!;
  }

  /** Bump a session's activity timestamp without other changes. */
  touchSession(id: string): void {
    this.db
      .prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  // -------------------------------------------------------------------------
  // Memory entries
  // -------------------------------------------------------------------------

  storeMemory(input: StoreMemoryInput): MemoryEntry {
    const projectId = requireNonEmpty(input.projectId, "projectId");
    if (!MEMORY_DIMENSIONS.includes(input.dimension)) {
      throw new BrainStoreError(
        "VALIDATION_ERROR",
        `Invalid memory dimension '${input.dimension}'`,
      );
    }
    if (!this.getProject(projectId)) {
      throw new BrainStoreError(
        "NOT_FOUND",
        `Cannot store memory: unknown project '${projectId}'`,
      );
    }
    if (input.sessionId && !this.getSession(input.sessionId)) {
      throw new BrainStoreError(
        "NOT_FOUND",
        `Cannot store memory: unknown session '${input.sessionId}'`,
      );
    }
    const title = requireNonEmpty(input.title, "title");
    const now = Date.now();
    const id = randomUUID();
    const confidence = normaliseConfidence(input.confidence);
    this.db
      .prepare(
        `INSERT INTO memory_entries
         (id, project_id, session_id, dimension, title, content, tags, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        input.sessionId ?? null,
        input.dimension,
        title,
        input.content,
        JSON.stringify(input.tags ?? []),
        confidence,
        now,
        now,
      );
    return this.getMemory(id)!;
  }

  getMemory(id: string): MemoryEntry | undefined {
    const row = this.db
      .prepare("SELECT * FROM memory_entries WHERE id = ?")
      .get<MemoryRow>(id);
    return row ? toMemoryEntry(row) : undefined;
  }

  updateMemory(id: string, patch: UpdateMemoryInput): MemoryEntry {
    const existing = this.getMemory(id);
    if (!existing) {
      throw new BrainStoreError("NOT_FOUND", `Unknown memory entry '${id}'`);
    }
    const title = patch.title !== undefined ? requireNonEmpty(patch.title, "title") : existing.title;
    const content = patch.content !== undefined ? patch.content : existing.content;
    const tags = patch.tags !== undefined ? patch.tags : existing.tags;
    const confidence =
      patch.confidence !== undefined
        ? normaliseConfidence(patch.confidence)
        : existing.confidence;
    this.db
      .prepare(
        "UPDATE memory_entries SET title = ?, content = ?, tags = ?, confidence = ?, updated_at = ? WHERE id = ?",
      )
      .run(title, content, JSON.stringify(tags), confidence, Date.now(), id);
    return this.getMemory(id)!;
  }

  deleteMemory(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM memory_entries WHERE id = ?")
      .run(id);
    return Number(result.changes) > 0;
  }

  /**
   * Retrieve memory entries for a project, optionally narrowed by dimension and
   * a free-text keyword (matched against title and content). Results are
   * strictly scoped to `projectId` — this is the multi-project isolation
   * guarantee — and ordered most-recently-updated first.
   */
  queryMemory(input: QueryMemoryInput): MemoryEntry[] {
    const projectId = requireNonEmpty(input.projectId, "projectId");
    const clauses: string[] = ["project_id = ?"];
    const params: SqlParam[] = [projectId];

    if (input.dimensions && input.dimensions.length > 0) {
      for (const dim of input.dimensions) {
        if (!MEMORY_DIMENSIONS.includes(dim)) {
          throw new BrainStoreError(
            "VALIDATION_ERROR",
            `Invalid memory dimension '${dim}'`,
          );
        }
      }
      const placeholders = input.dimensions.map(() => "?").join(", ");
      clauses.push(`dimension IN (${placeholders})`);
      params.push(...input.dimensions);
    }

    if (input.query && input.query.trim().length > 0) {
      const like = `%${escapeLike(input.query.trim())}%`;
      clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }

    const limit = clampLimit(input.limit);
    const sql = `SELECT * FROM memory_entries WHERE ${clauses.join(
      " AND ",
    )} ORDER BY updated_at DESC, created_at DESC LIMIT ?`;
    params.push(limit);

    return this.db
      .prepare(sql)
      .all<MemoryRow>(...params)
      .map(toMemoryEntry);
  }

  // -------------------------------------------------------------------------
  // Interaction summaries
  // -------------------------------------------------------------------------

  recordInteraction(input: RecordInteractionInput): InteractionSummary {
    const sessionId = requireNonEmpty(input.sessionId, "sessionId");
    if (!this.getSession(sessionId)) {
      throw new BrainStoreError(
        "NOT_FOUND",
        `Cannot record interaction: unknown session '${sessionId}'`,
      );
    }
    if (!Number.isInteger(input.roundNumber) || input.roundNumber < 0) {
      throw new BrainStoreError(
        "VALIDATION_ERROR",
        `roundNumber must be a non-negative integer, got '${input.roundNumber}'`,
      );
    }
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO interaction_summaries
         (id, session_id, round_number, user_intent, actions_taken, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        input.roundNumber,
        input.userIntent ?? null,
        input.actionsTaken ?? null,
        input.outcome ?? null,
        now,
      );
    return this.getInteraction(id)!;
  }

  getInteraction(id: string): InteractionSummary | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM interaction_summaries WHERE id = ?",
      )
      .get<InteractionRow>(id);
    return row ? toInteractionSummary(row) : undefined;
  }

  /** Chronological list of interaction summaries for a session. */
  listInteractions(sessionId: string): InteractionSummary[] {
    return this.db
      .prepare(
        "SELECT * FROM interaction_summaries WHERE session_id = ? ORDER BY round_number ASC, created_at ASC",
      )
      .all<InteractionRow>(sessionId)
      .map(toInteractionSummary);
  }
}

// ---------------------------------------------------------------------------
// Row mappers & helpers
// ---------------------------------------------------------------------------

function toProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    techStack: row.tech_stack,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    startedAt: Number(row.started_at),
    lastActiveAt: Number(row.last_active_at),
    objective: row.objective,
    status: row.status,
  };
}

function toMemoryEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    dimension: row.dimension,
    title: row.title,
    content: row.content,
    tags: parseTags(row.tags),
    confidence: Number(row.confidence),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toInteractionSummary(row: InteractionRow): InteractionSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    roundNumber: Number(row.round_number),
    userIntent: row.user_intent,
    actionsTaken: row.actions_taken,
    outcome: row.outcome,
    createdAt: Number(row.created_at),
  };
}

function parseTags(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BrainStoreError(
      "VALIDATION_ERROR",
      `Field '${field}' must be a non-empty string`,
    );
  }
  return value;
}

function normaliseConfidence(value: number | undefined): number {
  if (value === undefined) {
    return 1.0;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new BrainStoreError(
      "VALIDATION_ERROR",
      `confidence must be a number, got '${value}'`,
    );
  }
  return Math.min(1, Math.max(0, value));
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_QUERY_LIMIT;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_QUERY_LIMIT;
  }
  return Math.min(limit, MAX_QUERY_LIMIT);
}

/** Escape LIKE wildcards so user keywords match literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
