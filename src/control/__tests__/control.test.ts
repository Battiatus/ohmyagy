import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeCheck } from "../cli.js";
import { hashTrackedPaths } from "../canonical.js";
import { deriveSnapshot, nextRunnableTask } from "../status.js";
import {
  appendCheckEvidence,
  loadControl,
  verifyLedger,
} from "../store.js";

interface Fixture {
  root: string;
  cleanup: () => void;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "oma-control-"));
  const controlDir = join(root, ".oma", "control");
  mkdirSync(controlDir, { recursive: true });
  writeFileSync(join(root, "source.txt"), "initial\n", "utf8");
  writeFileSync(
    join(controlDir, "mission.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        missionId: "fixture",
        status: "ready",
        executionGate: "allowed",
        problem: "Need durable state",
        goal: "Prove durable state",
        scope: ["source.txt"],
        nonGoals: [],
        acceptanceCriteria: [{ id: "AC-1", description: "Checks pass" }],
        dependencies: [],
        targetEnvironment: "test",
        maxIterationRounds: 2,
        authorizedBy: "test",
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(controlDir, "task-graph.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        missionId: "fixture",
        tasks: [
          {
            id: "A",
            title: "First",
            dependencies: [],
            scope: ["source.txt"],
            acceptanceChecks: [
              {
                id: "check",
                program: "node",
                args: ["--version"],
                cwd: ".",
                trackedPaths: ["source.txt"],
              },
            ],
          },
          {
            id: "B",
            title: "Second",
            dependencies: ["A"],
            scope: ["source.txt"],
            acceptanceChecks: [],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(join(controlDir, "ledger.jsonl"), "", "utf8");
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function recordPassingCheck(root: string): void {
  const control = loadControl(root);
  const check = control.graph.tasks[0].acceptanceChecks[0];
  const inputHash = hashTrackedPaths(root, check.trackedPaths);
  appendCheckEvidence(control, {
    taskId: "A",
    check,
    inputHashBefore: inputHash,
    inputHashAfter: inputHash,
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
  });
}

test("derives task acceptance from fresh command evidence", () => {
  const fixture = createFixture();
  try {
    recordPassingCheck(fixture.root);
    const snapshot = deriveSnapshot(loadControl(fixture.root));
    assert.equal(snapshot.ledgerValid, true);
    assert.equal(snapshot.tasks[0].status, "accepted");
    assert.equal(snapshot.tasks[1].status, "ready");
    assert.equal(nextRunnableTask(snapshot)?.id, "B");
  } finally {
    fixture.cleanup();
  }
});

test("detects ledger tampering", () => {
  const fixture = createFixture();
  try {
    recordPassingCheck(fixture.root);
    const ledgerPath = join(fixture.root, ".oma", "control", "ledger.jsonl");
    const original = readFileSync(ledgerPath, "utf8");
    writeFileSync(ledgerPath, original.replace('"exitCode":0', '"exitCode":1'), "utf8");
    const verification = verifyLedger(loadControl(fixture.root));
    assert.equal(verification.valid, false);
    assert.match(verification.errors.join("\n"), /hash mismatch/iu);
  } finally {
    fixture.cleanup();
  }
});

test("marks evidence stale when tracked inputs change", () => {
  const fixture = createFixture();
  try {
    recordPassingCheck(fixture.root);
    writeFileSync(join(fixture.root, "source.txt"), "changed\n", "utf8");
    const snapshot = deriveSnapshot(loadControl(fixture.root));
    assert.equal(snapshot.tasks[0].status, "needs_work");
    assert.equal(snapshot.tasks[0].checks[0].status, "stale");
    assert.equal(snapshot.tasks[1].status, "blocked");
  } finally {
    fixture.cleanup();
  }
});

test("rejects cyclic task graphs during bootstrap", () => {
  const fixture = createFixture();
  try {
    const graphPath = join(fixture.root, ".oma", "control", "task-graph.json");
    const graph = JSON.parse(readFileSync(graphPath, "utf8")) as {
      tasks: Array<{ id: string; dependencies: string[] }>;
    };
    graph.tasks[0].dependencies = ["B"];
    writeFileSync(graphPath, JSON.stringify(graph, null, 2), "utf8");
    assert.throws(() => loadControl(fixture.root), /cycle/iu);
  } finally {
    fixture.cleanup();
  }
});

test("executes npm without spawning a Windows cmd shim", () => {
  const fixture = createFixture();
  try {
    const result = executeCheck(fixture.root, {
      id: "npm-version",
      program: "npm",
      args: ["--version"],
      cwd: ".",
      trackedPaths: [],
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^\d+\.\d+/u);
  } finally {
    fixture.cleanup();
  }
});
