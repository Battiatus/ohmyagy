import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "bun:test";
import { handleRequest, type BrokerConfig } from "../broker-server.js";
import { MissionJournal } from "../../ledger/mission-journal.js";
import { BrainStore } from "../../brain/brain-store.js";

let root: string;
let config: BrokerConfig;
let journal: MissionJournal;
let brain: BrainStore;
let stagedRecords: Map<string, never>;

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

/** Drive a JSON-RPC call through the broker's request handler. */
function rpc(
  method: string,
  params?: Record<string, unknown>,
): Record<string, unknown> {
  const response = handleRequest(
    config,
    journal,
    stagedRecords as Map<string, never>,
    { jsonrpc: "2.0", id: 1, method, params },
    () => brain,
  );
  return response.result as Record<string, unknown>;
}

/** Call a tool and return its structured result. */
function callTool(
  name: string,
  args: Record<string, unknown>,
): { structured: Record<string, unknown>; isError: boolean } {
  const result = rpc("tools/call", { name, arguments: args });
  return {
    structured: result.structuredContent as Record<string, unknown>,
    isError: Boolean(result.isError),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oma-brain-tools-"));
  config = {
    workspaceRoot: root,
    gates: [],
    brainPath: join(root, ".oma", "brain.sqlite"),
  };
  journal = new MissionJournal("brain-tools-mission", "code-change", {
    journalStorePath: join(root, "events.jsonl"),
  });
  brain = new BrainStore(config.brainPath!);
  stagedRecords = new Map();
});

afterEach(() => {
  brain.close();
  removeTree(root);
});

test("tools/list advertises the four brain tools with schemas", () => {
  const result = rpc("tools/list");
  const tools = result.tools as Array<{ name: string; inputSchema: unknown }>;
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("brain_store"));
  assert.ok(names.includes("brain_query"));
  assert.ok(names.includes("brain_summarize"));
  assert.ok(names.includes("brain_compact"));
  const store = tools.find((t) => t.name === "brain_store");
  assert.ok(store);
  assert.equal(typeof store.inputSchema, "object");
  const compactTool = tools.find((t) => t.name === "brain_compact");
  assert.ok(compactTool);
  assert.equal(typeof compactTool.inputSchema, "object");
});


test("brain_store persists a memory scoped to the current workspace project", () => {
  const { structured, isError } = callTool("brain_store", {
    dimension: "architectural_decision",
    title: "Adopt session-native orchestration",
    content: "MCP is the motor, skills are the driver.",
    tags: ["arch", "oma-v2"],
  });
  assert.equal(isError, false);
  assert.equal(structured.status, "stored");
  const entry = structured.entry as Record<string, unknown>;
  assert.equal(entry.dimension, "architectural_decision");
  assert.deepEqual(entry.tags, ["arch", "oma-v2"]);
  assert.equal(typeof structured.projectId, "string");
});

test("brain_query round-trips a stored entry within the same project", () => {
  callTool("brain_store", {
    dimension: "past_error",
    title: "Bun lacks node:sqlite",
    content: "Use a cross-runtime adapter.",
  });
  const { structured, isError } = callTool("brain_query", {
    query: "cross-runtime",
  });
  assert.equal(isError, false);
  assert.equal(structured.status, "queried");
  assert.equal(structured.count, 1);
  const entries = structured.entries as Array<Record<string, unknown>>;
  assert.equal(entries[0].title, "Bun lacks node:sqlite");
});

test("brain_query filters by dimension", () => {
  callTool("brain_store", {
    dimension: "user_preference",
    title: "2-space indent",
    content: "pref",
  });
  callTool("brain_store", {
    dimension: "architectural_decision",
    title: "SQLite Brain",
    content: "decision",
  });
  const { structured } = callTool("brain_query", {
    dimensions: ["architectural_decision"],
  });
  assert.equal(structured.count, 1);
  const entries = structured.entries as Array<Record<string, unknown>>;
  assert.equal(entries[0].title, "SQLite Brain");
});

test("brain_summarize auto-creates a session and advances the round counter", () => {
  const first = callTool("brain_summarize", {
    objective: "Ship the Brain",
    userIntent: "Create schema",
    outcome: "done",
    content: "Round 0: schema created.",
  });
  assert.equal(first.isError, false);
  assert.equal(first.structured.status, "summarized");
  const sessionId = first.structured.sessionId as string;
  assert.equal(typeof sessionId, "string");
  assert.ok(first.structured.memoryId);
  const interaction0 = first.structured.interaction as Record<string, unknown>;
  assert.equal(interaction0.roundNumber, 0);

  const second = callTool("brain_summarize", {
    sessionId,
    userIntent: "Wire MCP tools",
    outcome: "done",
  });
  const interaction1 = second.structured.interaction as Record<string, unknown>;
  assert.equal(second.structured.sessionId, sessionId);
  assert.equal(interaction1.roundNumber, 1);

  // The run_summary memory from round 0 is queryable.
  const q = callTool("brain_query", { dimensions: ["run_summary"] });
  assert.equal(q.structured.count, 1);
});

