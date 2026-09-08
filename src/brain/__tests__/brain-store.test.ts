import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "bun:test";
import { BrainStore, BrainStoreError } from "../brain-store.js";

let root: string;
let store: BrainStore;

function freshStore(): BrainStore {
  return new BrainStore(join(root, "brain.sqlite"));
}

/**
 * Windows can hold a SQLite file handle briefly after close(), so a naive rm
 * races the OS and throws EBUSY. Retry a few times, then give up quietly — the
 * OS reclaims the temp directory regardless.
 */
function removeTree(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") {
        throw err;
      }
      Bun.sleepSync(20);
    }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oma-brain-test-"));
  store = freshStore();
});

afterEach(() => {
  store.close();
  removeTree(root);
});

// ---------------------------------------------------------------------------
// Schema & projects
// ---------------------------------------------------------------------------

test("initialises schema and creates a project idempotently by root path", () => {
  const first = store.ensureProject({
    name: "Demo",
    rootPath: "/repos/demo",
    techStack: "typescript",
  });
  assert.equal(first.name, "Demo");
  assert.equal(first.rootPath, "/repos/demo");
  assert.equal(first.techStack, "typescript");
  assert.ok(first.id.length > 0);

  const second = store.ensureProject({
    name: "Demo Renamed",
    rootPath: "/repos/demo",
    techStack: "typescript,bun",
  });
  // Same root path => same project, no duplicate.
  assert.equal(second.id, first.id);
  assert.equal(second.name, "Demo Renamed");
  assert.equal(second.techStack, "typescript,bun");
  assert.equal(store.listProjects().length, 1);
});

test("rejects blank required fields", () => {
  assert.throws(
    () => store.ensureProject({ name: "", rootPath: "/x" }),
    (err: unknown) =>
      err instanceof BrainStoreError && err.code === "VALIDATION_ERROR",
  );
});

// ---------------------------------------------------------------------------
// Multi-project isolation (the core guarantee)
// ---------------------------------------------------------------------------

test("strictly isolates memory between two different projects", () => {
  const alpha = store.ensureProject({ name: "Alpha", rootPath: "/repos/alpha" });
  const beta = store.ensureProject({ name: "Beta", rootPath: "/repos/beta" });

  store.storeMemory({
    projectId: alpha.id,
    dimension: "architectural_decision",
    title: "Use hexagonal architecture",
    content: "Ports and adapters everywhere.",
    tags: ["arch"],
  });
  store.storeMemory({
    projectId: beta.id,
    dimension: "architectural_decision",
    title: "Use event sourcing",
    content: "Append-only ledger.",
  });

  const alphaMem = store.queryMemory({ projectId: alpha.id });
  const betaMem = store.queryMemory({ projectId: beta.id });

  assert.equal(alphaMem.length, 1);
  assert.equal(betaMem.length, 1);
  assert.equal(alphaMem[0].title, "Use hexagonal architecture");
  assert.equal(betaMem[0].title, "Use event sourcing");
  // No cross-contamination.
  assert.ok(alphaMem.every((m) => m.projectId === alpha.id));
  assert.ok(betaMem.every((m) => m.projectId === beta.id));
});

// ---------------------------------------------------------------------------
// Memory CRUD & querying
// ---------------------------------------------------------------------------

test("stores, updates, and deletes a memory entry", () => {
  const project = store.ensureProject({ name: "P", rootPath: "/repos/p" });
  const entry = store.storeMemory({
    projectId: project.id,
    dimension: "past_error",
    title: "Bun lacks node:sqlite",
    content: "Use a cross-runtime adapter.",
    tags: ["bun", "sqlite"],
    confidence: 0.9,
  });

  assert.equal(entry.dimension, "past_error");
  assert.deepEqual(entry.tags, ["bun", "sqlite"]);
  assert.equal(entry.confidence, 0.9);
  assert.equal(entry.sessionId, null);

  const updated = store.updateMemory(entry.id, {
    content: "Detect Bun and use bun:sqlite.",
    confidence: 1,
    tags: ["bun", "sqlite", "adapter"],
  });
  assert.equal(updated.content, "Detect Bun and use bun:sqlite.");
  assert.equal(updated.confidence, 1);
  assert.deepEqual(updated.tags, ["bun", "sqlite", "adapter"]);
  assert.ok(updated.updatedAt >= entry.updatedAt);

  assert.equal(store.deleteMemory(entry.id), true);
  assert.equal(store.getMemory(entry.id), undefined);
  assert.equal(store.deleteMemory(entry.id), false);
});

test("filters memory by dimension and free-text keyword", () => {
  const project = store.ensureProject({ name: "P", rootPath: "/repos/p" });
  store.storeMemory({
    projectId: project.id,
    dimension: "user_preference",
    title: "Prefers 2-space indent",
    content: "Formatting preference.",
  });
  store.storeMemory({
    projectId: project.id,
    dimension: "architectural_decision",
    title: "SQLite Neural Brain",
    content: "Zero-dependency persistence layer.",
  });
  store.storeMemory({
    projectId: project.id,
    dimension: "architectural_decision",
    title: "Event ledger",
    content: "SHA-256 hash chaining for provenance.",
  });

  const byDim = store.queryMemory({
    projectId: project.id,
    dimensions: ["architectural_decision"],
  });
  assert.equal(byDim.length, 2);

  const byKeyword = store.queryMemory({
    projectId: project.id,
    query: "SQLite",
  });
  assert.equal(byKeyword.length, 1);
  assert.equal(byKeyword[0].title, "SQLite Neural Brain");

  const combined = store.queryMemory({
    projectId: project.id,
    dimensions: ["user_preference"],
    query: "indent",
  });
  assert.equal(combined.length, 1);
  assert.equal(combined[0].title, "Prefers 2-space indent");
});

