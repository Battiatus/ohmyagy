import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  bindConversation,
  readBindAttempts,
  readConversationBinding,
  readRegisteredWorkspaces,
  recordBindAttempt,
  registerWorkspace,
  sameWorkspacePath,
} from "../workspace-registry.js";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "oma-registry-"));
}

function safeRemove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold a short-lived lock.
  }
}

test("the registry upserts a workspace instead of accumulating duplicates", () => {
  const home = makeHome();
  try {
    registerWorkspace({ workspaceRoot: join(home, "project"), source: "roots/list", homeDirectory: home });
    registerWorkspace({ workspaceRoot: join(home, "project"), source: "OMA_WORKSPACE_ROOT", homeDirectory: home });
    const registered = readRegisteredWorkspaces(home);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].source, "OMA_WORKSPACE_ROOT");
  } finally {
    safeRemove(home);
  }
});

test("path comparison follows the platform's case rules", () => {
  const base = mkdtempSync(join(tmpdir(), "oma-Case-"));
  try {
    const lower = join(base, "Project").toLocaleLowerCase("en-US");
    if (process.platform === "win32") {
      assert.equal(sameWorkspacePath(lower, join(base, "Project")), true);
    } else {
      assert.equal(sameWorkspacePath(lower, join(base, "Project")), false);
    }
  } finally {
    safeRemove(base);
  }
});

test("a conversation binding is exact and never silently rewritten", () => {
  const home = makeHome();
  const first = join(home, "project-a");
  const second = join(home, "project-b");
  try {
    const binding = bindConversation({
      conversationId: "conv-1",
      workspaceRoot: first,
      source: "host-workspacePaths",
      homeDirectory: home,
    });
    assert.equal(binding.workspaceRoot, first);
    assert.equal(readConversationBinding("conv-1", home)?.source, "host-workspacePaths");

    // Same project: idempotent.
    const again = bindConversation({
      conversationId: "conv-1",
      workspaceRoot: first,
      source: "drain-evidence",
      homeDirectory: home,
    });
    assert.equal(again.source, "host-workspacePaths", "the first statement is kept");

    // Different project: a refusal, not a rewrite. Rebinding is how one project's
    // conversation would end up feeding another project's memory.
    assert.throws(
      () =>
        bindConversation({
          conversationId: "conv-1",
          workspaceRoot: second,
          source: "test",
          homeDirectory: home,
        }),
      /already bound/u,
    );
    assert.equal(readConversationBinding("conv-1", home)?.workspaceRoot, first);

    // An operator may override deliberately, and only deliberately.
    const forced = bindConversation({
      conversationId: "conv-1",
      workspaceRoot: second,
      source: "operator",
      homeDirectory: home,
      overwrite: true,
    });
    assert.equal(forced.workspaceRoot, second);
  } finally {
    safeRemove(home);
  }
});

test("an unreadable registry or binding degrades to no evidence", () => {
  const home = makeHome();
  try {
    assert.deepEqual(readRegisteredWorkspaces(home), []);
    assert.equal(readConversationBinding("conv-missing", home), undefined);
  } finally {
    safeRemove(home);
  }
});

test("bind attempts are recorded durably, newest first", () => {
  const home = makeHome();
  try {
    assert.deepEqual(readBindAttempts({ homeDirectory: home }), []);

    recordBindAttempt({
      root: "C:/project",
      outcome: "roots/list",
      cwd: "C:/editor",
      homeDirectory: home,
      at: "2026-09-14T10:00:00.000Z",
    });
    recordBindAttempt({
      root: null,
      outcome: "unresolved",
      cwd: "C:/editor",
      detail: "roots/list returned no root",
      homeDirectory: home,
      at: "2026-09-14T10:01:00.000Z",
    });
    recordBindAttempt({
      root: "C:/editor",
      outcome: "refused-install-tree",
      cwd: "C:/editor",
      homeDirectory: home,
      at: "2026-09-14T10:02:00.000Z",
    });

    const attempts = readBindAttempts({ homeDirectory: home });
    assert.equal(attempts.length, 3);
    assert.equal(attempts[0].outcome, "refused-install-tree", "newest first");
    assert.equal(attempts[2].outcome, "roots/list");
    assert.equal(attempts[1].detail, "roots/list returned no root");
    assert.equal(readBindAttempts({ homeDirectory: home, limit: 2 }).length, 2);
  } finally {
    safeRemove(home);
  }
});
