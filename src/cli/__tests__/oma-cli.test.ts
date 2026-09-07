import { describe, it, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOmaCli } from "../oma-cli.js";
import { MissionEventsStore } from "../../ledger/mission-events.js";

describe("OMA CLI Comprehensive Test Suite", () => {
  let testWorkspace: string;

  beforeAll(() => {
    testWorkspace = mkdtempSync(join(tmpdir(), "oma-cli-test-"));
  });

  afterAll(() => {
    try {
      rmSync(testWorkspace, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("handles help flags gracefully", async () => {
    assert.equal(await runOmaCli([], testWorkspace), 0);
    assert.equal(await runOmaCli(["--help"], testWorkspace), 0);
    assert.equal(await runOmaCli(["-h"], testWorkspace), 0);
    assert.equal(await runOmaCli(["help"], testWorkspace), 0);
  });

  it("executes doctor command and outputs environmental diagnostics", async () => {
    const code = await runOmaCli(["doctor"], testWorkspace);
    assert.equal(code, 0);
  });

  it("installs plugin into workspace and tests --force idempotency", async () => {
    // 1. First installation should succeed
    const code1 = await runOmaCli(["plugin", "install-workspace"], testWorkspace);
    assert.equal(code1, 0);
    const pluginDir = join(testWorkspace, ".agents", "plugins", "oma");
    assert.ok(existsSync(pluginDir));
    assert.ok(existsSync(join(pluginDir, "plugin.json")));
    assert.ok(existsSync(join(pluginDir, "skills", "oma-start", "SKILL.md")));
    assert.ok(existsSync(join(pluginDir, "skills", "oma-watch", "SKILL.md")));

    // 2. Second installation without --force should fail cleanly with code 1
    const code2 = await runOmaCli(["plugin", "install-workspace"], testWorkspace);
    assert.equal(code2, 1);

    // 3. Third installation with --force should succeed idempotently
    const code3 = await runOmaCli(["plugin", "install-workspace", "--force"], testWorkspace);
    assert.equal(code3, 0);

    // 4. Fourth installation with -f should also succeed
    const code4 = await runOmaCli(["plugin", "install-workspace", "-f"], testWorkspace);
    assert.equal(code4, 0);
  });

  it("returns error code 1 on status and inspect when no mission exists", async () => {
    const emptyWorkspace = mkdtempSync(join(tmpdir(), "oma-cli-empty-"));
    try {
      assert.equal(await runOmaCli(["status"], emptyWorkspace), 1);
      assert.equal(await runOmaCli(["status", "--json"], emptyWorkspace), 1);
      assert.equal(await runOmaCli(["inspect"], emptyWorkspace), 1);
      assert.equal(await runOmaCli(["inspect", "--json"], emptyWorkspace), 1);
      assert.equal(await runOmaCli(["resume"], emptyWorkspace), 1);
    } finally {
      rmSync(emptyWorkspace, { recursive: true, force: true });
    }
  });

  it("recognizes the start and watch user entry points", async () => {
    assert.equal(await runOmaCli(["start"], testWorkspace), 1);

    const missionId = `watch-${Date.now()}`;
    const eventsPath = join(testWorkspace, ".oma", "missions", missionId, "events.jsonl");
    MissionEventsStore.appendEvent(eventsPath, missionId, {
      type: "mission_started",
      workflowDigest: "watch-test",
      rulebookRevision: "watch-test",
      goal: "Observe a mission without executing one.",
    });
    MissionEventsStore.appendEvent(eventsPath, missionId, {
      type: "run_started",
      runId: `run-planner-${missionId}`,
      workItemId: "planner",
      expertId: "planner",
      model: "default",
      effort: "agy-default",
    });

    let output = "";
    const originalLog = console.log;
    console.log = (value: string) => {
      output += `${value}\n`;
    };
    try {
      assert.equal(await runOmaCli(["watch", "--mission", missionId, "--once"], testWorkspace), 0);
    } finally {
      console.log = originalLog;
    }
    assert.match(output, new RegExp(`OMA Mission Status: ${missionId}`));
    assert.match(output, /Phase: PLANNING/u);
    assert.match(output, /Active Runs: \[planner:planner\]/u);
    assert.match(output, /Progress: plan pending, 1 active run\(s\)/u);

    assert.equal(await runOmaCli(["watch", `--${missionId}`, "--once"], testWorkspace), 1);
    assert.equal(await runOmaCli(["watch", "--mission=", "--once"], testWorkspace), 1);

    MissionEventsStore.appendEvent(eventsPath, missionId, {
      type: "mission_finished",
      finalStatus: "succeeded",
      totalDurationMs: 1,
      finalProgress: {
        hiddenTestsFailing: 0,
        hiddenTestsPassed: 0,
        visibleTestsFailing: 0,
        visibleTestsPassed: 0,
        gateFailures: 0,
        openDiagnosticsCount: 0,
        acceptedWorkItems: 0,
        totalWorkItems: 0,
      },
    });
    assert.equal(await runOmaCli(["watch", "--once"], testWorkspace), 1);
  });

  it("refuses a synthetic mission lifecycle without a gate manifest and a verified runtime", async () => {
    const missionId = `cli-e2e-${Date.now()}`;

    const runCode = await runOmaCli(["run", missionId], testWorkspace);
    assert.equal(runCode, 1);
    assert.equal(existsSync(join(testWorkspace, ".oma", "missions", missionId, "events.jsonl")), false);
    assert.equal(await runOmaCli(["resume", "--mission", missionId], testWorkspace), 1);
  });

  it("refuses a benchmark without an explicit pinned manifest", async () => {
    const code = await runOmaCli(["benchmark", "--trials", "1"], testWorkspace);
    assert.equal(code, 1);
    assert.equal(existsSync(join(testWorkspace, ".oma", "benchmark", "causal_benchmark_report.md")), false);
  });

  it("returns error code 1 for unknown command", async () => {
    const code = await runOmaCli(["invalid-command-xyz"], testWorkspace);
    assert.equal(code, 1);
  });
});
