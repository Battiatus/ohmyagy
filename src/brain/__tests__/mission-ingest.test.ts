import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "bun:test";
import { BrainStore } from "../brain-store.js";
import { ingestMissionIntoBrain } from "../mission-ingest.js";
import type { SequencedMissionEvent } from "../../ledger/mission-events.js";

let root: string;
let brain: BrainStore;

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
  root = mkdtempSync(join(tmpdir(), "oma-mission-ingest-"));
  brain = new BrainStore(join(root, "brain.sqlite"));
});

afterEach(() => {
  brain.close();
  removeTree(root);
});

function createSampleEvents(missionId: string): SequencedMissionEvent[] {
  return [
    {
      seq: 1,
      type: "mission_started",
      timestamp: new Date().toISOString(),
      missionId,
      previousEventHash: "000000",
      eventHash: "hash-1",
      workflowDigest: "test-digest",
      rulebookRevision: "v1",
      goal: "Implement auth system",
    },
    {
      seq: 2,
      type: "work_item_discovered",
      timestamp: new Date().toISOString(),
      missionId,
      previousEventHash: "hash-1",
      eventHash: "hash-2",
      workItemId: "work-auth-api",
      title: "Auth REST API",
      scope: ["src/auth.ts"],
      dependsOn: [],
      roleRequired: "executor",
      acceptanceCriteria: ["endpoints return 200"],
    },
    {
      seq: 3,
      type: "run_started",
      timestamp: new Date().toISOString(),
      missionId,
      previousEventHash: "hash-2",
      eventHash: "hash-3",
      runId: "run-auth-1",
      workItemId: "work-auth-api",
      expertId: "executor",
      model: "test-model",
      effort: "low",
    },
    {
      seq: 4,
      type: "run_finished",
      timestamp: new Date().toISOString(),
      missionId,
      previousEventHash: "hash-3",
      eventHash: "hash-4",
      runId: "run-auth-1",
      workItemId: "work-auth-api",
      expertId: "executor",
      status: "succeeded",
      durationMs: 1200,
    },
    {
      seq: 5,
      type: "review_attested",
      timestamp: new Date().toISOString(),
      missionId,
      previousEventHash: "hash-4",
      eventHash: "hash-5",
      runId: "run-auth-1",
      reviewerRunId: "run-rev-1",
      reviewerExpertId: "reviewer",
      workItemId: "work-auth-api",
      subjectDiffDigest: "diff-digest-1",
      verdict: "approved",
      observations: ["Looks clean and secure"],
    },
    {
      seq: 6,
      type: "gate_evaluated",
      timestamp: new Date().toISOString(),
      missionId,
      previousEventHash: "hash-5",
      eventHash: "hash-6",
      gateId: "test-gate",
      status: "passed",
      durationMs: 450,
      diagnostics: [],
      progressVector: {
        hiddenTestsFailing: 0,
        hiddenTestsPassed: 2,
        visibleTestsFailing: 0,
        visibleTestsPassed: 5,
        gateFailures: 0,
        openDiagnosticsCount: 0,
        acceptedWorkItems: 1,
        totalWorkItems: 1,
      },
    },
    {
      seq: 7,
      type: "integration_attempted",
      timestamp: new Date().toISOString(),
      missionId,
      previousEventHash: "hash-6",
      eventHash: "hash-7",
      waveIndex: 1,
      workItemsIntegrated: ["work-auth-api"],
      commitSha: "sha-auth-commit-1",
      status: "integrated",
    },
    {
      seq: 8,
      type: "mission_finished",
      timestamp: new Date().toISOString(),
      missionId,
      previousEventHash: "hash-7",
      eventHash: "hash-8",
      finalStatus: "succeeded",
      totalDurationMs: 2500,
      integratedCommitSha: "sha-auth-commit-1",
      finalProgress: {
        hiddenTestsFailing: 0,
        hiddenTestsPassed: 2,
        visibleTestsFailing: 0,
        visibleTestsPassed: 5,
        gateFailures: 0,
        openDiagnosticsCount: 0,
        acceptedWorkItems: 1,
        totalWorkItems: 1,
      },
    },
  ];
}

