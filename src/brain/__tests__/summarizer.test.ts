import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "bun:test";
import { BrainStore } from "../brain-store.js";
import {
  captureInteraction,
  extractInteractionText,
  type Reformulator,
} from "../summarizer.js";

let root: string;
let brain: BrainStore;
let projectId: string;
let sessionId: string;

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
  root = mkdtempSync(join(tmpdir(), "oma-summarizer-"));
  brain = new BrainStore(join(root, "brain.sqlite"));
  const project = brain.ensureProject({ name: "P", rootPath: "/repos/p" });
  projectId = project.id;
  sessionId = brain.startSession({ projectId }).id;
});

afterEach(() => {
  brain.close();
  removeTree(root);
});

const goodReformulator: Reformulator = async () => ({
  userIntent: "Wire the summarizer",
  actionsTaken: "Created summarizer.ts core",
  outcome: "Core compiles and records interactions",
  memory: {
    dimension: "architectural_decision",
    title: "Summarizer is fail-open",
    content: "A summarizer failure never breaks the session; raw capture is the fallback.",
    tags: ["memory", "hook"],
  },
});

test("records a reformulated interaction and its durable memory", async () => {
  const result = await captureInteraction({
    brain,
    projectId,
    sessionId,
    projectName: "P",
    text: "user asked to wire the summarizer; assistant created the core module",
    reformulate: goodReformulator,
  });

  assert.equal(result.recorded, true);
  assert.equal(result.summarized, true);
  assert.ok(result.interactionId);
  assert.ok(result.memoryId);

  const interactions = brain.listInteractions(sessionId);
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].userIntent, "Wire the summarizer");
  assert.equal(interactions[0].roundNumber, 0);

  const memories = brain.queryMemory({
    projectId,
    dimensions: ["architectural_decision"],
  });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].title, "Summarizer is fail-open");
  assert.equal(memories[0].sessionId, sessionId);
});

test("advances the round number across successive captures", async () => {
  await captureInteraction({
    brain,
    projectId,
    sessionId,
    projectName: "P",
    text: "first exchange",
    reformulate: async () => ({
      userIntent: "one",
      actionsTaken: "a",
      outcome: "o",
    }),
  });
  await captureInteraction({
    brain,
    projectId,
    sessionId,
    projectName: "P",
    text: "second exchange",
    reformulate: async () => ({
      userIntent: "two",
      actionsTaken: "a",
      outcome: "o",
    }),
  });
  const interactions = brain.listInteractions(sessionId);
  assert.equal(interactions.length, 2);
  assert.deepEqual(
    interactions.map((i) => i.roundNumber),
    [0, 1],
  );
});

test("skips empty interactions without recording", async () => {
  const result = await captureInteraction({
    brain,
    projectId,
    sessionId,
    projectName: "P",
    text: "   ",
    reformulate: goodReformulator,
  });
  assert.equal(result.recorded, false);
  assert.equal(result.skippedReason, "empty_interaction");
  assert.equal(brain.listInteractions(sessionId).length, 0);
});

test("fails open: a reformulator that returns null still captures the raw interaction", async () => {
  const result = await captureInteraction({
    brain,
    projectId,
    sessionId,
    projectName: "P",
    text: "raw interaction that could not be summarized",
    reformulate: async () => null,
  });
  assert.equal(result.recorded, true);
  assert.equal(result.summarized, false);
  const interactions = brain.listInteractions(sessionId);
  assert.equal(interactions.length, 1);
  assert.match(String(interactions[0].outcome), /raw interaction/);
});

test("fails open: a reformulator that throws still captures the raw interaction", async () => {
  const result = await captureInteraction({
    brain,
    projectId,
    sessionId,
    projectName: "P",
    text: "interaction where Flash crashed",
    reformulate: async () => {
      throw new Error("agy binary missing");
    },
  });
  assert.equal(result.recorded, true);
  assert.equal(result.summarized, false);
  assert.match(String(result.error), /agy binary missing/);
  assert.equal(brain.listInteractions(sessionId).length, 1);
});

test("ignores an invalid memory dimension but still records the interaction", async () => {
  const result = await captureInteraction({
    brain,
    projectId,
    sessionId,
    projectName: "P",
    text: "some exchange",
    reformulate: async () => ({
      userIntent: "i",
      actionsTaken: "a",
      outcome: "o",
      memory: {
        // @ts-expect-error deliberately invalid dimension
        dimension: "not_a_dimension",
        title: "x",
        content: "y",
      },
    }),
  });
  assert.equal(result.recorded, true);
  assert.equal(result.summarized, true);
  assert.equal(result.memoryId, undefined);
  assert.equal(brain.queryMemory({ projectId }).length, 0);
});

// ---------------------------------------------------------------------------
// extractInteractionText
// ---------------------------------------------------------------------------

test("extractInteractionText pulls fields from a Claude-Code-style payload", () => {
  const text = extractInteractionText({
    session_id: "sess-1",
    cwd: "/repos/p",
    tool_name: "Edit",
    tool_input: { path: "a.ts" },
    prompt: "fix the bug",
  });
  assert.match(text, /fix the bug/);
  assert.match(text, /tool: Edit/);
  assert.match(text, /a\.ts/);
});

test("extractInteractionText reads a transcript message array", () => {
  const text = extractInteractionText({
    messages: [
      { role: "user", content: "add a feature" },
      { role: "assistant", content: "done, added it" },
    ],
  });
  assert.match(text, /user: add a feature/);
  assert.match(text, /assistant: done, added it/);
});

test("extractInteractionText returns empty string for junk payloads", () => {
  assert.equal(extractInteractionText(null), "");
  assert.equal(extractInteractionText(42), "");
  assert.equal(extractInteractionText({}), "");
});