test("treats LIKE wildcards in queries as literal characters", () => {
  const project = store.ensureProject({ name: "P", rootPath: "/repos/p" });
  store.storeMemory({
    projectId: project.id,
    dimension: "project_context",
    title: "Discount is 100% verified",
    content: "literal percent",
  });
  store.storeMemory({
    projectId: project.id,
    dimension: "project_context",
    title: "No special chars here",
    content: "plain",
  });

  // A literal "100%" must not behave like a wildcard match-all.
  const literal = store.queryMemory({ projectId: project.id, query: "100%" });
  assert.equal(literal.length, 1);
  assert.equal(literal[0].title, "Discount is 100% verified");
});

test("orders query results most-recently-updated first and honours limit", () => {
  const project = store.ensureProject({ name: "P", rootPath: "/repos/p" });
  const a = store.storeMemory({
    projectId: project.id,
    dimension: "run_summary",
    title: "Run A",
    content: "first",
  });
  store.storeMemory({
    projectId: project.id,
    dimension: "run_summary",
    title: "Run B",
    content: "second",
  });
  // Touch A so it becomes most recent.
  store.updateMemory(a.id, { content: "first updated" });

  const ordered = store.queryMemory({ projectId: project.id });
  assert.equal(ordered[0].title, "Run A");

  const limited = store.queryMemory({ projectId: project.id, limit: 1 });
  assert.equal(limited.length, 1);
});

test("rejects invalid dimensions and unknown project references", () => {
  const project = store.ensureProject({ name: "P", rootPath: "/repos/p" });
  assert.throws(
    () =>
      store.storeMemory({
        projectId: project.id,
        // @ts-expect-error deliberately invalid dimension
        dimension: "not_a_dimension",
        title: "x",
        content: "y",
      }),
    (err: unknown) =>
      err instanceof BrainStoreError && err.code === "VALIDATION_ERROR",
  );
  assert.throws(
    () =>
      store.storeMemory({
        projectId: "ghost",
        dimension: "past_error",
        title: "x",
        content: "y",
      }),
    (err: unknown) =>
      err instanceof BrainStoreError && err.code === "NOT_FOUND",
  );
});

// ---------------------------------------------------------------------------
// Sessions & interaction summaries
// ---------------------------------------------------------------------------

test("manages session lifecycle and links memory to a session", () => {
  const project = store.ensureProject({ name: "P", rootPath: "/repos/p" });
  const session = store.startSession({
    projectId: project.id,
    objective: "Ship the Brain",
  });
  assert.equal(session.status, "active");
  assert.equal(session.objective, "Ship the Brain");

  const mem = store.storeMemory({
    projectId: project.id,
    sessionId: session.id,
    dimension: "run_summary",
    title: "Round 1",
    content: "Created BrainStore.",
  });
  assert.equal(mem.sessionId, session.id);

  const paused = store.updateSession(session.id, { status: "paused" });
  assert.equal(paused.status, "paused");

  const completed = store.updateSession(session.id, {
    status: "completed",
    objective: "Brain shipped",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.objective, "Brain shipped");

  assert.equal(store.listSessions(project.id).length, 1);
});

test("records and lists interaction summaries chronologically by round", () => {
  const project = store.ensureProject({ name: "P", rootPath: "/repos/p" });
  const session = store.startSession({ projectId: project.id });

  store.recordInteraction({
    sessionId: session.id,
    roundNumber: 2,
    userIntent: "Add query filter",
    outcome: "done",
  });
  store.recordInteraction({
    sessionId: session.id,
    roundNumber: 1,
    userIntent: "Create schema",
    actionsTaken: "wrote SCHEMA",
    outcome: "done",
  });

  const rounds = store.listInteractions(session.id);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].roundNumber, 1);
  assert.equal(rounds[1].roundNumber, 2);
  assert.equal(rounds[0].userIntent, "Create schema");
});

test("rejects sessions on unknown projects and interactions on unknown sessions", () => {
  assert.throws(
    () => store.startSession({ projectId: "ghost" }),
    (err: unknown) => err instanceof BrainStoreError && err.code === "NOT_FOUND",
  );
  assert.throws(
    () => store.recordInteraction({ sessionId: "ghost", roundNumber: 0 }),
    (err: unknown) => err instanceof BrainStoreError && err.code === "NOT_FOUND",
  );
});

// ---------------------------------------------------------------------------
// Durability across reopen
// ---------------------------------------------------------------------------

test("persists data across store reopen (crash/resume survival)", () => {
  const project = store.ensureProject({ name: "P", rootPath: "/repos/p" });
  const session = store.startSession({ projectId: project.id });
  store.storeMemory({
    projectId: project.id,
    sessionId: session.id,
    dimension: "architectural_decision",
    title: "Durable",
    content: "Survives reopen.",
  });
  store.close();

  const reopened = freshStore();
  try {
    const projects = reopened.listProjects();
    assert.equal(projects.length, 1);
    const mem = reopened.queryMemory({ projectId: project.id });
    assert.equal(mem.length, 1);
    assert.equal(mem[0].title, "Durable");
    assert.equal(reopened.listSessions(project.id).length, 1);
  } finally {
    // The afterEach hook closes `store`; point it at the reopened handle.
    store = reopened;
  }
});