function createFailingEvents(missionId: string): SequencedMissionEvent[] {
  return [
    {
      seq: 1,
      type: "mission_started",
      timestamp: new Date().toISOString(),
      missionId,
      previousEventHash: "000000",
      eventHash: "fhash-1",
      workflowDigest: "test-digest",
      rulebookRevision: "v1",
      goal: "Implement flawed payment",
    },
    {
      seq: 2,
      type: "work_item_discovered",
      timestamp: new Date().toISOString(),
      missionId,
      previousEventHash: "fhash-1",
      eventHash: "fhash-2",
      workItemId: "work-payment",
      title: "Stripe payment integration",
      scope: ["src/pay.ts"],
      dependsOn: [],
      roleRequired: "executor",
      acceptanceCriteria: ["charge card"],
    },
    {
      seq: 3,
      type: "run_finished",
      timestamp: new Date().toISOString(),
      missionId,
      previousEventHash: "fhash-2",
      eventHash: "fhash-3",
      runId: "run-pay-fail-1",
      workItemId: "work-payment",
      expertId: "executor",
      status: "failed",
      durationMs: 800,
      error: "Syntax error in payment handler",
    },
    {
      seq: 4,
      type: "review_attested",
      timestamp: new Date().toISOString(),
      missionId,
      previousEventHash: "fhash-3",
      eventHash: "fhash-4",
      runId: "run-pay-fail-1",
      reviewerRunId: "run-rev-pay",
      reviewerExpertId: "reviewer",
      workItemId: "work-payment",
      subjectDiffDigest: "bad-diff",
      verdict: "rejected",
      observations: ["Unchecked null in customer ID"],
    },
    {
      seq: 5,
      type: "gate_evaluated",
      timestamp: new Date().toISOString(),
      missionId,
      previousEventHash: "fhash-4",
      eventHash: "fhash-5",
      gateId: "e2e-payment-gate",
      status: "failed",
      durationMs: 500,
      diagnostics: ["Mock server returned 500 on checkout"],
      progressVector: {
        hiddenTestsFailing: 1,
        hiddenTestsPassed: 0,
        visibleTestsFailing: 1,
        visibleTestsPassed: 0,
        gateFailures: 1,
        openDiagnosticsCount: 1,
        acceptedWorkItems: 0,
        totalWorkItems: 1,
      },
    },
  ];
}

test("ingests a successful mission creating run_summary memories and interactions tied to node_ref", () => {
  const missionId = "mission-success-1";
  const events = createSampleEvents(missionId);

  const result = ingestMissionIntoBrain({
    brain,
    missionId,
    workspaceRoot: root,
    events,
  });

  assert.equal(result.status, "ingested");
  assert.equal(result.missionId, missionId);
  assert.ok(result.runSummariesCreated >= 2); // work item + mission overview
  assert.equal(result.pastErrorsCreated, 0);
  assert.equal(result.interactionsRecorded, 1);

  // Verify memory queries by node_ref
  const nodeMemories = brain.queryMemory({
    projectId: result.projectId,
    query: "work-auth-api",
  });
  assert.ok(nodeMemories.length >= 1);
  assert.equal(nodeMemories[0].dimension, "run_summary");
  assert.match(nodeMemories[0].title, /work-auth-api/);
  assert.match(nodeMemories[0].content, /node: work-auth-api/);
  assert.ok(nodeMemories[0].tags.includes("work-auth-api"));
  assert.ok(nodeMemories[0].tags.includes("node:work-auth-api"));

  // Verify interaction summaries recorded with node_ref
  const nodeInteractions = brain.listInteractionsByNode("work-auth-api");
  assert.equal(nodeInteractions.length, 1);
  assert.equal(nodeInteractions[0].nodeRef, "work-auth-api");
  assert.match(String(nodeInteractions[0].userIntent), /work-auth-api/);
});

