import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMITTABLE_HOOK_EVENTS,
  HOOK_EVENT_EVIDENCE,
  buildOmaHooks,
  validateHooksDocument,
  validateHooksFile,
} from "../hook-contract.js";

/**
 * Regression guard for the defect captured on AGY 1.2.1 (2026-09-11):
 * the memory hook was keyed on the unsupported `Stop` event. The runtime
 * ignores unknown event keys, then validates the spec as a command hook and
 * fails with `command hook must specify 'command'`. That single invalid hook
 * made the runtime discard the WHOLE hooks.json, so the strict write gate
 * (`oma-strict-write-gate`) was never registered either.
 *
 * These cases fail against the pre-fix shape on purpose.
 */

const GOOD_COMMAND = "node C:/oma/dist/src/strict/hook.js";

describe("AGY hooks.json contract", () => {
  test("the installed document is contract-valid and uses only emittable events", () => {
    const document = buildOmaHooks({
      writeGateCommand: GOOD_COMMAND,
      memoryCommand: "node C:/oma/dist/src/brain/summarizer-hook.js",
    });

    const verdict = validateHooksDocument(document);
    assert.equal(verdict.valid, true, JSON.stringify(verdict.problems));
    assert.deepEqual(verdict.hookNames.sort(), [
      "oma-memory-summarizer",
      "oma-strict-write-gate",
    ]);
    for (const event of verdict.events) {
      assert.ok(
        EMITTABLE_HOOK_EVENTS.includes(event),
        `'${event}' is not an event with recorded evidence`,
      );
    }
  });

  test("the historical `Stop` shape is rejected as a whole-file failure", () => {
    const historical = {
      "oma-strict-write-gate": {
        enabled: true,
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: GOOD_COMMAND, timeout: 10 }] },
        ],
      },
      "oma-memory-summarizer": {
        enabled: true,
        Stop: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "node C:/oma/summarizer-hook.js", timeout: 30 }],
          },
        ],
      },
    };

    const verdict = validateHooksDocument(historical);
    assert.equal(verdict.valid, false, "an unsupported event must fail the whole document");
    const problem = verdict.problems.find((entry) => entry.path === "oma-memory-summarizer");
    assert.ok(problem, "the offending hook must be named");
    assert.match(problem.message, /Stop/);
    assert.match(problem.message, /command hook must specify 'command'/);
  });

  test("the Claude/Gemini `{\"hooks\": {...}}` envelope is rejected", () => {
    // AGY treats every TOP-LEVEL key as a hook name, so `hooks` becomes a hook
    // whose spec has no `command` and no recognised event.
    const verdict = validateHooksDocument({
      hooks: { Stop: [{ hooks: [{ type: "command", command: GOOD_COMMAND }] }] },
    });
    assert.equal(verdict.valid, false);
    assert.equal(verdict.problems[0].path, "hooks");
  });

  test("a top-level scalar such as `description` is rejected", () => {
    const verdict = validateHooksDocument({
      description: "some plugin",
      "oma-strict-write-gate": {
        enabled: true,
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: GOOD_COMMAND, timeout: 10 }] },
        ],
      },
    });
    assert.equal(verdict.valid, false);
    assert.equal(verdict.problems[0].path, "description");
    assert.match(verdict.problems[0].message, /scalar|typeof/);
  });

  test("a handler without a command is rejected", () => {
    const verdict = validateHooksDocument({
      "oma-strict-write-gate": {
        enabled: true,
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "   " }] }],
      },
    });
    assert.equal(verdict.valid, false);
    assert.match(verdict.problems[0].message, /non-empty 'command'/);
  });

  test("a UTF-8 BOM makes the file unreadable to the runtime decoder", () => {
    const root = mkdtempSync(join(tmpdir(), "oma-hook-contract-"));
    try {
      const path = join(root, "hooks.json");
      const body = JSON.stringify(
        buildOmaHooks({ writeGateCommand: GOOD_COMMAND, memoryCommand: GOOD_COMMAND }),
      );
      writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")]));

      const verdict = validateHooksFile(path);
      assert.equal(verdict.valid, false);
      assert.match(verdict.problems[0].message, /BOM/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("objectivity: only events with recorded parse acceptance are emittable", () => {
    for (const entry of HOOK_EVENT_EVIDENCE) {
      if (entry.parseAccepted) {
        assert.ok(EMITTABLE_HOOK_EVENTS.includes(entry.event));
      } else {
        assert.equal(
          EMITTABLE_HOOK_EVENTS.includes(entry.event),
          false,
          `${entry.event} has no recorded acceptance and must not be emittable`,
        );
      }
      assert.ok(entry.note.length > 0, `${entry.event} must document its evidence`);
    }
  });
});
