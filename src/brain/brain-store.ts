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
  type ProjectComponentRecord,
  type ProjectRecord,
  type ProjectRelationRecord,
  type QueryMemoryInput,
  type RecordComponentInput,
  type RecordRelationInput,
  type RecordInteractionInput,
  type SessionRecord,
  type StartSessionInput,
  type StoreMemoryInput,
  type UpdateMemoryInput,
  type UpdateSessionInput,
  type CompactionOptions,
  type CompactionResult,
} from "./types.js";

export type { CompactionOptions, CompactionResult };

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
    node_ref TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mem_project_dim ON memory_entries(project_id, dimension);
CREATE INDEX IF NOT EXISTS idx_mem_session ON memory_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_interactions_session ON interaction_summaries(session_id);

-- The project's shape, as opposed to what happened in it.
--
-- Memory entries are episodic: a decision, an error, a run. The vision asks for a complete and
-- durable view of the project itself — which areas it is made of, and what exploration has
-- learned about each — that survives a restart and accumulates across missions instead of being
-- rediscovered every time.
CREATE TABLE IF NOT EXISTS project_components (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT,
    source TEXT NOT NULL,
    mentions INTEGER NOT NULL DEFAULT 1,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    UNIQUE(project_id, path)
);

CREATE INDEX IF NOT EXISTS idx_components_project ON project_components(project_id, last_seen_at);

-- How the project's areas relate to each other.
--
-- A list of areas answers "what is in this project"; it cannot answer "what depends on this".
-- Relations are what make the model navigable instead of a flat inventory, and they are what a
-- structural change has to be checked against.
CREATE TABLE IF NOT EXISTS project_component_relations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_path TEXT NOT NULL,
    to_path TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    mentions INTEGER NOT NULL DEFAULT 1,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    UNIQUE(project_id, from_path, to_path, kind)
);

CREATE INDEX IF NOT EXISTS idx_relations_project ON project_component_relations(project_id, from_path);
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
  node_ref: string | null;
  created_at: number;
}

interface ProjectComponentRow {
  id: string;
  project_id: string;
  path: string;
  kind: string;
  summary: string | null;
  source: string;
  mentions: number;
  first_seen_at: number;
  last_seen_at: number;
}

interface ProjectRelationRow {
  id: string;
  project_id: string;
  from_path: string;
  to_path: string;
  kind: string;
  source: string;
  mentions: number;
  first_seen_at: number;
  last_seen_at: number;
}

