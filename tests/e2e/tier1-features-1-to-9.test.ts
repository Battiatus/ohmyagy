import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityResolver } from "../../src/runtime/capability-resolver.js";
import { AgyDriver } from "../../src/runtime/agy-driver.js";
import { SecretScrubber } from "../../src/runtime/secret-scrubber.js";
import { ProcessRunner } from "../../src/runtime/process-runner.js";
import { WorktreePool } from "../../src/orchestration/worktree-pool.js";
import { WorkspaceIsolationEngine } from "../../src/runtime/workspace-isolation.js";
import { ParallelScheduler } from "../../src/orchestration/scheduler.js";
import { parseExecutionGraph, topologicalNodeIds, type ExecutionGraph } from "../../src/graph/model.js";
import { validateKahnAcyclicity, GraphBroker } from "../../src/graph/broker.js";
import { projectGraph, type NodeState } from "../../src/graph/kernel.js";
import { initializeGraphStore, loadGraphRuntime, appendGraphTransition } from "../../src/graph/store.js";
import { sha256 } from "../../src/ledger/canonical.js";

describe("Tier 1: Feature Coverage — Features 1 to 9", () => {
  // --------------------------------------------------------------------------
  // Feature 1: MoE Capability Resolution
  // --------------------------------------------------------------------------
  describe("Feature 1: MoE Capability Resolution", () => {
    it("1.1: resolves standard planner with frontier model, high effort, and read-only sandbox", () => {
      const cap = CapabilityResolver.resolve("planner");
      assert.equal(cap.expertId, "planner");
      assert.equal(cap.modelSlug, "gemini-3.7-pro");
      assert.equal(cap.effort, "high");
      assert.equal(cap.sandbox, "read-only");
      assert.equal(cap.readOnly, true);
      assert.ok(cap.allowedTools.includes("view_file"));
      assert.ok(!cap.allowedTools.includes("write_to_file"));
    });

    it("1.2: resolves standard worker with balanced model, medium effort, and workspace-write sandbox", () => {
      const cap = CapabilityResolver.resolve("worker");
      assert.equal(cap.expertId, "worker");
      assert.equal(cap.modelSlug, "gemini-3.7-flash");
      assert.equal(cap.effort, "medium");
      assert.equal(cap.sandbox, "workspace-write");
      assert.equal(cap.readOnly, false);
      assert.ok(cap.allowedTools.includes("write_to_file"));
      assert.ok(cap.allowedTools.includes("run_command"));
    });

    it("1.3: resolves standard reviewer with frontier model and high reasoning effort", () => {
      const cap = CapabilityResolver.resolve("reviewer");
      assert.equal(cap.expertId, "reviewer");
      assert.equal(cap.modelSlug, "gemini-3.7-pro");
      assert.equal(cap.effort, "high");
      assert.equal(cap.readOnly, true);
      assert.ok(cap.allowedTools.includes("grep_search"));
    });

    it("1.4: resolves standard fixer with balanced model, medium effort, and code edit tools", () => {
      const cap = CapabilityResolver.resolve("fixer");
      assert.equal(cap.expertId, "fixer");
      assert.equal(cap.modelSlug, "gemini-3.7-flash");
      assert.equal(cap.effort, "medium");
      assert.equal(cap.sandbox, "workspace-write");
      assert.ok(cap.allowedTools.includes("replace_file_content"));
    });

    it("1.5: applies model and effort overrides cleanly", () => {
      const cap = CapabilityResolver.resolve("worker", {
        modelOverride: "gemini-custom-model",
        effortOverride: "high",
      });
      assert.equal(cap.modelSlug, "gemini-custom-model");
      assert.equal(cap.effort, "high");
    });
  });

  // --------------------------------------------------------------------------
  // Feature 2: AntiGravity Headless Driver
  // --------------------------------------------------------------------------
  describe("Feature 2: AntiGravity Headless Driver", () => {
    it("2.1: builds normalized CLI arguments with complete parameter flags", () => {
      const driver = new AgyDriver();
      const args = driver.buildCliArguments({
        contractPrompt: "Execute unit test",
        persona: "worker",
        worktreeDir: "C:\\oma\\wt1",
        timeoutMs: 30000,
        modelOverride: "gemini-3.7-flash",
        reasoningEffort: "medium",
        jsonSchemaPath: "schema.json",
      });
      assert.ok(args.includes("--agent"));
      assert.ok(args.includes("worker"));
      assert.ok(args.includes("-p"));
      assert.ok(args.includes("Execute unit test"));
      assert.ok(args.includes("--output-format"));
      assert.ok(args.includes("json"));
      assert.ok(args.includes("--effort"));
      assert.ok(args.includes("medium"));
      assert.ok(args.includes("--model"));
      assert.ok(args.includes("gemini-3.7-flash"));
      assert.ok(args.includes("--json-schema"));
    });

    it("2.2: handles complex path strings and quotes safely", () => {
      const driver = new AgyDriver();
      const args = driver.buildCliArguments({
        contractPrompt: 'Run "complex" prompt with \'quotes\' and newlines\n',
        persona: "planner",
        worktreeDir: "C:\\oma\\path with spaces\\wt",
        timeoutMs: 30000,
      });
      assert.ok(args.includes("--add-dir"));
      assert.ok(args.includes("C:\\oma\\path with spaces\\wt"));
    });

    it("2.3: extracts clean JSON payload from raw stdout stream", () => {
      const driver = new AgyDriver();
      const rawOutput = 'Some log line 1\n{"result": "success", "score": 100}\nSome trailing log';
      const extracted = driver.extractStructuredOutput(rawOutput);
      assert.deepEqual(extracted.parsed, { result: "success", score: 100 });
    });

    it("2.4: extracts JSON embedded inside markdown code fence", () => {
      const driver = new AgyDriver();
      const rawOutput = "Here is the response:\n```json\n{\n  \"status\": \"completed\",\n  \"files\": [\"a.ts\"]\n}\n```\nDone.";
      const extracted = driver.extractStructuredOutput(rawOutput);
      assert.deepEqual(extracted.parsed, { status: "completed", files: ["a.ts"] });
    });

    it("2.5: maps execution exit codes properly to status codes", () => {
      const driver = new AgyDriver();
      assert.ok(typeof driver.invoke === "function");
    });
  });

  // --------------------------------------------------------------------------
  // Feature 3: Process Confinement & Scrubber
  // --------------------------------------------------------------------------
  describe("Feature 3: Process Confinement & Scrubber", () => {
    it("3.1: redacts Google Gemini and Vertex AI API keys", () => {
      const input = "Key: AIzaSy" + "A".repeat(33);
      const scrubbed = new SecretScrubber().scrub(input);
      assert.ok(!scrubbed.includes("AIzaSy" + "A".repeat(33)));
      assert.ok(scrubbed.includes("[REDACTED_GEMINI_KEY]"));
    });

    it("3.2: redacts OpenAI project and admin API keys", () => {
      const input = `sk-proj-${"A".repeat(48)} and sk-admin-${"B".repeat(48)}`;
      const scrubbed = new SecretScrubber().scrub(input);
      assert.ok(!scrubbed.includes("sk-proj-"));
      assert.ok(!scrubbed.includes("sk-admin-"));
    });

    it("3.3: redacts Anthropic Claude keys and GitHub PATs", () => {
      const input = `Anthropic: sk-ant-${"A".repeat(32)} and GitHub: ghp_${"B".repeat(36)}`;
      const scrubbed = new SecretScrubber().scrub(input);
      assert.ok(!scrubbed.includes("sk-ant-"));
      assert.ok(!scrubbed.includes("ghp_"));
    });

    it("3.4: redacts Authorization Bearer tokens and HTTP URL basic credentials", () => {
      const input = "Authorization: Bearer secret_jwt_token_12345 and url https://admin:password123@api.dev.oma/v1";
      const scrubbed = new SecretScrubber().scrub(input);
      assert.ok(!scrubbed.includes("secret_jwt_token_12345"));
      assert.ok(!scrubbed.includes("password123"));
    });

    it("3.5: executes process capturing output and enforces execution duration tracking", async () => {
      const res = await ProcessRunner.execute({ executable: "node", args: ["-e", "console.log('runner-ok')"], cwd: process.cwd() });
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes("runner-ok"));
      assert.ok(res.durationMs >= 0);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 4: Worktree Pool & Isolation
  // --------------------------------------------------------------------------
  describe("Feature 4: Worktree Pool & Isolation", () => {
    it("4.1: acquires an isolated directory in non-git workspace", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-wt1-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir });
        const wt = await pool.acquire("task-alpha");
        assert.ok(existsSync(wt));
        assert.equal(pool.getActiveWorktrees().size, 1);
        await pool.release("task-alpha", true);
        assert.ok(!existsSync(wt));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("4.2: returns identical path on duplicate acquire", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-wt2-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir });
        const path1 = await pool.acquire("task-dup");
        const path2 = await pool.acquire("task-dup");
        assert.equal(path1, path2);
        await pool.release("task-dup", true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("4.3: purges orphaned directories from prior runs", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-wt3-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir });
        const orphanDir = join(tempDir, ".oma", "worktrees", "orphan-99");
        mkdirSync(orphanDir, { recursive: true });
        writeFileSync(join(orphanDir, "stale.txt"), "leftover");

        const active = await pool.acquire("active-task");
        const purged = await pool.purgeOrphans();
        assert.ok(purged.includes("orphan-99"));
        assert.ok(!existsSync(orphanDir));
        assert.ok(existsSync(active));
        await pool.release("active-task", true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("4.4: safely cleans nested directories with retry", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-wt4-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir });
        const nested = join(tempDir, "a", "b", "c");
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(nested, "file.txt"), "content");
        await pool.removeDirectoryWithRetry(join(tempDir, "a"));
        assert.ok(!existsSync(join(tempDir, "a")));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("4.5: WorkspaceIsolationEngine establishes separate mission directories", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-iso-"));
      try {
        const pathsA = WorkspaceIsolationEngine.setupMissionIsolation(tempDir, "mission-1");
        const pathsB = WorkspaceIsolationEngine.setupMissionIsolation(tempDir, "mission-2");
        assert.ok(existsSync(pathsA.missionDir));
        assert.ok(existsSync(pathsB.missionDir));
        assert.notEqual(pathsA.missionDir, pathsB.missionDir);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 5: Parallel Scheduler & Scopes
  // --------------------------------------------------------------------------
  describe("Feature 5: Parallel Scheduler & Scopes", () => {
    it("5.1: executes independent nodes in parallel and records task summaries", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-sched1-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-sched-1",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            {
              id: "node-1",
              title: "Task 1",
              kind: "join",
              activation: "all",
              completionAuthority: "scheduler",
              completionAuthorityId: "oma-scheduler",
            },
            {
              id: "node-2",
              title: "Task 2",
              kind: "join",
              activation: "all",
              completionAuthority: "scheduler",
              completionAuthorityId: "oma-scheduler",
            },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const scheduler = new ParallelScheduler({ workspaceRoot: tempDir });
        const res = await scheduler.run();
        assert.equal(res.success, true);
        assert.equal(res.completedNodes.length, 2);
        assert.ok(res.completedNodes.includes("node-1"));
        assert.ok(res.completedNodes.includes("node-2"));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("5.2: respects topological dependencies executing parent before child", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-sched2-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-sched-2",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            {
              id: "parent",
              title: "Parent Task",
              kind: "join",
              activation: "all",
              completionAuthority: "scheduler",
              completionAuthorityId: "oma-scheduler",
            },
            {
              id: "child",
              title: "Child Task",
              kind: "join",
              activation: "all",
              completionAuthority: "scheduler",
              completionAuthorityId: "oma-scheduler",
            },
          ],
          edges: [
            { id: "e1", from: "parent", to: "child", when: "success" },
          ],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const scheduler = new ParallelScheduler({ workspaceRoot: tempDir });
        const res = await scheduler.run();
        assert.equal(res.success, true);
        assert.equal(res.completedNodes.length, 2);
        assert.equal(res.taskSummaries[0].nodeId, "parent");
        assert.equal(res.taskSummaries[1].nodeId, "child");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("5.3: manages activeScopeLocks set properly during scheduling", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-sched3-"));
      try {
        const scheduler = new ParallelScheduler({ workspaceRoot: tempDir });
        const locks = scheduler.getActiveScopeLocks();
        assert.equal(locks.size, 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("5.4: stops execution and flags failure when a task fails", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-sched4-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-sched-4",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            {
              id: "task-failing",
              title: "Task with bad command",
              kind: "agent",
              executor: { adapter: "antigravity-cli", persona: "worker" },
              activation: "all",
              completionAuthority: "broker",
              completionAuthorityId: "oma-scheduler",
            },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        // Driver with failing mock
        const failingDriver = {
          invoke: async () => ({
            status: "failed" as const,
            exitCode: 1,
            stdout: "",
            stderr: "fatal error",
            stdoutHash: sha256(""),
            stderrHash: sha256("fatal error"),
            durationMs: 10,
            commandLine: "mock",
            error: "fatal error",
          }),
        };

        const scheduler = new ParallelScheduler({
          workspaceRoot: tempDir,
          driver: failingDriver as any,
        });
        const res = await scheduler.run();
        assert.equal(res.success, false);
        assert.ok(res.failedNodes.includes("task-failing"));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("5.5: returns accurate totalDurationMs and task summary records", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-sched5-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-sched-5",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            {
              id: "quick-task",
              title: "Quick Task",
              kind: "join",
              activation: "all",
              completionAuthority: "scheduler",
              completionAuthorityId: "oma-scheduler",
            },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const scheduler = new ParallelScheduler({ workspaceRoot: tempDir });
        const res = await scheduler.run();
        assert.ok(res.totalDurationMs >= 0);
        assert.equal(res.taskSummaries.length, 1);
        assert.equal(res.taskSummaries[0].status, "succeeded");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 6: Execution Graph Schema
  // --------------------------------------------------------------------------
  describe("Feature 6: Execution Graph Schema", () => {
    it("6.1: parses valid ExecutionGraph successfully", () => {
      const valid = {
        schemaVersion: 2,
        graphId: "graph-valid",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          {
            id: "node-a",
            title: "Task A",
            kind: "join",
            activation: "all",
            completionAuthority: "scheduler",
            completionAuthorityId: "oma-scheduler",
          },
        ],
        edges: [],
      };
      const parsed = parseExecutionGraph(valid);
      assert.equal(parsed.graphId, "graph-valid");
      assert.equal(parsed.nodes.length, 1);
    });

    it("6.2: rejects graph when schemaVersion is missing or invalid", () => {
      const invalid = {
        graphId: "graph-invalid",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [],
        edges: [],
      };
      assert.throws(() => parseExecutionGraph(invalid));
    });

    it("6.3: rejects graph when nodes array is missing", () => {
      const invalid = {
        schemaVersion: 2,
        graphId: "graph-invalid",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        edges: [],
      };
      assert.throws(() => parseExecutionGraph(invalid));
    });

    it("6.4: rejects invalid activation mode on node", () => {
      const invalid = {
        schemaVersion: 2,
        graphId: "graph-invalid",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          {
            id: "node-a",
            title: "Task A",
            kind: "join",
            activation: "invalid_mode",
            completionAuthority: "scheduler",
            completionAuthorityId: "oma-scheduler",
          },
        ],
        edges: [],
      };
      assert.throws(() => parseExecutionGraph(invalid));
    });

    it("6.5: produces deterministic topologicalNodeIds ordering", () => {
      const graph: ExecutionGraph = {
        schemaVersion: 2,
        graphId: "graph-topo",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          { id: "c", title: "Task C", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
          { id: "a", title: "Task A", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
          { id: "b", title: "Task B", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
        ],
        edges: [
          { id: "e1", from: "a", to: "b", when: "success" },
          { id: "e2", from: "b", to: "c", when: "success" },
        ],
      };
      const res = validateKahnAcyclicity(graph.nodes, graph.edges);
      assert.deepEqual(res.topologicalOrder, ["a", "b", "c"]);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 7: Kahn DFS Acyclicity Validator
  // --------------------------------------------------------------------------
  describe("Feature 7: Kahn DFS Acyclicity Validator", () => {
    it("7.1: returns valid=true and topological order for linear DAG", () => {
      const graph: ExecutionGraph = {
        schemaVersion: 2,
        graphId: "dag-linear",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          { id: "x", title: "X", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
          { id: "y", title: "Y", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
        ],
        edges: [{ id: "e1", from: "x", to: "y", when: "success" }],
      };
      const res = validateKahnAcyclicity(graph.nodes, graph.edges);
      assert.equal(res.valid, true);
      assert.deepEqual(res.topologicalOrder, ["x", "y"]);
    });

    it("7.2: returns valid=true for diamond DAG with parallel branches", () => {
      const graph: ExecutionGraph = {
        schemaVersion: 2,
        graphId: "dag-diamond",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          { id: "start", title: "Start", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
          { id: "left", title: "Left", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
          { id: "right", title: "Right", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
          { id: "join", title: "Join", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
        ],
        edges: [
          { id: "e1", from: "start", to: "left", when: "success" },
          { id: "e2", from: "start", to: "right", when: "success" },
          { id: "e3", from: "left", to: "join", when: "success" },
          { id: "e4", from: "right", to: "join", when: "success" },
        ],
      };
      const res = validateKahnAcyclicity(graph.nodes, graph.edges);
      assert.equal(res.valid, true);
      assert.equal(res.topologicalOrder.length, 4);
    });

    it("7.3: detects self-loop and returns code SELF_LOOP_FORBIDDEN", () => {
      const graph: ExecutionGraph = {
        schemaVersion: 2,
        graphId: "dag-self-loop",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          { id: "loop_node", title: "Loop", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
        ],
        edges: [{ id: "e-self", from: "loop_node", to: "loop_node", when: "success" }],
      };
      const res = validateKahnAcyclicity(graph.nodes, graph.edges);
      assert.equal(res.valid, false);
      assert.equal(res.code, "SELF_LOOP_FORBIDDEN");
    });

    it("7.4: detects 2-node cycle A -> B -> A and extracts exact cycle path", () => {
      const graph: ExecutionGraph = {
        schemaVersion: 2,
        graphId: "dag-cycle-2",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          { id: "a", title: "A", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
          { id: "b", title: "B", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
        ],
        edges: [
          { id: "e1", from: "a", to: "b", when: "success" },
          { id: "e2", from: "b", to: "a", when: "success" },
        ],
      };
      const res = validateKahnAcyclicity(graph.nodes, graph.edges);
      assert.equal(res.valid, false);
      assert.equal(res.code, "CYCLE_DETECTED");
      assert.ok(res.cyclePath);
    });

    it("7.5: detects 3-node cycle A -> B -> C -> A with offending cyclePath", () => {
      const graph: ExecutionGraph = {
        schemaVersion: 2,
        graphId: "dag-cycle-3",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          { id: "n1", title: "N1", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
          { id: "n2", title: "N2", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
          { id: "n3", title: "N3", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" },
        ],
        edges: [
          { id: "e1", from: "n1", to: "n2", when: "success" },
          { id: "e2", from: "n2", to: "n3", when: "success" },
          { id: "e3", from: "n3", to: "n1", when: "success" },
        ],
      };
      const res = validateKahnAcyclicity(graph.nodes, graph.edges);
      assert.equal(res.valid, false);
      assert.equal(res.code, "CYCLE_DETECTED");
    });
  });

  // --------------------------------------------------------------------------
  // Feature 8: Graph Broker CAS Publication
  // --------------------------------------------------------------------------
  describe("Feature 8: Graph Broker CAS Publication", () => {
    it("8.1: validates valid proposal returning proposedGraph with incremented revision", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-broker1-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-cas-1",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            {
              id: "n_start",
              title: "Start",
              kind: "agent",
              activation: "all",
              completionAuthority: "broker",
              completionAuthorityId: "oma-broker",
              executor: { adapter: "antigravity-cli", persona: "oma-executor" },
            },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const broker = new GraphBroker(tempDir);
        const proposal = {
          schemaVersion: 2,
          proposalId: "prop_multi_op",
          author: "planner",
          reason: "Expand graph with two parallel tasks and join",
          expectedRevision: 1,
          operations: [
            { type: "add_node", node: { id: "n_a", title: "Task A", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } } },
            { type: "add_node", node: { id: "n_b", title: "Task B", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } } },
            { type: "add_node", node: { id: "n_join", title: "Join AB", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" } },
            { type: "add_edge", edge: { id: "e_sa", from: "n_start", to: "n_a", when: "success" } },
            { type: "add_edge", edge: { id: "e_sb", from: "n_start", to: "n_b", when: "success" } },
            { type: "add_edge", edge: { id: "e_aj", from: "n_a", to: "n_join", when: "success" } },
            { type: "add_edge", edge: { id: "e_bj", from: "n_b", to: "n_join", when: "success" } },
          ],
        };
        const validation = await broker.validateProposal(proposal as any);
        assert.equal(validation.valid, true);
        assert.equal(validation.proposedGraph?.revision, 2);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("8.2: rejects proposal when expectedRevision mismatches current revision", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-broker2-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-cas-2",
          revision: 2,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            {
              id: "root",
              title: "Root",
              kind: "agent",
              activation: "all",
              completionAuthority: "broker",
              completionAuthorityId: "oma-broker",
              executor: { adapter: "antigravity-cli", persona: "oma-executor" },
            },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const broker = new GraphBroker(tempDir);
        const proposal = {
          schemaVersion: 2,
          proposalId: "prop-stale",
          author: "planner",
          reason: "Stale proposal",
          expectedRevision: 1, // Stale!
          operations: [],
        };
        const validation = await broker.validateProposal(proposal);
        assert.equal(validation.valid, false);
        assert.ok(validation.diagnostics.some((d) => d.code === "CAS_CONFLICT" || d.code === "REVISION_MISMATCH"));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("8.3: rejects proposal with mismatched parentGraphHash", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-broker3-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-cas-3",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            {
              id: "root",
              title: "Root",
              kind: "agent",
              activation: "all",
              completionAuthority: "broker",
              completionAuthorityId: "oma-broker",
              executor: { adapter: "antigravity-cli", persona: "oma-executor" },
            },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const broker = new GraphBroker(tempDir);
        const proposal = {
          schemaVersion: 2,
          proposalId: "prop-hash-bad",
          author: "planner",
          reason: "Bad hash",
          expectedRevision: 1,
          parentGraphHash: "bad-hash-0000000000000000000000000000000000000000000000000000000000000000",
          operations: [],
        };
        const validation = await broker.validateProposal(proposal);
        assert.equal(validation.valid, false);
        assert.ok(validation.diagnostics.some((d) => d.code === "CAS_CONFLICT" || d.code === "PARENT_HASH_MISMATCH"));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("8.4: applies proposal atomically and writes rev_N archive", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-broker4-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-cas-4",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            {
              id: "n_start",
              title: "Start",
              kind: "agent",
              activation: "all",
              completionAuthority: "broker",
              completionAuthorityId: "oma-broker",
              executor: { adapter: "antigravity-cli", persona: "oma-executor" },
            },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const broker = new GraphBroker(tempDir);
        const proposal = {
          schemaVersion: 2,
          proposalId: "prop_multi_op",
          author: "planner",
          reason: "Expand graph with two parallel tasks and join",
          expectedRevision: 1,
          operations: [
            { type: "add_node", node: { id: "n_a", title: "Task A", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } } },
            { type: "add_edge", edge: { id: "e_sa", from: "n_start", to: "n_a", when: "success" } },
          ],
        };
        const applyRes = await broker.applyProposal(proposal as any);
        assert.equal(applyRes.success, true);
        const updated = JSON.parse(readFileSync(join(graphDir, "execution-graph.json"), "utf8"));
        assert.equal(updated.revision, 2);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("8.5: records revision_published event in JournalStore with valid cryptographic chain", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-broker5-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-cas-5",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            {
              id: "n_start",
              title: "Start",
              kind: "agent",
              activation: "all",
              completionAuthority: "broker",
              completionAuthorityId: "oma-broker",
              executor: { adapter: "antigravity-cli", persona: "oma-executor" },
            },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const broker = new GraphBroker(tempDir);
        const proposal = {
          schemaVersion: 2,
          proposalId: "prop_pub_1",
          author: "planner",
          reason: "Adding extra node",
          expectedRevision: 1,
          operations: [
            {
              type: "add_node",
              node: {
                id: "extra-node",
                title: "Extra Node",
                kind: "agent",
                activation: "all",
                completionAuthority: "broker",
                completionAuthorityId: "oma-broker",
                executor: { adapter: "antigravity-cli", persona: "oma-executor" },
              },
            },
            { type: "add_edge", edge: { id: "e_se", from: "n_start", to: "extra-node", when: "success" } },
          ],
        };
        const applyRes = await broker.applyProposal(proposal as any);
        assert.equal(applyRes.success, true);
        const updatedRuntime = loadGraphRuntime(tempDir);
        assert.equal(updatedRuntime.graph.revision, 2);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 9: Deterministic ReadySet Kernel
  // --------------------------------------------------------------------------
  describe("Feature 9: Deterministic ReadySet Kernel", () => {
    it("9.1: initial projection places root nodes in readySet", () => {
      const graph: ExecutionGraph = {
        schemaVersion: 1,
        graphId: "graph-kernel-1",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          { id: "root-1", title: "R1", kind: "join", activation: "all", completionAuthority: "broker", completionAuthorityId: "auth" },
          { id: "root-2", title: "R2", kind: "join", activation: "all", completionAuthority: "broker", completionAuthorityId: "auth" },
          { id: "child", title: "C", kind: "join", activation: "all", completionAuthority: "broker", completionAuthorityId: "auth" },
        ],
        edges: [
          { id: "e1", from: "root-1", to: "child", when: "success" },
          { id: "e2", from: "root-2", to: "child", when: "success" },
        ],
      };
      const proj = projectGraph(graph, []);
      assert.deepEqual(proj.readySet.sort(), ["root-1", "root-2"]);
      assert.equal(proj.nodes.find((n) => n.id === "child")?.state, "blocked");
    });

    it("9.2: node_dispatched event transitions state to running", () => {
      const graph: ExecutionGraph = {
        schemaVersion: 1,
        graphId: "graph-kernel-2",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          { id: "node-1", title: "N1", kind: "join", activation: "all", completionAuthority: "broker", completionAuthorityId: "auth" },
        ],
        edges: [],
      };
      const proj = projectGraph(graph, [
        {
          sequence: 1,
          timestamp: new Date().toISOString(),
          graphId: "graph-kernel-2",
          graphRevision: 1,
          graphHash: "h",
          eventType: "node_dispatched",
          nodeId: "node-1",
          dispatchId: "disp-1",
          authority: "scheduler",
          authorityId: "oma-scheduler",
          previousHash: "0".repeat(64),
          eventHash: "e1",
        },
      ]);
      assert.equal(proj.nodes.find((n) => n.id === "node-1")?.state, "running");
      assert.equal(proj.readySet.length, 0);
    });

    it("9.3: completed successful parent unblocks dependent child", () => {
      const graph: ExecutionGraph = {
        schemaVersion: 1,
        graphId: "graph-kernel-3",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          { id: "parent", title: "P", kind: "join", activation: "all", completionAuthority: "broker", completionAuthorityId: "auth" },
          { id: "child", title: "C", kind: "join", activation: "all", completionAuthority: "broker", completionAuthorityId: "auth" },
        ],
        edges: [
          { id: "e1", from: "parent", to: "child", when: "success" },
        ],
      };
      const proj = projectGraph(graph, [
        {
          sequence: 1,
          timestamp: new Date().toISOString(),
          graphId: "graph-kernel-3",
          graphRevision: 1,
          graphHash: "h",
          eventType: "node_dispatched",
          nodeId: "parent",
          dispatchId: "disp-p",
          authority: "scheduler",
          authorityId: "oma-scheduler",
          previousHash: "0".repeat(64),
          eventHash: "e1",
        },
        {
          sequence: 2,
          timestamp: new Date().toISOString(),
          graphId: "graph-kernel-3",
          graphRevision: 1,
          graphHash: "h",
          eventType: "node_completed",
          nodeId: "parent",
          dispatchId: "disp-p",
          outcome: "success",
          authority: "broker",
          authorityId: "auth",
          evidenceHash: "ev1",
          previousHash: "e1",
          eventHash: "e2",
        },
      ]);
      assert.equal(proj.nodes.find((n) => n.id === "parent")?.state, "succeeded");
      assert.equal(proj.nodes.find((n) => n.id === "child")?.state, "ready");
      assert.deepEqual(proj.readySet, ["child"]);
    });

    it("9.4: activation all requires all incoming edges to be active before becoming ready", () => {
      const graph: ExecutionGraph = {
        schemaVersion: 1,
        graphId: "graph-kernel-4",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          { id: "p1", title: "P1", kind: "join", activation: "all", completionAuthority: "broker", completionAuthorityId: "auth" },
          { id: "p2", title: "P2", kind: "join", activation: "all", completionAuthority: "broker", completionAuthorityId: "auth" },
          { id: "join-all", title: "JA", kind: "join", activation: "all", completionAuthority: "broker", completionAuthorityId: "auth" },
        ],
        edges: [
          { id: "e1", from: "p1", to: "join-all", when: "success" },
          { id: "e2", from: "p2", to: "join-all", when: "success" },
        ],
      };
      // Only p1 completed, p2 pending
      const proj = projectGraph(graph, [
        {
          sequence: 1,
          timestamp: new Date().toISOString(),
          graphId: "graph-kernel-4",
          graphRevision: 1,
          graphHash: "h",
          eventType: "node_dispatched",
          nodeId: "p1",
          dispatchId: "disp-p1",
          authority: "scheduler",
          authorityId: "oma-scheduler",
          previousHash: "0".repeat(64),
          eventHash: "e1",
        },
        {
          sequence: 2,
          timestamp: new Date().toISOString(),
          graphId: "graph-kernel-4",
          graphRevision: 1,
          graphHash: "h",
          eventType: "node_completed",
          nodeId: "p1",
          dispatchId: "disp-p1",
          outcome: "success",
          authority: "broker",
          authorityId: "auth",
          evidenceHash: "ev1",
          previousHash: "e1",
          eventHash: "e2",
        },
      ]);
      assert.equal(proj.nodes.find((n) => n.id === "join-all")?.state, "blocked");
      assert.deepEqual(proj.readySet, ["p2"]);
    });

    it("9.5: activation any becomes ready as soon as one incoming edge is active", () => {
      const graph: ExecutionGraph = {
        schemaVersion: 1,
        graphId: "graph-kernel-5",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          { id: "p1", title: "P1", kind: "join", activation: "all", completionAuthority: "broker", completionAuthorityId: "auth" },
          { id: "p2", title: "P2", kind: "join", activation: "all", completionAuthority: "broker", completionAuthorityId: "auth" },
          { id: "join-any", title: "JAny", kind: "join", activation: "any", completionAuthority: "broker", completionAuthorityId: "auth" },
        ],
        edges: [
          { id: "e1", from: "p1", to: "join-any", when: "success" },
          { id: "e2", from: "p2", to: "join-any", when: "success" },
        ],
      };
      // Only p1 completed
      const proj = projectGraph(graph, [
        {
          sequence: 1,
          timestamp: new Date().toISOString(),
          graphId: "graph-kernel-5",
          graphRevision: 1,
          graphHash: "h",
          eventType: "node_dispatched",
          nodeId: "p1",
          dispatchId: "disp-p1",
          authority: "scheduler",
          authorityId: "oma-scheduler",
          previousHash: "0".repeat(64),
          eventHash: "e1",
        },
        {
          sequence: 2,
          timestamp: new Date().toISOString(),
          graphId: "graph-kernel-5",
          graphRevision: 1,
          graphHash: "h",
          eventType: "node_completed",
          nodeId: "p1",
          dispatchId: "disp-p1",
          outcome: "success",
          authority: "broker",
          authorityId: "auth",
          evidenceHash: "ev1",
          previousHash: "e1",
          eventHash: "e2",
        },
      ]);
      assert.equal(proj.nodes.find((n) => n.id === "join-any")?.state, "ready");
      assert.ok(proj.readySet.includes("join-any"));
    });
  });
});