test("ingests a failed mission creating past_errors tied to node_ref", () => {
  const missionId = "mission-fail-1";
  const events = createFailingEvents(missionId);

  const result = ingestMissionIntoBrain({
    brain,
    missionId,
    workspaceRoot: root,
    events,
  });

  assert.equal(result.status, "ingested");
  assert.ok(result.pastErrorsCreated >= 3); // run_finished fail + review rejected + gate fail

  // Query past_errors for the failing node
  const errors = brain.queryMemory({
    projectId: result.projectId,
    dimensions: ["past_error"],
    query: "work-payment",
  });
  assert.ok(errors.length >= 2);
  assert.ok(errors.some((e) => e.title.includes("Run failure") && e.content.includes("Syntax error")));
  assert.ok(errors.some((e) => e.title.includes("Review rejected") && e.content.includes("Unchecked null")));

  // Query gate failure past_error
  const gateErrors = brain.queryMemory({
    projectId: result.projectId,
    dimensions: ["past_error"],
    query: "e2e-payment-gate",
  });
  assert.equal(gateErrors.length, 1);
  assert.match(gateErrors[0].content, /Mock server returned 500/);
});

test("is strictly idempotent: repeated calls produce identical brain state with no duplicates", () => {
  const missionId = "mission-idempotent";
  const events = createSampleEvents(missionId);

  // First run
  const res1 = ingestMissionIntoBrain({
    brain,
    missionId,
    workspaceRoot: root,
    events,
  });
  assert.equal(res1.status, "ingested");

  const count1 = brain.queryMemory({ projectId: res1.projectId }).length;
  const intCount1 = brain.listInteractions(res1.sessionId).length;

  // Second run with the same events
  const res2 = ingestMissionIntoBrain({
    brain,
    missionId,
    workspaceRoot: root,
    events,
  });
  assert.equal(res2.status, "ingested");

  const count2 = brain.queryMemory({ projectId: res2.projectId }).length;
  const intCount2 = brain.listInteractions(res2.sessionId).length;

  // Third run
  const res3 = ingestMissionIntoBrain({
    brain,
    missionId,
    workspaceRoot: root,
    events,
  });
  assert.equal(res3.status, "ingested");

  const count3 = brain.queryMemory({ projectId: res3.projectId }).length;
  const intCount3 = brain.listInteractions(res3.sessionId).length;

  // No duplicate entries allowed
  assert.equal(count1, count2);
  assert.equal(count2, count3);
  assert.equal(intCount1, intCount2);
  assert.equal(intCount2, intCount3);
});

test("fails open on non-existent events or invalid inputs without throwing", () => {
  // Empty missionId
  const resEmpty = ingestMissionIntoBrain({
    brain,
    missionId: "",
  });
  assert.equal(resEmpty.status, "failed");
  assert.ok(resEmpty.error);

  // Missing files / empty directory
  const resMissing = ingestMissionIntoBrain({
    brain,
    missionId: "ghost-mission-404",
    workspaceRoot: join(root, "non_existent_folder"),
  });
  assert.equal(resMissing.status, "skipped");
  assert.match(String(resMissing.error), /No events, projection, or graph found/);

  // Corrupted events file
  const missionDir = join(root, ".oma", "missions", "corrupted-mission");
  mkdirSync(missionDir, { recursive: true });
  writeFileSync(join(missionDir, "events.jsonl"), "not json at all\n{bad}", "utf8");

  const resCorrupted = ingestMissionIntoBrain({
    brain,
    missionId: "corrupted-mission",
    workspaceRoot: root,
  });
  assert.equal(resCorrupted.status, "skipped");
});

test("auto-creates an explicit unpersisted sessionId and respects explicit roundNumber", () => {
  const missionId = "mission-explicit-session";
  const events = createSampleEvents(missionId);
  const explicitSessionId = "custom-session-uuid-1234";

  // Verify session does not exist beforehand
  assert.equal(brain.getSession(explicitSessionId), undefined);

  const res = ingestMissionIntoBrain({
    brain,
    missionId,
    workspaceRoot: root,
    sessionId: explicitSessionId,
    events,
    roundNumber: 42,
  });

  assert.equal(res.status, "ingested");
  assert.equal(res.sessionId, explicitSessionId);

  // Session now exists in brain
  const session = brain.getSession(explicitSessionId);
  assert.ok(session);
  assert.equal(session.id, explicitSessionId);

  // Interactions have the explicit roundNumber
  const interactions = brain.listInteractions(explicitSessionId);
  assert.ok(interactions.length >= 1);
  assert.equal(interactions[0].roundNumber, 42);
  assert.equal(interactions[0].context, interactions[0].userIntent);
  assert.equal(interactions[0].actions, interactions[0].actionsTaken);
});
