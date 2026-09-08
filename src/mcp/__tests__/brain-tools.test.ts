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

test("tools/list advertises the three brain tools with schemas", () => {
  const result = rpc("tools/list");
  const tools = result.tools as Array<{ name: string; inputSchema: unknown }>;
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("brain_store"));
  assert.ok(names.includes("brain_query"));
  assert.ok(names.includes("brain_summarize"));
  const store = tools.find((t) => t.name === "brain_store");
  assert.ok(store);
  assert.equal(typeof store.inputSchema, "object");
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
