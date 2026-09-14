/**
 * Data contracts for the Neural Brain (SQLite-backed persistent memory).
 *
 * The Brain is compartmentalised by `projectId` and `sessionId` and stores five
 * dimensions of durable memory so that OMA never repeats past mistakes, never
 * contradicts established architecture, and can resume a multi-day mission from
 * a fresh session without re-explanation.
 */

/** The five canonical memory dimensions persisted by the Brain. */
export type MemoryDimension =
  | "architectural_decision"
  | "past_error"
  | "run_summary"
  | "project_context"
  | "user_preference";

export const MEMORY_DIMENSIONS: readonly MemoryDimension[] = [
  "architectural_decision",
  "past_error",
  "run_summary",
  "project_context",
  "user_preference",
] as const;

export type SessionStatus = "active" | "paused" | "completed" | "failed";

export const SESSION_STATUSES: readonly SessionStatus[] = [
  "active",
  "paused",
  "completed",
  "failed",
] as const;

/** A project the Brain has observed, keyed by its absolute root path. */
export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  techStack: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * One area of the project, as opposed to one thing that happened in it.
 *
 * Memory entries are episodic — a decision, an error, a run. Components are the project's shape:
 * which paths exploration has actually looked at, how often, and the most recent thing learned
 * about each. They are what makes the vision's "complete view of the project" survive a restart
 * instead of being rediscovered by every mission.
 */
export interface ProjectComponentRecord {
  id: string;
  projectId: string;
  /** Workspace-relative, POSIX separators. */
  path: string;
  kind: string;
  summary: string | null;
  source: string;
  mentions: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface RecordComponentInput {
  projectId: string;
  path: string;
  kind: string;
  source: string;
  summary?: string | null;
}

/**
 * A link between two areas of the project.
 *
 * A list of areas answers "what is in this project"; it cannot answer "what depends on this".
 * `kind` is deliberately open (`imports`, `owns`, …) because the survey and a dispatch may each
 * learn a different sort of link, and neither should have to be modelled away.
 */
export interface ProjectRelationRecord {
  id: string;
  projectId: string;
  fromPath: string;
  toPath: string;
  kind: string;
  source: string;
  mentions: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface RecordRelationInput {
  projectId: string;
  fromPath: string;
  toPath: string;
  kind: string;
  source: string;
}

/** A single OMA working session scoped to one project. */
export interface SessionRecord {
  id: string;
  projectId: string;
  startedAt: number;
  lastActiveAt: number;
  objective: string | null;
  status: SessionStatus;
}

/** A typed, durable memory item. */
export interface MemoryEntry {
  id: string;
  projectId: string;
  sessionId: string | null;
  dimension: MemoryDimension;
  title: string;
  content: string;
  tags: string[];
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

/** A condensed record of one orchestration round, produced by the summarizer. */
export interface InteractionSummary {
  id: string;
  sessionId: string;
  roundNumber: number;
  /** Canonical context: user intent, situation, and starting state this round. */
  context?: string | null;
  /** Canonical actions: what was done and the concrete outcome. */
  actions?: string | null;
  userIntent: string | null;
  actionsTaken: string | null;
  outcome: string | null;
  nodeRef: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Input contracts (write path)
// ---------------------------------------------------------------------------

export interface EnsureProjectInput {
  name: string;
  rootPath: string;
  techStack?: string | null;
  /** Optional explicit id; a UUID is generated when omitted. */
  id?: string;
}

export interface StartSessionInput {
  projectId: string;
  objective?: string | null;
  id?: string;
}

export interface UpdateSessionInput {
  objective?: string | null;
  status?: SessionStatus;
}

export interface StoreMemoryInput {
  projectId: string;
  sessionId?: string | null;
  dimension: MemoryDimension;
  title: string;
  content: string;
  tags?: string[];
  confidence?: number;
  /** Optional explicit id for deterministic idempotency. */
  id?: string;
}

export interface UpdateMemoryInput {
  title?: string;
  content?: string;
  tags?: string[];
  confidence?: number;
}

export interface QueryMemoryInput {
  projectId: string;
  dimensions?: MemoryDimension[];
  /** Free-text keyword matched against title and content. */
  query?: string;
  limit?: number;
}

export interface RecordInteractionInput {
  sessionId: string;
  roundNumber: number;
  userIntent?: string | null;
  context?: string | null;
  actionsTaken?: string | null;
  actions?: string | null;
  outcome?: string | null;
  nodeRef?: string | null;
  /** Optional explicit id for deterministic idempotency. */
  id?: string;
}

export interface CompactionOptions {
  /** Optional project scope. If omitted, compaction applies across all projects. */
  projectId?: string;
  /**
   * Maximum number of `run_summary` entries to retain per project.
   * Older run summaries beyond this count are pruned. Default: 50.
   */
  maxRunSummaries?: number;
  /**
   * Minimum confidence threshold for `run_summary` entries.
   * Run summaries with confidence strictly below this threshold are pruned. Default: 0.5.
   */
  runSummaryMinConfidence?: number;
  /**
   * Maximum age for `run_summary` entries in milliseconds.
   * Run summaries older than `now - runSummaryMaxAgeMs` are pruned.
   */
  runSummaryMaxAgeMs?: number;
  /**
   * Maximum interaction summaries to retain per session.
   * Older interactions beyond this limit are pruned (or condensed). Default: 100.
   */
  maxInteractionsPerSession?: number;
  /**
   * Retention window in milliseconds for interaction summaries.
   * Older interactions beyond `now - interactionRetentionMs` are pruned (or condensed).
   */
  interactionRetentionMs?: number;
  /**
   * If true, condense older interactions into a rollup interaction summary row
   * instead of outright deleting them. Default: false.
   */
  condenseInteractions?: boolean;
  /**
   * Deduplication strategy.
   * - "exact": deduplicates entries with identical (dimension, title, content).
   * - "redundant": also deduplicates entries with identical (dimension, title) for run_summary/project_context,
   *   retaining the freshest/highest-confidence entry.
   * Default: "redundant".
   */
  deduplicationMode?: "exact" | "redundant";
  /**
   * Whether to execute SQLite VACUUM to reclaim space after pruning. Default: true.
   */
  vacuum?: boolean;
}

export interface CompactionResult {
  status: "compacted";
  projectId?: string;
  entriesDeduplicated: number;
  runSummariesPruned: number;
  interactionsPruned: number;
  interactionsCondensed: number;
  totalEntriesBefore: number;
  totalEntriesAfter: number;
  totalInteractionsBefore: number;
  totalInteractionsAfter: number;
}