test("brain_store rejects an invalid dimension with a structured error", () => {
  const { structured, isError } = callTool("brain_store", {
    dimension: "not_a_dimension",
    title: "x",
    content: "y",
  });
  assert.equal(isError, true);
  assert.equal(structured.status, "rejected");
  assert.match(String(structured.reason), /dimension/i);
});

test("brain tools reject an explicit unknown project id", () => {
  const { structured, isError } = callTool("brain_query", {
    projectId: "ghost-project",
  });
  assert.equal(isError, true);
  assert.equal(structured.status, "rejected");
  assert.match(String(structured.reason), /ghost-project/);
});

test("brain_summarize records canonical context, actions, and nodeRef", () => {
  const res = callTool("brain_summarize", {
    context: "Canonical round context: fix authentication bug",
    actions: "Applied patch to auth handler and re-ran tests",
    outcome: "all passed",
    nodeRef: "task-auth-fix",
  });
  assert.equal(res.isError, false);
  assert.equal(res.structured.status, "summarized");
  const interaction = res.structured.interaction as Record<string, unknown>;
  assert.equal(interaction.userIntent, "Canonical round context: fix authentication bug");
  assert.equal(interaction.actionsTaken, "Applied patch to auth handler and re-ran tests");
  assert.equal(interaction.nodeRef, "task-auth-fix");
  assert.equal(interaction.context, "Canonical round context: fix authentication bug");
  assert.equal(interaction.actions, "Applied patch to auth handler and re-ran tests");
});

test("brain_compact deduplicates entries, prunes low-confidence run summaries, and prunes interaction summaries", () => {
  // 1. Duplicate memory entries
  callTool("brain_store", {
    dimension: "run_summary",
    title: "Round 1 summary",
    content: "Execution completed wave 1",
    confidence: 0.9,
  });
  callTool("brain_store", {
    dimension: "run_summary",
    title: "Round 1 summary",
    content: "Execution completed wave 1",
    confidence: 0.9,
  });

  // 2. Low-confidence run summary
  callTool("brain_store", {
    dimension: "run_summary",
    title: "Speculative run",
    content: "Low confidence summary",
    confidence: 0.2,
  });

  // 3. Low-confidence architectural decision (must be strictly preserved!)
  callTool("brain_store", {
    dimension: "architectural_decision",
    title: "Adopt SQLite adapter",
    content: "Use cross-runtime adapter",
    confidence: 0.2,
  });

  // 4. Interaction summaries
  const sumRes = callTool("brain_summarize", {
    objective: "Test compact",
    content: "Interaction 0",
    roundNumber: 0,
  });
  const sessionId = sumRes.structured.sessionId as string;
  for (let r = 1; r <= 5; r++) {
    callTool("brain_summarize", {
      sessionId,
      content: `Interaction ${r}`,
      roundNumber: r,
    });
  }

  // 5. Call brain_compact
  const { structured, isError } = callTool("brain_compact", {
    runSummaryMinConfidence: 0.5,
    maxInteractionsPerSession: 3,
  });

  assert.equal(isError, false);
  assert.equal(structured.status, "compacted");
  assert.equal(typeof structured.projectId, "string");
  assert.ok(Number(structured.entriesDeduplicated) >= 1);
  assert.ok(Number(structured.runSummariesPruned) >= 1);
  assert.ok(Number(structured.interactionsPruned) >= 1);

  // Verify architectural decision was strictly preserved
  const queryArch = callTool("brain_query", {
    dimensions: ["architectural_decision"],
  });
  const archEntries = queryArch.structured.entries as Array<Record<string, unknown>>;
  assert.equal(archEntries.length, 1);
  assert.equal(archEntries[0].title, "Adopt SQLite adapter");

  // Verify speculative run summary was pruned
  const queryRun = callTool("brain_query", {
    dimensions: ["run_summary"],
  });
  const runEntries = queryRun.structured.entries as Array<Record<string, unknown>>;
  assert.ok(!runEntries.some((e) => e.title === "Speculative run"));
});

test("brain_compact supports condenseInteractions", () => {
  const sumRes = callTool("brain_summarize", {
    objective: "Test condense",
    content: "Initial round",
    context: "Intent initial",
    roundNumber: 0,
  });
  const sessionId = sumRes.structured.sessionId as string;
  for (let r = 1; r <= 6; r++) {
    callTool("brain_summarize", {
      sessionId,
      content: `Round ${r} done`,
      context: `Context ${r}`,
      actions: `Action ${r}`,
      roundNumber: r,
    });
  }

  const { structured, isError } = callTool("brain_compact", {
    maxInteractionsPerSession: 2,
    condenseInteractions: true,
  });

  assert.equal(isError, false);
  assert.equal(structured.status, "compacted");
  assert.ok(Number(structured.interactionsCondensed) >= 4);

  // Total interactions after should be <= 3 (2 retained + 1 condensed rollup)
  const interactions = brain.listInteractions(sessionId);
  assert.ok(interactions.length <= 3);
  assert.ok(interactions.some((i) => i.userIntent?.includes("[Condensed")));
});

test("brain_compact accepts vacuum parameter", () => {
  const { structured, isError } = callTool("brain_compact", {
    vacuum: false,
  });
  assert.equal(isError, false);
  assert.equal(structured.status, "compacted");
});

