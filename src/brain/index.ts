export { BrainStore, BrainStoreError } from "./brain-store.js";
export type { BrainStoreErrorCode } from "./brain-store.js";
export { openDatabase } from "./sqlite-adapter.js";
export type { SqlDatabase, SqlStatement, SqlParam } from "./sqlite-adapter.js";
export {
  MEMORY_DIMENSIONS,
  SESSION_STATUSES,
  type MemoryDimension,
  type SessionStatus,
  type ProjectRecord,
  type SessionRecord,
  type MemoryEntry,
  type InteractionSummary,
  type EnsureProjectInput,
  type StartSessionInput,
  type UpdateSessionInput,
  type StoreMemoryInput,
  type UpdateMemoryInput,
  type QueryMemoryInput,
  type RecordInteractionInput,
  type CompactionOptions,
  type CompactionResult,
} from "./types.js";

