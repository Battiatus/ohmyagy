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
  userIntent: string | null;
  actionsTaken: string | null;
  outcome: string | null;
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
  actionsTaken?: string | null;
  outcome?: string | null;
}
