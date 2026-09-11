import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendStagedRecord,
  condenseTranscript,
  isRecordAttributedTo,
  omaStagingDir,
  parseAgyHookPayload,
  readStagedRecords,
  readStagingCursor,
  stagingJournalPath,
  toStagedRecord,
  writeStagingCursor,
  type TranscriptEntry,
} from "../agy-capture.js";
import { drainStagedCapture } from "../staging-drain.js";
import { BrainStore } from "../brain-store.js";

/**
 * Regression guard for the capture refonte. The previous implementation read a
 * Claude-style `messages` array out of the payload, keyed sessions on
 * `session_id`, and ran the Brain plus Flash *inside* the hook. Measured against
 * real AGY 1.2.1 payloads it extracted zero characters and captured nothing.
 *
 * The payload literals below are verbatim captures, see
 * docs/audits/2026-09-11-oma-host-contract/hook-payloads.jsonl
 */

const REAL_PRE_TOOL_USE_PAYLOAD = JSON.stringify({
  artifactDirectoryPath:
    "C:/Users/User/.gemini/antigravity-cli/brain/223a15bf-3688-4962-b150-b63f8e60ac82",
  conversationId: "223a15bf-3688-4962-b150-b63f8e60ac82",
  modelName: "gemini-3.8-flash-high",
  stepIdx: 2,
  toolCall: {
    args: {
      AbsolutePath: "C:\\Users\\User\\Documents\\Repos\\plugins\\ohmyagy\\package.json",
      toolAction: "Viewing file",
    },
    name: "view_file",
  },
  transcriptPath:
    "C:/Users/User/.gemini/antigravity-cli/brain/223a15bf-3688-4962-b150-b63f8e60ac82/.system_generated/logs/transcript_full.jsonl",
  workspacePaths: [],
});

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "oma-capture-"));
}

/**
 * Windows holds the SQLite handle for a moment after close(), so a single
 * rmSync races with the OS. Retry briefly, then give up: a leftover temp
 * directory must never fail a test whose assertions already passed.
 */
function safeRemove(path: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(25);
    }
  }
}

describe("AGY payload capture", () => {
  test("parses a real captured payload and resolves the host session key", () => {
    const payload = parseAgyHookPayload(REAL_PRE_TOOL_USE_PAYLOAD);
    assert.ok(payload);
    assert.equal(payload.conversationId, "223a15bf-3688-4962-b150-b63f8e60ac82");
    assert.equal(payload.stepIdx, 2);
    assert.equal(payload.toolCall?.name, "view_file");
    // AGY provides an empty workspace list: the hook cannot learn its project.
    assert.deepEqual(payload.workspacePaths, []);
  });

  test("a malformed payload never throws", () => {
    assert.equal(parseAgyHookPayload("{ not json"), undefined);
    assert.equal(parseAgyHookPayload('"a string"'), undefined);
    assert.equal(parseAgyHookPayload("[]"), undefined);
    assert.equal(toStagedRecord({}), undefined);
  });

  test("collects absolute tool-call paths and ignores relative ones", () => {
    const record = toStagedRecord({
      conversationId: "c1",
      stepIdx: 4,
      toolCall: {
        name: "run_command",
        args: { CommandLine: "echo hi", Cwd: "C:\\Users\\User\\.gemini\\antigravity-cli" },
      },
    });
    assert.ok(record);
    assert.deepEqual(record.paths, ["C:\\Users\\User\\.gemini\\antigravity-cli"]);
    assert.equal(record.failed, false);
  });

  test("marks a failed tool call", () => {
    const record = toStagedRecord({
      conversationId: "c1",
      stepIdx: 5,
      error: "boom",
      toolCall: { name: "run_command", args: {} },
    });
    assert.equal(record?.failed, true);
  });

  test("appends durably and skips a step already recorded", () => {
    const home = makeTempRoot();
    try {
      const base = { at: new Date().toISOString(), conversationId: "conv-1", tool: "view_file", failed: false, paths: [] };
      assert.equal(appendStagedRecord({ ...base, stepIdx: 1 }, home), true);
      assert.equal(appendStagedRecord({ ...base, stepIdx: 1 }, home), false, "duplicate step must be skipped");
      assert.equal(appendStagedRecord({ ...base, stepIdx: 2 }, home), true);
      assert.equal(appendStagedRecord({ ...base, stepIdx: null }, home), true, "unstepped records are never deduped");

      const records = readStagedRecords(stagingJournalPath("conv-1", home));
      assert.equal(records.length, 3);
      assert.equal(records[0].stepIdx, 1);
    } finally {
      safeRemove(home);
    }
  });

  test("attribution is conservative: no paths means no project", () => {
    const workspace = join(tmpdir(), "a-workspace");
    const inside = { at: "", conversationId: "c", stepIdx: 1, tool: "view_file", failed: false, paths: [join(workspace, "src", "x.ts")] };
    const outside = { ...inside, paths: [join(tmpdir(), "elsewhere", "y.ts")] };
    const noPaths = { ...inside, paths: [] as string[] };
    assert.equal(isRecordAttributedTo(inside, workspace), true);
    assert.equal(isRecordAttributedTo(outside, workspace), false);
    assert.equal(isRecordAttributedTo(noPaths, workspace), false);
  });
});

