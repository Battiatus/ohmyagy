import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { describeWorkspace } from "../doctor.js";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "oma-workspace-report-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function markAsEditorInstall(dir: string): void {
  mkdirSync(join(dir, "resources", "app"), { recursive: true });
  writeFileSync(join(dir, "Antigravity.exe"), "", "utf8");
}

function withEnv(value: string | undefined, run: () => void): void {
  const previous = process.env.OMA_WORKSPACE_ROOT;
  if (value === undefined) {
    delete process.env.OMA_WORKSPACE_ROOT;
  } else {
    process.env.OMA_WORKSPACE_ROOT = value;
  }
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.OMA_WORKSPACE_ROOT;
    } else {
      process.env.OMA_WORKSPACE_ROOT = previous;
    }
  }
}

test("an install tree is reported as such however it was chosen, with the reason", () => {
  withTempDir((dir) => {
    markAsEditorInstall(dir);
    withEnv(dir, () => {
      const report = describeWorkspace(dir);
      assert.equal(report.source, "OMA_WORKSPACE_ROOT");
      // The editor install tree is never a valid workspace, so pinning it does not
      // make it one. `source` is what explains how it happened.
      assert.equal(report.governsEditorInstall, true);
      assert.deepEqual(report.installTreeMarkers.sort(), ["Antigravity.exe", join("resources", "app")].sort());
    });
  });
});

test("an explicit argument that is not the cwd is reported as an argument", () => {
  withTempDir((dir) => {
    markAsEditorInstall(dir);
    withEnv(undefined, () => {
      const report = describeWorkspace(dir);
      assert.equal(report.source, "argument");
    });
  });
});

test("falling back to cwd inside an editor install tree is flagged, not warned", () => {
  withTempDir((dir) => {
    markAsEditorInstall(dir);
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      withEnv(undefined, () => {
        const report = describeWorkspace();
        assert.equal(report.source, "process.cwd");
        assert.equal(report.governsEditorInstall, true);
      });
    } finally {
      process.chdir(previousCwd);
    }
  });
});

test("an unmarked cwd is not flagged merely for lacking project markers", () => {
  // A real workspace may carry no marker at all: the Symap workspace is an
  // aggregate of two repositories with no .git, no package.json and no
  // AGENTS.md at its root. Only an install signature proves the wrong target.
  withTempDir((dir) => {
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      withEnv(undefined, () => {
        const report = describeWorkspace();
        assert.deepEqual(report.installTreeMarkers, []);
        assert.equal(report.governsEditorInstall, false);
      });
    } finally {
      process.chdir(previousCwd);
    }
  });
});
