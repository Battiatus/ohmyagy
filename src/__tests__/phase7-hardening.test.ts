import assert from "node:assert/strict";
import { describe, it, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { JournalCompactionEngine } from "../ledger/journal-compaction.js";
import { WorkspaceIsolationEngine } from "../runtime/workspace-isolation.js";
import { MissionEventsStore } from "../ledger/mission-events.js";

describe("Phase 7 — Durcissement après Preuve (Gate Observable)", () => {
  it("Gate 7.1: Journal compaction produces verifiable Merkle checkpoint and protects audit trail", () => {
    const testDir = join(process.cwd(), ".oma", "test-phase7-compaction");
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    try {
      const missionId = "mission-compact-001";
      const eventsPath = join(testDir, "events.jsonl");
      const checkpointPath = join(testDir, "checkpoint-1.json");

      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "mission_started",
        workflowDigest: "digest-v1",
        rulebookRevision: "rev-001",
        goal: "Compaction hardening test",
      });

      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "work_item_discovered",
        workItemId: "wi-1",
        title: "Task 1",
        scope: ["src/a.ts"],
        dependsOn: [],
        roleRequired: "worker",
        acceptanceCriteria: ["pass"],
      });

      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "mission_finished",
        finalStatus: "succeeded",
        totalDurationMs: 500,
        finalProgress: {
          hiddenTestsFailing: 0,
          hiddenTestsPassed: 5,
          visibleTestsFailing: 0,
          visibleTestsPassed: 3,
          gateFailures: 0,
          openDiagnosticsCount: 0,
          acceptedWorkItems: 1,
          totalWorkItems: 1,
        },
      });

      const checkpoint = JournalCompactionEngine.createCheckpoint(eventsPath, checkpointPath);

      assert.equal(checkpoint.missionId, missionId);
      assert.equal(checkpoint.totalEventsCompacted, 3);
      assert.ok(checkpoint.checkpointDigest.length === 64);
      assert.ok(checkpoint.cumulativeMerkleRoot.length === 64);

      // Verify integrity against raw events
      const rawEvents = MissionEventsStore.readEvents(eventsPath);
      const isIntegrityValid = JournalCompactionEngine.verifyCheckpoint(checkpoint, rawEvents);
      assert.equal(isIntegrityValid, true, "Checkpoint cryptographic verification must succeed");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("Gate 7.2: Multi-mission isolation prevents cross-mission collision and ensures clean worktree pruning", () => {
    const testDir = join(process.cwd(), ".oma", "test-phase7-isolation");
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    try {
      const pathsA = WorkspaceIsolationEngine.setupMissionIsolation(testDir, "mission-alpha");
      const pathsB = WorkspaceIsolationEngine.setupMissionIsolation(testDir, "mission-beta");

      // Write artifacts to both missions
      writeFileSync(join(pathsA.artifactsDir, "diff.patch"), "diff A", "utf8");
      writeFileSync(join(pathsB.artifactsDir, "diff.patch"), "diff B", "utf8");

      // Create dummy worktree directories
      const wtA = join(pathsA.worktreesDir, "task-1");
      const wtB = join(pathsB.worktreesDir, "task-1");
      mkdirSync(wtA, { recursive: true });
      mkdirSync(wtB, { recursive: true });
      writeFileSync(join(wtA, "temp.txt"), "temp A", "utf8");
      writeFileSync(join(wtB, "temp.txt"), "temp B", "utf8");

      // Clean worktrees for mission A only
      const cleanReport = WorkspaceIsolationEngine.cleanupMissionWorktrees(pathsA.worktreesDir);
      assert.equal(cleanReport.cleanedCount, 1);

      // Worktree A is gone, but artifact A and mission B worktrees remain intact
      assert.ok(!existsSync(wtA), "Worktree A must be pruned");
      assert.ok(existsSync(join(pathsA.artifactsDir, "diff.patch")), "Artifact A must be preserved");
      assert.ok(existsSync(wtB), "Mission B worktree must remain untouched");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
