import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "bun:test";
import { BrainStore, BrainStoreError } from "../brain-store.js";
import { openDatabase } from "../sqlite-adapter.js";

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

test("links interaction rounds to node_ref and filters by node", () => {
  const project = store.ensureProject({ name: "P", rootPath: "/repos/p" });
  const session1 = store.startSession({ projectId: project.id });
  const session2 = store.startSession({ projectId: project.id });

  const r1 = store.recordInteraction({
    sessionId: session1.id,
    roundNumber: 0,
    userIntent: "Implement node A",
    actionsTaken: "Wrote code for node A",
    outcome: "compiled",
    nodeRef: "node-alpha",
  });
  assert.equal(r1.nodeRef, "node-alpha");
  assert.equal(r1.context, "Implement node A");
  assert.equal(r1.actions, "Wrote code for node A");

  const r2 = store.recordInteraction({
    sessionId: session1.id,
    roundNumber: 1,
    userIntent: "Implement node B",
    actionsTaken: "Wrote code for node B",
    outcome: "compiled",
    nodeRef: "node-beta",
  });
  assert.equal(r2.nodeRef, "node-beta");

  const r3 = store.recordInteraction({
    sessionId: session2.id,
    roundNumber: 0,
    userIntent: "Review node A in second session",
    actionsTaken: "Verified node A",
    outcome: "approved",
    nodeRef: "node-alpha",
  });

  // Verify getInteraction retrieves nodeRef
  assert.equal(store.getInteraction(r1.id)?.nodeRef, "node-alpha");
  assert.equal(store.getInteraction(r2.id)?.nodeRef, "node-beta");

  // Verify listInteractions filtering by nodeRef within a session
  const alphaInSession1 = store.listInteractions(session1.id, "node-alpha");
  assert.equal(alphaInSession1.length, 1);
  assert.equal(alphaInSession1[0].id, r1.id);
  assert.equal(alphaInSession1[0].nodeRef, "node-alpha");

  const betaInSession1 = store.listInteractions(session1.id, "node-beta");
  assert.equal(betaInSession1.length, 1);
  assert.equal(betaInSession1[0].id, r2.id);

  // Verify listInteractionsByNode returns all interactions across sessions
  const alphaAll = store.listInteractionsByNode("node-alpha");
  assert.equal(alphaAll.length, 2);
  assert.deepEqual(
    alphaAll.map((i) => i.id).sort(),
    [r1.id, r3.id].sort(),
  );

  // Non-existent node returns empty array
  assert.equal(store.listInteractionsByNode("ghost-node").length, 0);
  assert.equal(store.listInteractions(session1.id, "ghost-node").length, 0);
});

test("migrates existing database lacking node_ref column additively", () => {
  const legacyDbPath = join(root, "legacy.sqlite");
  const rawDb = openDatabase(legacyDbPath);

  // Create legacy schema without node_ref column
  rawDb.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, tech_stack TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, started_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, objective TEXT, status TEXT NOT NULL);
    CREATE TABLE memory_entries (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT, dimension TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT, confidence REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE interaction_summaries (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, round_number INTEGER NOT NULL, user_intent TEXT, actions_taken TEXT, outcome TEXT, created_at INTEGER NOT NULL);
  `);
  rawDb.prepare(`INSERT INTO projects VALUES ('p1', 'Legacy', '/repos/legacy', null, 100, 100)`).run();
  rawDb.prepare(`INSERT INTO sessions VALUES ('s1', 'p1', 100, 100, 'Legacy test', 'active')`).run();
  rawDb.prepare(`INSERT INTO interaction_summaries VALUES ('i1', 's1', 0, 'Legacy intent', 'Legacy action', 'ok', 100)`).run();
  rawDb.close();

  // Open with BrainStore: migration should detect missing node_ref, run ALTER TABLE and add index
  const migratedStore = new BrainStore(legacyDbPath);
  try {
    const existing = migratedStore.getInteraction("i1");
    assert.ok(existing);
    assert.equal(existing.nodeRef, null);

    // New interaction with nodeRef can be recorded into migrated store
    const newInt = migratedStore.recordInteraction({
      sessionId: "s1",
      roundNumber: 1,
      userIntent: "Migrated round",
      nodeRef: "migrated-node-1",
    });
    assert.equal(newInt.nodeRef, "migrated-node-1");

    const fetched = migratedStore.getInteraction(newInt.id);
    assert.equal(fetched?.nodeRef, "migrated-node-1");
  } finally {
    migratedStore.close();
  }
});

test("supports idempotent upsert with deterministic id for memory and interactions", () => {
  const project = store.ensureProject({ name: "P", rootPath: "/repos/p" });
  const session = store.startSession({ projectId: project.id });

  // Idempotent storeMemory with explicit id
  const memId = "deterministic-mem-1";
  const m1 = store.storeMemory({
    id: memId,
    projectId: project.id,
    sessionId: session.id,
    dimension: "run_summary",
    title: "Initial run",
    content: "Run started",
  });
  assert.equal(m1.id, memId);
  assert.equal(m1.content, "Run started");

  const m2 = store.storeMemory({
    id: memId,
    projectId: project.id,
    sessionId: session.id,
    dimension: "run_summary",
    title: "Updated run",
    content: "Run completed successfully",
  });
  assert.equal(m2.id, memId);
  assert.equal(m2.content, "Run completed successfully");
  assert.equal(store.queryMemory({ projectId: project.id }).length, 1);

  // Idempotent recordInteraction with explicit id
  const intId = "deterministic-int-1";
  const i1 = store.recordInteraction({
    id: intId,
    sessionId: session.id,
    roundNumber: 0,
    userIntent: "Step 1",
    nodeRef: "node-1",
  });
  assert.equal(i1.id, intId);
  assert.equal(i1.userIntent, "Step 1");

  const i2 = store.recordInteraction({
    id: intId,
    sessionId: session.id,
    roundNumber: 0,
    userIntent: "Step 1 completed",
    nodeRef: "node-1",
  });
  assert.equal(i2.id, intId);
  assert.equal(i2.userIntent, "Step 1 completed");
  assert.equal(store.listInteractions(session.id).length, 1);
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
