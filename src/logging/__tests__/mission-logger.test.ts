import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MissionLogger } from "../mission-logger.js";
import { runOmaCli } from "../../cli/oma-cli.js";
import { MissionEventsStore } from "../../ledger/mission-events.js";

describe("MissionLogger & Inspection Observability", () => {
  test("creates mission log, run log, diff patch, and gate logs", () => {
    const tempDir = join(tmpdir(), `oma-obs-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const logger = new MissionLogger(tempDir, { verbose: false });

      // 1. Mission log
      logger.log("Planner", "Formulating plan", "INFO");
      logger.log("Gate", "Evaluating gate", "WARN");
      logger.log("Broker", "Promoting changes", "SUCCESS");

      const missionLog = join(tempDir, "mission.log");
      expect(existsSync(missionLog)).toBe(true);
      const missionLogContent = readFileSync(missionLog, "utf8");
      expect(missionLogContent).toContain("[OMA:Planner] Formulating plan");
      expect(missionLogContent).toContain("[OMA:Gate] Evaluating gate");
      expect(missionLogContent).toContain("[OMA:Broker] Promoting changes");

      // 2. Run logger
      const runLogger = logger.createRunLogger({
        runId: "run-worker-1",
        expertId: "worker",
        persona: "worker",
        model: "gemini-3.7-flash",
        prompt: "Write a math module",
      });
      runLogger.handleStdoutChunk("Chunk 1: starting edit...\n");
      runLogger.handleStdoutChunk("Chunk 2: completed edit.\n");
      runLogger.finalize({
        exitCode: 0,
        status: "success",
        durationMs: 120,
        parsedOutput: { ok: true },
      });

      const runLogPath = join(tempDir, "runs", "run-worker-1.log");
      expect(existsSync(runLogPath)).toBe(true);
      const runLogContent = readFileSync(runLogPath, "utf8");
      expect(runLogContent).toContain("OMA RUN LOG: run-worker-1");
      expect(runLogContent).toContain("Write a math module");
      expect(runLogContent).toContain("Chunk 1: starting edit...");
      expect(runLogContent).toContain("Chunk 2: completed edit.");
      expect(runLogContent).toContain("FINISHED: status=success exitCode=0 duration=120ms");

      // 3. Diff saving
      const sampleDiff = "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new";
      const savedDiffPath = logger.saveDiff("worker-1", sampleDiff);
      expect(existsSync(savedDiffPath)).toBe(true);
      expect(readFileSync(savedDiffPath, "utf8")).toBe(sampleDiff);

      // 4. Gate log
      logger.logGateResult("unit-tests", "failed", ["Test failed at line 42"], "FAIL: math.test.ts");
      const gateLogPath = join(tempDir, "gate-logs", "unit-tests.log");
      expect(existsSync(gateLogPath)).toBe(true);
      const gateLogContent = readFileSync(gateLogPath, "utf8");
      expect(gateLogContent).toContain("Gate: unit-tests");
      expect(gateLogContent).toContain("Status: FAILED");
      expect(gateLogContent).toContain("Test failed at line 42");
      expect(gateLogContent).toContain("FAIL: math.test.ts");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("oma inspect flags (--diff, --runs, --log, --gates) function properly", async () => {
    const tempDir = join(tmpdir(), `oma-inspect-test-${Date.now()}`);
    const missionId = "test-mission-inspect";
    const missionDir = join(tempDir, ".oma", "missions", missionId);
    mkdirSync(join(missionDir, "diffs"), { recursive: true });
    mkdirSync(join(missionDir, "runs"), { recursive: true });
    mkdirSync(join(missionDir, "gate-logs"), { recursive: true });

    try {
      // Setup mock mission data
      const eventsPath = join(missionDir, "events.jsonl");
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "mission_started",
        workflowDigest: "wf-1",
        rulebookRevision: "rb-1",
        goal: "Observability verification mission",
        totalBudgets: { maxRounds: 1, maxTimeMs: 1000 },
      });

      const sampleDiff = "diff --git a/index.ts b/index.ts\n+console.log('hello');";
      const logger = new MissionLogger(missionDir);
      logger.saveDiff("worker-node-1", sampleDiff);

      const runLogger = logger.createRunLogger({
        runId: "run-worker-abc",
        expertId: "worker",
        persona: "worker",
      });
      runLogger.handleStdoutChunk("Executing node worker-node-1...\n");
      runLogger.finalize({ exitCode: 0, status: "success", durationMs: 250 });

      logger.logGateResult("test-gate", "passed", []);

      // Intercept stdout
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...msgs: unknown[]) => logs.push(msgs.map(String).join(" "));

      try {
        // Test oma inspect (default summary)
        logs.length = 0;
        const codeSummary = await runOmaCli(["inspect", "--mission", missionId], tempDir);
        expect(codeSummary).toBe(0);
        expect(logs.some((l) => l.includes("OMA Mission Inspection: test-mission-inspect"))).toBe(true);
        expect(logs.some((l) => l.includes("Observability verification mission"))).toBe(true);
        expect(logs.some((l) => l.includes("worker-node-1.patch"))).toBe(true);

        // Test oma inspect --diff
        logs.length = 0;
        const codeDiff = await runOmaCli(["inspect", "--mission", missionId, "--diff"], tempDir);
        expect(codeDiff).toBe(0);
        expect(logs.some((l) => l.includes("Unified Diff: worker-node-1"))).toBe(true);
        expect(logs.some((l) => l.includes("+console.log('hello');"))).toBe(true);

        // Test oma inspect --runs
        logs.length = 0;
        const codeRuns = await runOmaCli(["inspect", "--mission", missionId, "--runs"], tempDir);
        expect(codeRuns).toBe(0);
        expect(logs.some((l) => l.includes("OMA Agent Runs for Mission"))).toBe(true);
        expect(logs.some((l) => l.includes("run-worker-abc.log"))).toBe(true);

        // Test oma inspect --log
        logs.length = 0;
        const codeLog = await runOmaCli(["inspect", "--mission", missionId, "--log", "run-worker-abc"], tempDir);
        expect(codeLog).toBe(0);
        expect(logs.some((l) => l.includes("OMA RUN LOG: run-worker-abc"))).toBe(true);
        expect(logs.some((l) => l.includes("Executing node worker-node-1..."))).toBe(true);

        // Test oma inspect --gates
        logs.length = 0;
        const codeGates = await runOmaCli(["inspect", "--mission", missionId, "--gates"], tempDir);
        expect(codeGates).toBe(0);
        expect(logs.some((l) => l.includes("OMA Gate Evaluations for Mission"))).toBe(true);
        expect(logs.some((l) => l.includes("Gate: test-gate"))).toBe(true);
      } finally {
        console.log = originalLog;
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