function mapRelationRow(row: ProjectRelationRow): ProjectRelationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    fromPath: row.from_path,
    toPath: row.to_path,
    kind: row.kind,
    source: row.source,
    mentions: row.mentions,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function mapComponentRow(row: ProjectComponentRow): ProjectComponentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    path: row.path,
    kind: row.kind,
    summary: row.summary,
    source: row.source,
    mentions: row.mentions,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
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
    this.migrate();
  }

  private migrate(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(interaction_summaries)")
      .all<{ name: string }>();
    const hasNodeRef = columns.some((c) => c.name === "node_ref");
    if (!hasNodeRef && columns.length > 0) {
      this.db.exec("ALTER TABLE interaction_summaries ADD COLUMN node_ref TEXT;");
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_interactions_node_ref ON interaction_summaries(node_ref);",
    );
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
    const id = input.id ?? randomUUID();
    const confidence = normaliseConfidence(input.confidence);

    if (input.id) {
      const existing = this.getMemory(input.id);
      if (existing) {
        return this.updateMemory(existing.id, {
          title,
          content: input.content,
          tags: input.tags,
          confidence,
        });
      }
    }

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
   * Record one area of the project, upserting by path.
   *
   * Exploration is what teaches OMA the shape of a project, and exploration happens per mission.
   * Without a durable component list each mission rediscovers the same ground and the knowledge
   * dies with the graph. `mentions` is how often exploration has touched the area, `summary` the
   * most recent thing learned about it.
   */
  recordComponent(input: RecordComponentInput): ProjectComponentRecord {
    const projectId = requireNonEmpty(input.projectId, "projectId");
    if (!this.getProject(projectId)) {
      throw new BrainStoreError("NOT_FOUND", `Unknown project '${projectId}'`);
    }
    const path = requireNonEmpty(input.path, "path").replace(/\\/gu, "/");
    const kind = requireNonEmpty(input.kind, "kind");
    const source = requireNonEmpty(input.source, "source");
    const now = Date.now();
    // `bun:sqlite` returns null for no row where `node:sqlite` returns undefined; the adapter's
    // signature says undefined, so normalise here rather than trusting either.
    const existing =
      this.db
        .prepare("SELECT * FROM project_components WHERE project_id = ? AND path = ?")
        .get<ProjectComponentRow>(projectId, path) ?? undefined;

    if (existing === undefined) {
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO project_components
             (id, project_id, path, kind, summary, source, mentions, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, projectId, path, kind, input.summary ?? null, source, now, now);
    } else {
      this.db
        .prepare(
          `UPDATE project_components
              SET kind = ?, summary = COALESCE(?, summary), source = ?, mentions = mentions + 1, last_seen_at = ?
            WHERE id = ?`,
        )
        .run(kind, input.summary ?? null, source, now, existing.id);
    }

    const row =
      this.db
        .prepare("SELECT * FROM project_components WHERE project_id = ? AND path = ?")
        .get<ProjectComponentRow>(projectId, path) ?? undefined;
    if (row === undefined) {
      throw new BrainStoreError("CONSTRAINT_ERROR", `Component '${path}' could not be read back`);
    }
    return mapComponentRow(row);
  }

  /** The project's areas, most recently touched first. Strictly scoped to the project. */
  listComponents(input: { projectId: string; limit?: number }): ProjectComponentRecord[] {
    const projectId = requireNonEmpty(input.projectId, "projectId");
    const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_QUERY_LIMIT), MAX_QUERY_LIMIT);
    return this.db
      .prepare(
        `SELECT * FROM project_components
          WHERE project_id = ?
          ORDER BY last_seen_at DESC, path ASC
          LIMIT ?`,
      )
      .all<ProjectComponentRow>(projectId, limit)
      .map(mapComponentRow);
  }

  /**
   * Record a relation between two areas, upserting on (from, to, kind).
   *
   * Like components, a relation seen twice is the same relation seen twice — `mentions` counts
   * the sightings rather than producing duplicate edges.
   */
  recordRelation(input: RecordRelationInput): ProjectRelationRecord {
    const projectId = requireNonEmpty(input.projectId, "projectId");
    if (!this.getProject(projectId)) {
      throw new BrainStoreError("NOT_FOUND", `Unknown project '${projectId}'`);
    }
    const fromPath = requireNonEmpty(input.fromPath, "fromPath").replace(/\\/gu, "/");
    const toPath = requireNonEmpty(input.toPath, "toPath").replace(/\\/gu, "/");
    const kind = requireNonEmpty(input.kind, "kind");
    const source = requireNonEmpty(input.source, "source");
    const now = Date.now();

    const existing =
      this.db
        .prepare(
          "SELECT * FROM project_component_relations WHERE project_id = ? AND from_path = ? AND to_path = ? AND kind = ?",
        )
        .get<ProjectRelationRow>(projectId, fromPath, toPath, kind) ?? undefined;

    if (existing === undefined) {
      this.db
        .prepare(
          `INSERT INTO project_component_relations
             (id, project_id, from_path, to_path, kind, source, mentions, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(randomUUID(), projectId, fromPath, toPath, kind, source, now, now);
    } else {
      this.db
        .prepare(
          `UPDATE project_component_relations
              SET source = ?, mentions = mentions + 1, last_seen_at = ?
            WHERE id = ?`,
        )
        .run(source, now, existing.id);
    }

    const row =
      this.db
        .prepare(
          "SELECT * FROM project_component_relations WHERE project_id = ? AND from_path = ? AND to_path = ? AND kind = ?",
        )
        .get<ProjectRelationRow>(projectId, fromPath, toPath, kind) ?? undefined;
    if (row === undefined) {
      throw new BrainStoreError(
        "CONSTRAINT_ERROR",
        `Relation ${fromPath} -> ${toPath} could not be read back`,
      );
    }
    return mapRelationRow(row);
  }

  /** Relations of a project, optionally those leaving one area. Strictly project-scoped. */
  listRelations(input: {
    projectId: string;
    fromPath?: string;
    limit?: number;
  }): ProjectRelationRecord[] {
    const projectId = requireNonEmpty(input.projectId, "projectId");
    const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_QUERY_LIMIT), MAX_QUERY_LIMIT);
    if (input.fromPath !== undefined) {
      return this.db
        .prepare(
          `SELECT * FROM project_component_relations
            WHERE project_id = ? AND from_path = ?
            ORDER BY to_path ASC
            LIMIT ?`,
        )
        .all<ProjectRelationRow>(projectId, input.fromPath.replace(/\\/gu, "/"), limit)
        .map(mapRelationRow);
    }
    return this.db
      .prepare(
        `SELECT * FROM project_component_relations
          WHERE project_id = ?
          ORDER BY last_seen_at DESC, from_path ASC, to_path ASC
          LIMIT ?`,
      )
      .all<ProjectRelationRow>(projectId, limit)
      .map(mapRelationRow);
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
      clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
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
    const id = input.id ?? randomUUID();
    const userIntent = input.context ?? input.userIntent ?? null;
    const actionsTaken = input.actions ?? input.actionsTaken ?? null;
    const nodeRef = input.nodeRef ?? null;

    if (input.id) {
      const existing = this.getInteraction(input.id);
      if (existing) {
        this.db
          .prepare(
            `UPDATE interaction_summaries
             SET round_number = ?, user_intent = ?, actions_taken = ?, outcome = ?, node_ref = ?
             WHERE id = ?`,
          )
          .run(input.roundNumber, userIntent, actionsTaken, input.outcome ?? null, nodeRef, existing.id);
        return this.getInteraction(existing.id)!;
      }
    }

    this.db
      .prepare(
        `INSERT INTO interaction_summaries
         (id, session_id, round_number, user_intent, actions_taken, outcome, node_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        input.roundNumber,
        userIntent,
        actionsTaken,
        input.outcome ?? null,
        nodeRef,
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

  /** Chronological list of interaction summaries for a session, optionally filtered by node_ref. */
  listInteractions(sessionId: string, nodeRef?: string): InteractionSummary[] {
    if (nodeRef !== undefined) {
      return this.db
        .prepare(
          `SELECT * FROM interaction_summaries
           WHERE session_id = ? AND (node_ref = ? OR (',' || REPLACE(node_ref, ' ', '') || ',') LIKE ('%,' || ? || ',%'))
           ORDER BY round_number ASC, created_at ASC`,
        )
        .all<InteractionRow>(sessionId, nodeRef, nodeRef)
        .map(toInteractionSummary);
    }
    return this.db
      .prepare(
        "SELECT * FROM interaction_summaries WHERE session_id = ? ORDER BY round_number ASC, created_at ASC",
      )
      .all<InteractionRow>(sessionId)
      .map(toInteractionSummary);
  }

  /** List of interaction summaries across all sessions associated with a specific node_ref. */
  listInteractionsByNode(nodeRef: string): InteractionSummary[] {
    return this.db
      .prepare(
        `SELECT * FROM interaction_summaries
         WHERE node_ref = ? OR (',' || REPLACE(node_ref, ' ', '') || ',') LIKE ('%,' || ? || ',%')
         ORDER BY round_number ASC, created_at ASC`,
      )
      .all<InteractionRow>(nodeRef, nodeRef)
      .map(toInteractionSummary);
  }

  /**
   * Return the monotonically increasing next round number for a session.
   * Accurately accounts for pruned or condensed historical rounds so round
   * counters never rewind or collide after compaction.
   */
  getNextRoundNumber(sessionId: string): number {
    const row = this.db
      .prepare(
        "SELECT MAX(round_number) as max_round FROM interaction_summaries WHERE session_id = ?",
      )
      .get<{ max_round: number | null }>(sessionId);

    if (!row || row.max_round === null || row.max_round === undefined) {
      return 0;
    }

    let maxRound = Number(row.max_round);

    // If there is any condensed interaction summary, inspect its range header
    // in case higher round numbers were collapsed into an earlier round_number.
    const condensedRows = this.db
      .prepare(
        "SELECT user_intent, outcome FROM interaction_summaries WHERE session_id = ? AND id LIKE 'condensed-%'",
      )
      .all<{ user_intent: string | null; outcome: string | null }>(sessionId);

    for (const c of condensedRows) {
      const match =
        c.user_intent?.match(/rounds:\s*\d+\.\.(\d+)/) ||
        c.outcome?.match(/rounds\s+\d+\.\.(\d+)/);
      if (match) {
        const endRound = Number(match[1]);
        if (Number.isFinite(endRound) && endRound > maxRound) {
          maxRound = endRound;
        }
      }
    }

    return maxRound + 1;
  }

  // -------------------------------------------------------------------------
  // Compaction & Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Compact the Brain:
   * 1. Deduplicates identical or redundant memory entries, retaining the freshest/highest-confidence copy
   *    and merging tags.
   * 2. Prunes older or low-confidence run_summary entries while strictly preserving durable dimensions
   *    (architectural decisions, user preferences, past errors).
   * 3. Prunes or condenses older interaction summaries beyond a configurable retention window.
   * 4. Runs SQLite VACUUM to reclaim space.
   */
  compact(options?: CompactionOptions): CompactionResult {
    const now = Date.now();
    const projectId = options?.projectId?.trim() || undefined;
    if (projectId && !this.getProject(projectId)) {
      throw new BrainStoreError(
        "NOT_FOUND",
        `Cannot compact: unknown project '${projectId}'`,
      );
    }

    const maxRunSummaries = options?.maxRunSummaries !== undefined ? options.maxRunSummaries : 50;
    const runSummaryMinConfidence = options?.runSummaryMinConfidence ?? 0.5;
    const runSummaryMaxAgeMs = options?.runSummaryMaxAgeMs;
    const maxInteractionsPerSession = options?.maxInteractionsPerSession !== undefined ? options.maxInteractionsPerSession : 100;
    const interactionRetentionMs = options?.interactionRetentionMs;
    const condenseInteractions = options?.condenseInteractions ?? false;
    const deduplicationMode = options?.deduplicationMode ?? "redundant";
    const vacuum = options?.vacuum ?? true;

    // 0. Count before
    const countEntriesBefore = this.db.prepare(
      projectId
        ? "SELECT COUNT(*) as count FROM memory_entries WHERE project_id = ?"
        : "SELECT COUNT(*) as count FROM memory_entries",
    ).get<{ count: number }>(...(projectId ? [projectId] : []))?.count ?? 0;

    const countInteractionsBefore = this.db.prepare(
      projectId
        ? `SELECT COUNT(*) as count FROM interaction_summaries i
           JOIN sessions s ON i.session_id = s.id
           WHERE s.project_id = ?`
        : "SELECT COUNT(*) as count FROM interaction_summaries",
    ).get<{ count: number }>(...(projectId ? [projectId] : []))?.count ?? 0;

    let entriesDeduplicated = 0;
    let runSummariesPruned = 0;
    let interactionsPruned = 0;
    let interactionsCondensed = 0;

    // Execute deletions, updates, and condensation in an atomic transaction
    this.db.exec("BEGIN TRANSACTION;");
    try {
      // 1. Deduplicate identical or redundant memory entries
      const entries = this.db.prepare(
        projectId
          ? "SELECT * FROM memory_entries WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC"
          : "SELECT * FROM memory_entries ORDER BY updated_at DESC, created_at DESC",
      ).all<MemoryRow>(...(projectId ? [projectId] : []));

      const deletedEntryIds = new Set<string>();
      const updatedTags = new Map<string, string | null>();

      const mergeTags = (tagsA: string | null, tagsB: string | null): string | null => {
        try {
          const listA: string[] = tagsA ? JSON.parse(tagsA) : [];
          const listB: string[] = tagsB ? JSON.parse(tagsB) : [];
          const merged = Array.from(new Set([...listA, ...listB]));
          return merged.length > 0 ? JSON.stringify(merged) : null;
        } catch {
          return tagsA ?? tagsB;
        }
      };

      const handleDuplicate = (retained: MemoryRow, duplicate: MemoryRow, map: Map<string, MemoryRow>, key: string) => {
        if (duplicate.confidence > retained.confidence) {
          deletedEntryIds.add(retained.id);
          const merged = mergeTags(duplicate.tags, updatedTags.get(retained.id) ?? retained.tags);
          updatedTags.set(duplicate.id, merged);
          map.set(key, duplicate);
        } else {
          deletedEntryIds.add(duplicate.id);
          const merged = mergeTags(updatedTags.get(retained.id) ?? retained.tags, duplicate.tags);
          updatedTags.set(retained.id, merged);
        }
      };

      // Pass 1: exact duplicates (project_id, dimension, title, content)
      const exactSeen = new Map<string, MemoryRow>();
      for (const entry of entries) {
        if (deletedEntryIds.has(entry.id)) continue;
        const key = `${entry.project_id}::${entry.dimension}::${entry.title.trim().toLowerCase()}::${entry.content.trim()}`;
        const existing = exactSeen.get(key);
        if (!existing) {
          exactSeen.set(key, entry);
        } else {
          handleDuplicate(existing, entry, exactSeen, key);
        }
      }

      // Pass 2: identical content duplicates (project_id, dimension, content)
      const contentSeen = new Map<string, MemoryRow>();
      for (const entry of entries) {
        if (deletedEntryIds.has(entry.id)) continue;
        const key = `${entry.project_id}::${entry.dimension}::${entry.content.trim()}`;
        const existing = contentSeen.get(key);
        if (!existing) {
          contentSeen.set(key, entry);
        } else {
          handleDuplicate(existing, entry, contentSeen, key);
        }
      }

      // Pass 3: redundant title deduplication in "redundant" mode for run_summary and project_context
      if (deduplicationMode === "redundant") {
        const titleSeen = new Map<string, MemoryRow>();
        for (const entry of entries) {
          if (deletedEntryIds.has(entry.id)) continue;
          // Strictly preserve durable dimensions: NEVER deduplicate architectural_decision, user_preference, or past_error by title alone!
          if (entry.dimension !== "run_summary" && entry.dimension !== "project_context") {
            continue;
          }
          const key = `${entry.project_id}::${entry.dimension}::${entry.title.trim().toLowerCase()}`;
          const existing = titleSeen.get(key);
          if (!existing) {
            titleSeen.set(key, entry);
          } else {
            handleDuplicate(existing, entry, titleSeen, key);
          }
        }
      }

      // Apply tag merges to retained entries
      if (updatedTags.size > 0) {
        const updateTagsStmt = this.db.prepare("UPDATE memory_entries SET tags = ? WHERE id = ?");
        for (const [id, tags] of updatedTags) {
          if (!deletedEntryIds.has(id)) {
            updateTagsStmt.run(tags, id);
          }
        }
      }

      // Delete deduplicated entries
      if (deletedEntryIds.size > 0) {
        const deleteStmt = this.db.prepare("DELETE FROM memory_entries WHERE id = ?");
        for (const id of deletedEntryIds) {
          deleteStmt.run(id);
        }
        entriesDeduplicated = deletedEntryIds.size;
      }

      // 2. Prune older or low-confidence run_summary entries while strictly preserving durable dimensions
      const runSummaries = this.db.prepare(
        projectId
          ? "SELECT * FROM memory_entries WHERE project_id = ? AND dimension = 'run_summary' ORDER BY updated_at DESC, created_at DESC"
          : "SELECT * FROM memory_entries WHERE dimension = 'run_summary' ORDER BY updated_at DESC, created_at DESC",
      ).all<MemoryRow>(...(projectId ? [projectId] : []));

      const prunedRunSummaryIds = new Set<string>();
      const keptRunSummaries: MemoryRow[] = [];

      for (const rs of runSummaries) {
        // Low-confidence check
        if (rs.confidence < runSummaryMinConfidence) {
          prunedRunSummaryIds.add(rs.id);
          continue;
        }
        // Older age check
        const entryTimestamp = Math.max(Number(rs.updated_at), Number(rs.created_at));
        if (runSummaryMaxAgeMs !== undefined && (now - entryTimestamp) > runSummaryMaxAgeMs) {
          prunedRunSummaryIds.add(rs.id);
          continue;
        }
        keptRunSummaries.push(rs);
      }

      // Retention count limit on run_summaries (per project)
      if (maxRunSummaries !== undefined && maxRunSummaries >= 0) {
        const byProject = new Map<string, MemoryRow[]>();
        for (const rs of keptRunSummaries) {
          const list = byProject.get(rs.project_id) ?? [];
          list.push(rs);
          byProject.set(rs.project_id, list);
        }
        for (const [, list] of byProject) {
          if (list.length > maxRunSummaries) {
            const excess = list.slice(maxRunSummaries);
            for (const item of excess) {
              prunedRunSummaryIds.add(item.id);
            }
          }
        }
      }

      if (prunedRunSummaryIds.size > 0) {
        const deleteStmt = this.db.prepare("DELETE FROM memory_entries WHERE id = ?");
        for (const id of prunedRunSummaryIds) {
          deleteStmt.run(id);
        }
        runSummariesPruned = prunedRunSummaryIds.size;
      }

      // 3. Prune or condense older interaction_summaries beyond retention window
      const sessions = this.db.prepare(
        projectId
          ? "SELECT id, project_id FROM sessions WHERE project_id = ?"
          : "SELECT id, project_id FROM sessions",
      ).all<{ id: string; project_id: string }>(...(projectId ? [projectId] : []));

      for (const session of sessions) {
        const sessionInteractions = this.db.prepare(
          "SELECT * FROM interaction_summaries WHERE session_id = ? ORDER BY round_number ASC, created_at ASC",
        ).all<InteractionRow>(session.id);

        if (sessionInteractions.length === 0) continue;

        const candidateIds = new Set<string>();

        // Time-based retention
        if (interactionRetentionMs !== undefined) {
          for (const inter of sessionInteractions) {
            if (now - Number(inter.created_at) > interactionRetentionMs) {
              candidateIds.add(inter.id);
            }
          }
        }

        // Count-based retention
        if (maxInteractionsPerSession !== undefined && maxInteractionsPerSession >= 0) {
          if (sessionInteractions.length > maxInteractionsPerSession) {
            const excessCount = sessionInteractions.length - maxInteractionsPerSession;
            const oldestExcess = sessionInteractions.slice(0, excessCount);
            for (const inter of oldestExcess) {
              candidateIds.add(inter.id);
            }
          }
        }

        if (candidateIds.size === 0) continue;

        const candidates = sessionInteractions.filter((i) => candidateIds.has(i.id));

        if (condenseInteractions && candidates.length > 0) {
          let totalHistoricalRounds = 0;
          const allIntents: string[] = [];
          const allActions: string[] = [];
          const allNodeRefs = new Set<string>();
          let minRound = Infinity;
          let maxRound = -Infinity;

          for (const c of candidates) {
            if (c.node_ref) {
              for (const n of c.node_ref.split(",")) {
                const trimmed = n.trim();
                if (trimmed) allNodeRefs.add(trimmed);
              }
            }

            const roundNum = Number(c.round_number);
            let candidateStart = roundNum;
            let candidateEnd = roundNum;
            let candidateCount = 1;
            let cleanIntent = c.user_intent ?? "";

            // Check if candidate is an existing condensed rollup
            const match = c.user_intent?.match(
              /^\[Condensed (\d+) rounds: (\d+)\.\.(\d+)\]\s*(.*)/s,
            );
            if (match) {
              candidateCount = Number(match[1]);
              candidateStart = Number(match[2]);
              candidateEnd = Number(match[3]);
              cleanIntent = match[4].trim();
            }

            totalHistoricalRounds += candidateCount;
            if (candidateStart < minRound) minRound = candidateStart;
            if (candidateEnd > maxRound) maxRound = candidateEnd;

            if (cleanIntent) {
              allIntents.push(cleanIntent);
            }
            if (c.actions_taken) {
              allActions.push(c.actions_taken);
            }
          }

          if (minRound === Infinity) minRound = 0;
          if (maxRound === -Infinity) maxRound = 0;

          const nodeRefs = Array.from(allNodeRefs).join(", ");
          const condensedIntents = allIntents.slice(-5).join("; ");
          const condensedActions = allActions.slice(-5).join("; ");
          const lastOutcome = candidates[candidates.length - 1].outcome ?? "completed";
          const condensedOutcome = `Condensed ${totalHistoricalRounds} interactions (rounds ${minRound}..${maxRound}). Last outcome: ${lastOutcome}`;

          const deleteStmt = this.db.prepare("DELETE FROM interaction_summaries WHERE id = ?");
          for (const c of candidates) {
            deleteStmt.run(c.id);
          }

          const condensedId = `condensed-${session.id}-${minRound}-${maxRound}-${randomUUID().slice(0, 8)}`;
          this.db.prepare(
            `INSERT INTO interaction_summaries
             (id, session_id, round_number, user_intent, actions_taken, outcome, node_ref, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            condensedId,
            session.id,
            minRound,
            `[Condensed ${totalHistoricalRounds} rounds: ${minRound}..${maxRound}] ${condensedIntents || "Historical interactions"}`,
            condensedActions || "Historical actions",
            condensedOutcome,
            nodeRefs || null,
            candidates[candidates.length - 1].created_at,
          );

          interactionsCondensed += candidates.length;
        } else {
          const deleteStmt = this.db.prepare("DELETE FROM interaction_summaries WHERE id = ?");
          for (const c of candidates) {
            deleteStmt.run(c.id);
          }
          interactionsPruned += candidates.length;
        }
      }

      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }

    // 4. VACUUM (outside transaction)
    if (vacuum) {
      try {
        this.db.exec("VACUUM;");
      } catch {
        // Ignore vacuum errors if database is in an incompatible transaction state
      }
    }

    // 5. Count after
    const countEntriesAfter = this.db.prepare(
      projectId
        ? "SELECT COUNT(*) as count FROM memory_entries WHERE project_id = ?"
        : "SELECT COUNT(*) as count FROM memory_entries",
    ).get<{ count: number }>(...(projectId ? [projectId] : []))?.count ?? 0;

    const countInteractionsAfter = this.db.prepare(
      projectId
        ? `SELECT COUNT(*) as count FROM interaction_summaries i
           JOIN sessions s ON i.session_id = s.id
           WHERE s.project_id = ?`
        : "SELECT COUNT(*) as count FROM interaction_summaries",
    ).get<{ count: number }>(...(projectId ? [projectId] : []))?.count ?? 0;

    return {
      status: "compacted",
      projectId,
      entriesDeduplicated,
      runSummariesPruned,
      interactionsPruned,
      interactionsCondensed,
      totalEntriesBefore: Number(countEntriesBefore),
      totalEntriesAfter: Number(countEntriesAfter),
      totalInteractionsBefore: Number(countInteractionsBefore),
      totalInteractionsAfter: Number(countInteractionsAfter),
    };
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
    context: row.user_intent,
    actions: row.actions_taken,
    userIntent: row.user_intent,
    actionsTaken: row.actions_taken,
    outcome: row.outcome,
    nodeRef: row.node_ref ?? null,
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
