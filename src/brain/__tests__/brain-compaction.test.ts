import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "bun:test";
import { BrainStore, BrainStoreError } from "../brain-store.js";
import { captureInteraction } from "../summarizer.js";
import { ingestMissionIntoBrain } from "../mission-ingest.js";
import type { SequencedMissionEvent } from "../../ledger/mission-events.js";

function removeTree(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
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

describe("Phase 7: BrainStore Compaction & Lifecycle (T7.1 & T7.2)", () => {
  let tempDir: string;
  let dbPath: string;
  let brain: BrainStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "oma-brain-compaction-"));
    dbPath = join(tempDir, "brain.sqlite");
    brain = new BrainStore(dbPath);
  });

  afterEach(() => {
    brain.close();
    removeTree(tempDir);
  });

  // =========================================================================
  // T7.1: BrainStore.compact() Unit Tests
  // =========================================================================

  describe("T7.1: BrainStore.compact core semantics", () => {
    it("returns zero counts for an empty database", () => {
      const result = brain.compact();
      assert.equal(result.status, "compacted");
      assert.equal(result.entriesDeduplicated, 0);
      assert.equal(result.runSummariesPruned, 0);
      assert.equal(result.interactionsPruned, 0);
      assert.equal(result.interactionsCondensed, 0);
      assert.equal(result.totalEntriesBefore, 0);
      assert.equal(result.totalEntriesAfter, 0);
      assert.equal(result.totalInteractionsBefore, 0);
      assert.equal(result.totalInteractionsAfter, 0);
    });

    it("throws NOT_FOUND when compacting with a non-existent projectId", () => {
      assert.throws(
        () => brain.compact({ projectId: "non-existent-proj" }),
        (err) => err instanceof BrainStoreError && err.code === "NOT_FOUND",
      );
    });

    it("deduplicates identical memory entries and keeps freshest / highest confidence", () => {
      const proj = brain.ensureProject({ name: "dedup-test", rootPath: "/test/dedup" });

      // Storing duplicate entries with exact matching dimension, title, and content
      const e1 = brain.storeMemory({
        projectId: proj.id,
        dimension: "run_summary",
        title: "Wave 1 summary",
        content: "Execution of Wave 1 completed successfully",
        confidence: 0.8,
      });

      const e2 = brain.storeMemory({
        projectId: proj.id,
        dimension: "run_summary",
        title: "Wave 1 summary",
        content: "Execution of Wave 1 completed successfully",
        confidence: 0.95,
      });

      const before = brain.queryMemory({ projectId: proj.id, dimensions: ["run_summary"] });
      assert.equal(before.length, 2);

      const result = brain.compact({ projectId: proj.id });
      assert.equal(result.entriesDeduplicated, 1);

      const after = brain.queryMemory({ projectId: proj.id, dimensions: ["run_summary"] });
      assert.equal(after.length, 1);
      // Confirms the higher-confidence entry e2 was retained
      assert.equal(after[0].id, e2.id);
      assert.equal(after[0].confidence, 0.95);
    });

    it("deduplicates identical content across same dimension and project", () => {
      const proj = brain.ensureProject({ name: "content-dedup", rootPath: "/test/content-dedup" });

      brain.storeMemory({
        projectId: proj.id,
        dimension: "past_error",
        title: "Timeout in step 1",
        content: "Command timed out after 30s",
        confidence: 0.8,
      });

      brain.storeMemory({
        projectId: proj.id,
        dimension: "past_error",
        title: "Timeout in step 1 duplicate",
        content: "Command timed out after 30s",
        confidence: 0.9,
      });

      const result = brain.compact({ projectId: proj.id });
      assert.equal(result.entriesDeduplicated, 1);

      const remaining = brain.queryMemory({ projectId: proj.id, dimensions: ["past_error"] });
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].confidence, 0.9);
    });

    it("prunes low-confidence run_summary entries while strictly preserving durable dimensions", () => {
      const proj = brain.ensureProject({ name: "confidence-test", rootPath: "/test/confidence" });

      // Low confidence run_summary (should be pruned)
      brain.storeMemory({
        projectId: proj.id,
        dimension: "run_summary",
        title: "Flaky speculative run",
        content: "Possible outcome",
        confidence: 0.2,
      });

      // High confidence run_summary (should be kept)
      brain.storeMemory({
        projectId: proj.id,
        dimension: "run_summary",
        title: "Verified wave 2",
        content: "Proven outcome",
        confidence: 0.85,
      });

      // Low confidence durable dimensions: architectural_decision and user_preference
      // (MUST BE STRICTLY PRESERVED!)
      brain.storeMemory({
        projectId: proj.id,
        dimension: "architectural_decision",
        title: "Preliminary DB Decision",
        content: "Evaluate embedded sqlite",
        confidence: 0.1, // very low confidence!
      });

      brain.storeMemory({
        projectId: proj.id,
        dimension: "user_preference",
        title: "Tentative editor theme",
        content: "User prefers dark mode",
        confidence: 0.1, // very low confidence!
      });

      brain.storeMemory({
        projectId: proj.id,
        dimension: "past_error",
        title: "Old compiler error",
        content: "TS2304 cannot find name",
        confidence: 0.1, // durable past error!
      });

      const result = brain.compact({
        projectId: proj.id,
        runSummaryMinConfidence: 0.5,
      });

      assert.equal(result.runSummariesPruned, 1);

      // Verify run_summary: only high-confidence remains
      const runSummaries = brain.queryMemory({ projectId: proj.id, dimensions: ["run_summary"] });
      assert.equal(runSummaries.length, 1);
      assert.equal(runSummaries[0].title, "Verified wave 2");

      // Verify durable dimensions were 100% strictly preserved
      const arch = brain.queryMemory({ projectId: proj.id, dimensions: ["architectural_decision"] });
      assert.equal(arch.length, 1);
      assert.equal(arch[0].title, "Preliminary DB Decision");

      const pref = brain.queryMemory({ projectId: proj.id, dimensions: ["user_preference"] });
      assert.equal(pref.length, 1);
      assert.equal(pref[0].title, "Tentative editor theme");

      const err = brain.queryMemory({ projectId: proj.id, dimensions: ["past_error"] });
      assert.equal(err.length, 1);
      assert.equal(err[0].title, "Old compiler error");
    });

    it("prunes excess run_summary entries according to maxRunSummaries limit", () => {
      const proj = brain.ensureProject({ name: "max-run-test", rootPath: "/test/max-run" });

      for (let i = 0; i < 10; i++) {
        brain.storeMemory({
          projectId: proj.id,
          dimension: "run_summary",
          title: `Run summary ${i}`,
          content: `Details for run ${i}`,
          confidence: 0.9,
        });
      }

      assert.equal(brain.queryMemory({ projectId: proj.id, dimensions: ["run_summary"] }).length, 10);

      const result = brain.compact({
        projectId: proj.id,
        maxRunSummaries: 3,
      });

      assert.equal(result.runSummariesPruned, 7);
      const remaining = brain.queryMemory({ projectId: proj.id, dimensions: ["run_summary"] });
      assert.equal(remaining.length, 3);
    });

    it("prunes older interaction_summaries beyond maxInteractionsPerSession limit", () => {
      const proj = brain.ensureProject({ name: "inter-prune", rootPath: "/test/inter-prune" });
      const session = brain.startSession({ projectId: proj.id, objective: "Test interaction pruning" });

      for (let r = 0; r < 8; r++) {
        brain.recordInteraction({
          sessionId: session.id,
          roundNumber: r,
          context: `Context for round ${r}`,
          actions: `Actions for round ${r}`,
          outcome: `Outcome ${r}`,
        });
      }

      assert.equal(brain.listInteractions(session.id).length, 8);

      const result = brain.compact({
        projectId: proj.id,
        maxInteractionsPerSession: 3,
        condenseInteractions: false,
      });

      assert.equal(result.interactionsPruned, 5);
      const remaining = brain.listInteractions(session.id);
      assert.equal(remaining.length, 3);
      // The 3 newest rounds (5, 6, 7) must be preserved
      assert.deepEqual(remaining.map((i) => i.roundNumber), [5, 6, 7]);
    });

    it("condenses older interaction_summaries when condenseInteractions is true", () => {
      const proj = brain.ensureProject({ name: "inter-condense", rootPath: "/test/inter-condense" });
      const session = brain.startSession({ projectId: proj.id, objective: "Test condensation" });

      for (let r = 0; r < 6; r++) {
        brain.recordInteraction({
          sessionId: session.id,
          roundNumber: r,
          context: `Goal for step ${r}`,
          actions: `Executed tool for step ${r}`,
          outcome: `Step ${r} passed`,
          nodeRef: `node-${r}`,
        });
      }

      assert.equal(brain.listInteractions(session.id).length, 6);

      // Keep 2 freshest, condense the oldest 4
      const result = brain.compact({
        projectId: proj.id,
        maxInteractionsPerSession: 2,
        condenseInteractions: true,
      });

      assert.equal(result.interactionsCondensed, 4);
      assert.equal(result.interactionsPruned, 0);

      const remaining = brain.listInteractions(session.id);
      // 1 consolidated rollup + 2 retained freshest = 3 total
      assert.equal(remaining.length, 3);

      const condensed = remaining[0];
      assert.ok(condensed.userIntent?.includes("[Condensed 4 rounds: 0..3]"));
      assert.ok(condensed.outcome?.includes("Condensed 4 interactions"));
      assert.ok(condensed.nodeRef?.includes("node-0"));

      // The 2 newest rounds remain intact
      assert.equal(remaining[1].roundNumber, 4);
      assert.equal(remaining[2].roundNumber, 5);
    });

    it("isolates compaction to the specified project", () => {
      const projA = brain.ensureProject({ name: "projA", rootPath: "/test/projA" });
      const projB = brain.ensureProject({ name: "projB", rootPath: "/test/projB" });

      // Proj A has duplicate
      brain.storeMemory({
        projectId: projA.id,
        dimension: "run_summary",
        title: "Common Title",
        content: "Common Content",
        confidence: 0.8,
      });
      brain.storeMemory({
        projectId: projA.id,
        dimension: "run_summary",
        title: "Common Title",
        content: "Common Content",
        confidence: 0.9,
      });

      // Proj B has duplicate
      brain.storeMemory({
        projectId: projB.id,
        dimension: "run_summary",
        title: "Common Title",
        content: "Common Content",
        confidence: 0.8,
      });
      brain.storeMemory({
        projectId: projB.id,
        dimension: "run_summary",
        title: "Common Title",
        content: "Common Content",
        confidence: 0.9,
      });

      // Compact only Proj A
      const res = brain.compact({ projectId: projA.id });
      assert.equal(res.entriesDeduplicated, 1);

      // Proj A deduplicated
      assert.equal(brain.queryMemory({ projectId: projA.id }).length, 1);
      // Proj B untouched
      assert.equal(brain.queryMemory({ projectId: projB.id }).length, 2);
    });
  });

  // =========================================================================
  // T7.2: Fail-Open Triggers & Bounded Database Size Tests
  // =========================================================================

  describe("T7.2: Fail-open automatic compaction triggers", () => {
    it("triggers automatic compaction every N rounds in summarizer fail-open", async () => {
      const proj = brain.ensureProject({ name: "summarizer-auto", rootPath: "/test/summarizer-auto" });
      const session = brain.startSession({ projectId: proj.id });

      // Seed duplicate run_summary
      brain.storeMemory({
        projectId: proj.id,
        dimension: "run_summary",
        title: "Pre-existing duplicate",
        content: "Dup content",
        confidence: 0.8,
      });
      brain.storeMemory({
        projectId: proj.id,
        dimension: "run_summary",
        title: "Pre-existing duplicate",
        content: "Dup content",
        confidence: 0.9,
      });

      const reformulator = async (text: string) => ({
        context: `Context for ${text}`,
        actions: `Actions for ${text}`,
        outcome: "ok",
      });

      // Capture 2 rounds with autoCompactInterval = 2
      const res1 = await captureInteraction({
        brain,
        projectId: proj.id,
        sessionId: session.id,
        projectName: "summarizer-auto",
        text: "Round 0 interaction",
        reformulate: reformulator,
        autoCompactInterval: 2,
      });
      assert.equal(res1.recorded, true);
      assert.equal(res1.compaction, undefined); // Round 0 + 1 = 1 (1 % 2 != 0)

      const res2 = await captureInteraction({
        brain,
        projectId: proj.id,
        sessionId: session.id,
        projectName: "summarizer-auto",
        text: "Round 1 interaction",
        reformulate: reformulator,
        autoCompactInterval: 2,
      });
      assert.equal(res2.recorded, true);
      // Round 1 + 1 = 2 (2 % 2 == 0) -> auto-compaction triggered!
      assert.ok(res2.compaction !== undefined);
      assert.equal(res2.compaction.status, "compacted");
      assert.equal(res2.compaction.entriesDeduplicated, 1);
    });

    it("summarizer fails open and records interaction even if compaction throws", async () => {
      const proj = brain.ensureProject({ name: "fail-open-test", rootPath: "/test/fail-open" });
      const session = brain.startSession({ projectId: proj.id });

      // Mock brain.compact to throw an unexpected error
      const originalCompact = brain.compact.bind(brain);
      brain.compact = () => {
        throw new Error("Simulated SQLite lock error during compaction");
      };

      try {
        const res = await captureInteraction({
          brain,
          projectId: proj.id,
          sessionId: session.id,
          projectName: "fail-open-test",
          text: "Critical mission action",
          reformulate: async () => ({
            context: "User requested deployment",
            actions: "Deployed artifact",
            outcome: "succeeded",
          }),
          autoCompactInterval: 1, // trigger every round
        });

        // The interaction capture MUST succeed despite compaction failure!
        assert.equal(res.recorded, true);
        assert.equal(res.summarized, true);
        assert.ok(res.interactionId);

        const interactions = brain.listInteractions(session.id);
        assert.equal(interactions.length, 1);
        assert.equal(interactions[0].userIntent, "User requested deployment");
      } finally {
        brain.compact = originalCompact;
      }
    });

    it("triggers automatic compaction in mission-ingest in fail-open mode", () => {
      const proj = brain.ensureProject({ name: "ingest-auto", rootPath: tempDir });
      const session = brain.startSession({ projectId: proj.id, objective: "Mission test-ingest-compact" });

      // Create a dummy event stream with multiple events
      const dummyEvents: SequencedMissionEvent[] = [
        {
          streamSeq: 1,
          eventId: "evt-1",
          missionId: "test-ingest-compact",
          missionClass: "code-change",
          eventType: "work_item_started",
          nodeRef: "task-1",
          roundNumber: 0,
          timestamp: Date.now(),
          payload: { expertId: "executor" },
          merkleRoot: "0000",
        },
        {
          streamSeq: 2,
          eventId: "evt-2",
          missionId: "test-ingest-compact",
          missionClass: "code-change",
          eventType: "gate_completed",
          nodeRef: "task-1",
          roundNumber: 0,
          timestamp: Date.now(),
          payload: { gateName: "test", status: "passed" },
          merkleRoot: "0000",
        },
      ];

      // Ingest with autoCompact enabled (default)
      const res = ingestMissionIntoBrain({
        brain,
        missionId: "test-ingest-compact",
        workspaceRoot: tempDir,
        projectId: proj.id,
        sessionId: session.id,
        events: dummyEvents,
        autoCompact: true,
      });

      assert.equal(res.status, "ingested");
      assert.ok(res.compaction !== undefined);
      assert.equal(res.compaction.status, "compacted");
    });
  });

  describe("T7.2: Bounded database size under heavy repeated load", () => {
    it("keeps row counts and database footprint strictly bounded under heavy repeated load", () => {
      const proj = brain.ensureProject({
        name: "heavy-load-proj",
        rootPath: "/test/heavy-load",
      });
      const session = brain.startSession({
        projectId: proj.id,
        objective: "Stress test memory compaction",
      });

      // Store a durable architectural decision and user preference upfront
      brain.storeMemory({
        projectId: proj.id,
        dimension: "architectural_decision",
        title: "Monolithic Brain Design",
        content: "Persist durable dimensions across all compaction waves.",
        confidence: 1.0,
      });
      brain.storeMemory({
        projectId: proj.id,
        dimension: "user_preference",
        title: "Concise Output",
        content: "Always keep reports high-density and free of filler.",
        confidence: 1.0,
      });

      const maxInteractions = 20;
      const maxRunSummaries = 15;
      const totalRounds = 120;

      // Simulate 120 rounds of execution, periodically compacting
      for (let r = 0; r < totalRounds; r++) {
        // 1. Record an interaction
        brain.recordInteraction({
          sessionId: session.id,
          roundNumber: r,
          context: `Context for step ${r} in heavy load loop`,
          actions: `Ran build and unit checks round ${r}`,
          outcome: `Round ${r} passed`,
          nodeRef: `node-${r % 5}`,
        });

        // 2. Store run summaries (every 2 rounds, store some with duplicates or low confidence)
        if (r % 2 === 0) {
          brain.storeMemory({
            projectId: proj.id,
            dimension: "run_summary",
            title: `Run summary batch ${r}`,
            content: `Execution details for batch ${r}`,
            confidence: r % 4 === 0 ? 0.3 : 0.9, // some low-confidence
          });
          // Duplicate entry
          brain.storeMemory({
            projectId: proj.id,
            dimension: "run_summary",
            title: `Run summary batch ${r}`,
            content: `Execution details for batch ${r}`,
            confidence: 0.9,
          });
        }

        // 3. Compact every 10 rounds
        if ((r + 1) % 10 === 0) {
          brain.compact({
            projectId: proj.id,
            maxInteractionsPerSession: maxInteractions,
            maxRunSummaries: maxRunSummaries,
            runSummaryMinConfidence: 0.5,
            deduplicationMode: "redundant",
          });
        }
      }

      // Final compaction
      const finalCompaction = brain.compact({
        projectId: proj.id,
        maxInteractionsPerSession: maxInteractions,
        maxRunSummaries: maxRunSummaries,
        runSummaryMinConfidence: 0.5,
        deduplicationMode: "redundant",
      });

      assert.equal(finalCompaction.status, "compacted");

      // Verify bound on interaction summaries: strictly <= maxInteractions
      const remainingInteractions = brain.listInteractions(session.id);
      assert.ok(
        remainingInteractions.length <= maxInteractions,
        `Expected <= ${maxInteractions} interactions, found ${remainingInteractions.length}`,
      );

      // Verify bound on run_summary entries: strictly <= maxRunSummaries
      const remainingRunSummaries = brain.queryMemory({
        projectId: proj.id,
        dimensions: ["run_summary"],
      });
      assert.ok(
        remainingRunSummaries.length <= maxRunSummaries,
        `Expected <= ${maxRunSummaries} run summaries, found ${remainingRunSummaries.length}`,
      );

      // Verify durable dimensions were NEVER lost
      const arch = brain.queryMemory({
        projectId: proj.id,
        dimensions: ["architectural_decision"],
      });
      assert.equal(arch.length, 1);
      assert.equal(arch[0].title, "Monolithic Brain Design");

      const pref = brain.queryMemory({
        projectId: proj.id,
        dimensions: ["user_preference"],
      });
      assert.equal(pref.length, 1);
      assert.equal(pref[0].title, "Concise Output");

      // Verify DB file size on disk is bounded (under 500KB for 120 rounds)
      const stats = statSync(dbPath);
      assert.ok(
        stats.size < 500 * 1024,
        `Database file size should remain bounded, but was ${stats.size} bytes`,
      );
    });
  });
});
