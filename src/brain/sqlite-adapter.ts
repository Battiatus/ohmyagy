import { createRequire } from "node:module";

/**
 * Cross-runtime SQLite adapter.
 *
 * The Neural Brain must run identically under Node.js (v22+ ships the
 * experimental `node:sqlite` module with `DatabaseSync`) and under Bun (which
 * exposes `bun:sqlite` with `Database`). Neither runtime knows the other's
 * builtin, so we detect the host at open time and normalise both engines behind
 * a single minimal, synchronous interface.
 *
 * Zero external dependencies, zero native compilation — exactly the guarantee
 * required by the Approach A specification.
 */

const nodeRequire = createRequire(import.meta.url);

/** Values accepted as positional bind parameters. */
export type SqlParam = string | number | bigint | boolean | null | Uint8Array;

export interface SqlRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  run(...params: SqlParam[]): SqlRunResult;
  get<T = Record<string, unknown>>(...params: SqlParam[]): T | undefined;
  all<T = Record<string, unknown>>(...params: SqlParam[]): T[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

/** Shape shared by `node:sqlite` and `bun:sqlite` prepared statements. */
interface RawStatement {
  run(...params: SqlParam[]): SqlRunResult;
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
}

/** Shape shared by both engines' database handles. */
interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

interface RawDatabaseConstructor {
  new (path: string): RawDatabase;
}

function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

function wrapStatement(stmt: RawStatement): SqlStatement {
  return {
    run: (...params) => stmt.run(...params),
    get: <T = Record<string, unknown>>(...params: SqlParam[]) =>
      stmt.get(...params) as T | undefined,
    all: <T = Record<string, unknown>>(...params: SqlParam[]) =>
      stmt.all(...params) as T[],
  };
}

function wrapDatabase(db: RawDatabase): SqlDatabase {
  // Default rollback journal (not WAL): a local single-process Brain gains
  // nothing from WAL, and WAL leaves locked `-wal`/`-shm` sidecar files that
  // Windows refuses to release promptly, breaking clean teardown.
  db.exec("PRAGMA foreign_keys = ON;");
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => wrapStatement(db.prepare(sql)),
    close: () => db.close(),
  };
}

/**
 * Open (or create) a SQLite database at `path` using whichever engine the
 * current runtime provides. Foreign key enforcement is enabled on every
 * connection so the Brain's referential integrity holds under both engines.
 */
export function openDatabase(path: string): SqlDatabase {
  if (isBun()) {
    const { Database } = nodeRequire("bun:sqlite") as {
      Database: RawDatabaseConstructor;
    };
    return wrapDatabase(new Database(path));
  }

  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: RawDatabaseConstructor;
  };
  return wrapDatabase(new DatabaseSync(path));
}