describe("transcript condensation", () => {
  const entries: TranscriptEntry[] = [
    { type: "USER_INPUT", step_index: 1, content: "Réfléchis au plan" },
    { type: "PLANNER_RESPONSE", step_index: 2, thinking: "je réfléchis", tool_calls: [{ name: "view_file" }] },
    { type: "PLANNER_RESPONSE", step_index: 3, tool_calls: [{ name: "run_command" }] },
  ];

  test("renders only the steps past the cursor", () => {
    const condensed = condenseTranscript(entries, 1);
    assert.equal(condensed.lastStep, 3);
    assert.equal(condensed.text.includes("USER[1]"), false, "the cursor step must not be replayed");
    assert.match(condensed.text, /ASSISTANT_THINKING\[2\]: je réfléchis/);
    assert.match(condensed.text, /ASSISTANT_TOOLS\[2\]: view_file/);
    assert.match(condensed.text, /ASSISTANT_TOOLS\[3\]: run_command/);
  });

  test("bounds the output so a long session cannot grow the Brain without limit", () => {
    const long: TranscriptEntry[] = [
      { type: "USER_INPUT", step_index: 1, content: "x".repeat(5_000) },
    ];
    const condensed = condenseTranscript(long, -1, 500);
    assert.equal(condensed.truncated, true);
    assert.ok(condensed.text.length < 600);
    assert.match(condensed.text, /truncated/);
  });

  test("an empty transcript condenses to nothing", () => {
    assert.deepEqual(condenseTranscript([], -1), { text: "", lastStep: -1, truncated: false });
  });
});

describe("drain: attribution, condensation and idempotence", () => {
  test("captures an attributed conversation once, then never replays it", async () => {
    const home = makeTempRoot();
    const workspace = makeTempRoot();
    let brain: BrainStore | undefined;
    try {
      const projectFile = join(workspace, "package.json");
      writeFileSync(projectFile, '{"name":"symap"}\n', "utf8");

      const transcriptPath = join(workspace, "transcript_full.jsonl");
      writeFileSync(
        transcriptPath,
        [
          JSON.stringify({ type: "USER_INPUT", step_index: 1, content: "Quel est le statut ?" }),
          JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 2, thinking: "j'inspecte", tool_calls: [{ name: "view_file" }] }),
        ].join("\n") + "\n",
        "utf8",
      );

      // One attributed conversation and one that must stay in the journal.
      appendStagedRecord(
        { at: new Date().toISOString(), conversationId: "conv-symap", stepIdx: 2, tool: "view_file", failed: false, paths: [projectFile], transcriptPath },
        home,
      );
      appendStagedRecord(
        { at: new Date().toISOString(), conversationId: "conv-elsewhere", stepIdx: 2, tool: "view_file", failed: false, paths: [join(tmpdir(), "other", "z.ts")], transcriptPath },
        home,
      );

      brain = new BrainStore(join(home, "brain.sqlite"));
      const reformulate = async (text: string) => ({ context: text.slice(0, 40), actions: "captured" });

      const first = await drainStagedCapture({ brain, workspaceRoot: workspace, homeDirectory: home, reformulate });
      assert.equal(first.captured, 1);
      assert.equal(first.skippedUnattributed, 1, "an unattributable conversation must not be poured into the project");
      assert.equal(first.conversationsInspected, 2);
      assert.deepEqual(first.errors, []);

      const second = await drainStagedCapture({ brain, workspaceRoot: workspace, homeDirectory: home, reformulate });
      assert.equal(second.captured, 0, "the cursor must prevent a replay");

      assert.equal(readStagingCursor(workspace, "conv-symap"), 2);
    } finally {
      brain?.close();
      safeRemove(home);
      safeRemove(workspace);
    }
  });

  test("a missing staging directory is not an error", async () => {
    const home = makeTempRoot();
    const workspace = makeTempRoot();
    let brain: BrainStore | undefined;
    try {
      assert.equal(omaStagingDir(home).includes(".oma"), true);
      brain = new BrainStore(join(home, "brain.sqlite"));
      const result = await drainStagedCapture({ brain, workspaceRoot: workspace, homeDirectory: home });
      assert.deepEqual(result, {
        conversationsInspected: 0,
        conversationsAttributed: 0,
        captured: 0,
        skippedUnattributed: 0,
        errors: [],
      });
    } finally {
      brain?.close();
      safeRemove(home);
      safeRemove(workspace);
    }
  });

  test("cursor round-trips and survives a missing file", () => {
    const workspace = makeTempRoot();
    try {
      assert.equal(readStagingCursor(workspace, "conv-x"), -1);
      writeStagingCursor(workspace, "conv-x", 7);
      assert.equal(readStagingCursor(workspace, "conv-x"), 7);
    } finally {
      safeRemove(workspace);
    }
  });
});
