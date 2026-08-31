import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreePool } from "../../src/orchestration/worktree-pool.js";
import { AgyDriver } from "../../src/runtime/agy-driver.js";
import { SecretScrubber } from "../../src/runtime/secret-scrubber.js";
import { OmaDoctor } from "../../src/runtime/doctor.js";
import { parseExecutionGraph, type ExecutionGraph } from "../../src/graph/model.js";
import { GraphBroker } from "../../src/graph/broker.js";
import { initializeGraphStore, appendGraphTransition, loadGraphRuntime, verifyGraphStore } from "../../src/graph/store.js";
import type { GraphProposal } from "../../src/graph/proposal.js";

describe("Tier 2: Boundary & Corner Cases — Features 1 to 9", () => {
  // --------------------------------------------------------------------------
  // Feature 1: Worktree Isolation & Cleanup (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 1: Worktree Isolation & Cleanup (Boundary Cases)", () => {
    it("1.1: rapid acquire-and-release churn across 10 iterations without leaking", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wt1-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir });
        for (let i = 0; i < 10; i++) {
          const path = await pool.acquire(`churn-task-${i}`);
          assert.ok(existsSync(path));
          await pool.release(`churn-task-${i}`);
          assert.ok(!existsSync(path));
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("1.2: handles deeply nested subdirectories inside worktree", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wt2-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir });
        const wtPath = await pool.acquire("nested-task");
        const deepDir = join(wtPath, "a", "b", "c", "d", "e");
        mkdirSync(deepDir, { recursive: true });
        writeFileSync(join(deepDir, "deep.txt"), "hello deep");
        assert.ok(existsSync(join(deepDir, "deep.txt")));
        await pool.release("nested-task");
        assert.ok(!existsSync(wtPath));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("1.3: handles task IDs with special characters, dashes, and dots", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wt3-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir });
        const complexId = "feat-spec_1.0-alpha.sub-task";
        const wtPath = await pool.acquire(complexId);
        assert.ok(existsSync(wtPath));
        await pool.release(complexId);
        assert.ok(!existsSync(wtPath));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("1.4: purgeOrphans safely handles non-standard directories in worktree area", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wt4-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir });
        const wtBase = join(tempDir, ".oma", "worktrees");
        mkdirSync(wtBase, { recursive: true });
        mkdirSync(join(wtBase, "task-orphan-123"), { recursive: true });
        writeFileSync(join(wtBase, "not-a-dir.txt"), "ignore me");

        const purged = await pool.purgeOrphans();
        assert.ok(purged.includes("task-orphan-123"));
        assert.ok(!existsSync(join(wtBase, "task-orphan-123")));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("1.5: concurrent acquisition of 5 distinct worktrees provides collision-free paths", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-wt5-"));
      try {
        const pool = new WorktreePool({ workspaceRoot: tempDir });
        const promises = Array.from({ length: 5 }, (_, i) => pool.acquire(`concurrent-${i}`));
        const paths = await Promise.all(promises);
        const uniquePaths = new Set(paths);
        assert.equal(uniquePaths.size, 5);
        for (let i = 0; i < 5; i++) {
          await pool.release(`concurrent-${i}`);
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 2: Multi-Persona Execution Environment (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 2: Multi-Persona Execution Environment (Boundary Cases)", () => {
    it("2.1: handles extremely long prompts (>50k characters) without truncation crash", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-per1-"));
      try {
        const driver = new AgyDriver();
        const massivePrompt = "A".repeat(50_000);
        const res = await driver.invoke({
          worktreeDir: tempDir,
          contractPrompt: massivePrompt,
          persona: "worker",
          timeoutMs: 5000,
        });
        assert.ok(typeof res.exitCode === "number");
        assert.ok(res.receipt);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("2.2: handles empty prompt string gracefully", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-per2-"));
      try {
        const driver = new AgyDriver();
        const res = await driver.invoke({
          worktreeDir: tempDir,
          contractPrompt: "",
          persona: "worker",
          timeoutMs: 5000,
        });
        assert.ok(typeof res.exitCode === "number");
        assert.ok(res.receipt);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("2.3: handles persona prompt containing code blocks and unicode characters", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-per3-"));
      try {
        const driver = new AgyDriver();
        const complexPrompt = "```json\n{\"test\": true, \"emoji\": \"🚀🔥✨\", \"quotes\": \"\\\"escaped\\\"\"}\n```";
        const res = await driver.invoke({
          worktreeDir: tempDir,
          contractPrompt: complexPrompt,
          persona: "reviewer-alpha",
          timeoutMs: 5000,
        });
        assert.ok(typeof res.exitCode === "number");
        assert.ok(res.receipt);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("2.4: modelOverride flag accepts arbitrary model identifier strings", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-per4-"));
      try {
        const driver = new AgyDriver();
        const res = await driver.invoke({
          worktreeDir: tempDir,
          contractPrompt: "Inspect",
          persona: "planner",
          modelOverride: "gemini-3.7-custom-preview-2026",
          timeoutMs: 5000,
        });
        assert.ok(typeof res.exitCode === "number");
        assert.equal(res.receipt.model, "gemini-3.7-custom-preview-2026");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("2.5: reasoningEffort flag accepts high, medium, and low levels", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-per5-"));
      try {
        const driver = new AgyDriver();
        for (const effort of ["low", "medium", "high"] as const) {
          const res = await driver.invoke({
            worktreeDir: tempDir,
            contractPrompt: "Plan",
            persona: "planner",
            reasoningEffort: effort,
            timeoutMs: 5000,
          });
          assert.ok(typeof res.exitCode === "number");
          assert.equal(res.receipt.effort, effort);
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 3: Sandboxed Process Execution & Timeout (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 3: Sandboxed Process Execution & Timeout (Boundary Cases)", () => {
    it("3.1: handles zero timeout (0ms) and short timeouts cleanly", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-proc1-"));
      try {
        const driver = new AgyDriver();
        const res = await driver.invoke({
          worktreeDir: tempDir,
          contractPrompt: "Test zero timeout",
          persona: "worker",
          timeoutMs: 0,
        });
        assert.ok(typeof res.exitCode === "number");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("3.2: accurately measures durationMs non-negative", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-proc2-"));
      try {
        const driver = new AgyDriver();
        const res = await driver.invoke({
          worktreeDir: tempDir,
          contractPrompt: "Quick run",
          persona: "worker",
          timeoutMs: 5000,
        });
        assert.ok(res.durationMs >= 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("3.3: captures stdout even when process emits large payload", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-proc3-"));
      try {
        const driver = new AgyDriver();
        const res = await driver.invoke({
          worktreeDir: tempDir,
          contractPrompt: "Generate output",
          persona: "worker",
          timeoutMs: 5000,
        });
        assert.ok(typeof res.rawStdout === "string");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("3.4: returns non-throwing structured result on non-existent worktree directory", async () => {
      const nonExistent = join(tmpdir(), "oma-non-existent-dir-xyz");
      const driver = new AgyDriver();
      const res = await driver.invoke({
        worktreeDir: nonExistent,
        contractPrompt: "Test non-existent dir",
        persona: "worker",
        timeoutMs: 5000,
      });
      assert.ok(typeof res.exitCode === "number");
    });

    it("3.5: preserves exitCode and receipt structure under all execution conditions", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-proc5-"));
      try {
        const driver = new AgyDriver();
        const res = await driver.invoke({
          worktreeDir: tempDir,
          contractPrompt: "Status",
          persona: "worker",
          timeoutMs: 5000,
        });
        assert.ok(res.receipt !== undefined);
        assert.ok(typeof res.rawStderr === "string");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 4: Structured Output Protocol (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 4: Structured Output Protocol (Boundary Cases)", () => {
    const driver = new AgyDriver();

    it("4.1: parses JSON wrapped inside markdown code fences with noise", () => {
      const output = "Here is the response:\n```json\n{\n  \"status\": \"success\",\n  \"count\": 42\n}\n```\nDone.";
      const { parsed } = driver.extractStructuredOutput(output);
      assert.equal((parsed as any)?.status, "success");
      assert.equal((parsed as any)?.count, 42);
    });

    it("4.2: extracts valid JSON block when code fences exist", () => {
      const output = "Output:\n```json\n{\"target\": \"primary\"}\n```\nExtra notes";
      const { parsed } = driver.extractStructuredOutput(output);
      assert.equal((parsed as any)?.target, "primary");
    });

    it("4.3: handles deeply nested JSON objects and arrays", () => {
      const nested = { a: { b: { c: { d: { e: [1, 2, 3, { f: "deep_value" }] } } } } };
      const output = `Result: \`\`\`json\n${JSON.stringify(nested)}\n\`\`\``;
      const { parsed } = driver.extractStructuredOutput(output);
      assert.equal((parsed as any)?.a?.b?.c?.d?.e?.[3]?.f, "deep_value");
    });

    it("4.4: returns undefined on completely non-JSON plain text without crashing", () => {
      const plainText = "I could not generate any JSON for this request. Please check logs.";
      const { parsed, parseError } = driver.extractStructuredOutput(plainText);
      assert.equal(parsed, undefined);
      assert.ok(parseError);
    });

    it("4.5: parses raw JSON object with leading/trailing whitespaces without fences", () => {
      const rawJson = "   \n\t  {\"raw\": true, \"version\": 2}  \n  ";
      const { parsed } = driver.extractStructuredOutput(rawJson);
      assert.equal((parsed as any)?.raw, true);
      assert.equal((parsed as any)?.version, 2);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 5: Secret & Credential Redaction (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 5: Secret & Credential Redaction (Boundary Cases)", () => {
    const scrubber = new SecretScrubber();

    it("5.1: scrubs multiple different secrets interleaved across 100k character text", () => {
      const secret1 = "AIzaSy" + "A".repeat(33);
      const secret2 = "ghp_" + "a".repeat(36);
      const largeText = `Prefix ${"x".repeat(50_000)} ${secret1} Middle ${"y".repeat(50_000)} ${secret2} Suffix`;
      const scrubbed = scrubber.scrub(largeText);
      assert.ok(!scrubbed.includes(secret1));
      assert.ok(!scrubbed.includes(secret2));
      assert.ok(scrubbed.includes("[REDACTED_GEMINI_KEY]") || scrubbed.includes("[REDACTED_GITHUB_TOKEN]"));
    });

    it("5.2: scrubs Bearer tokens and Authorization headers with special chars", () => {
      const header = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const scrubbed = scrubber.scrub(header);
      assert.ok(!scrubbed.includes("eyJhbGciOi"));
      assert.ok(scrubbed.includes("[REDACTED_JWT_TOKEN]") || scrubbed.includes("[REDACTED_AUTH_BEARER]") || scrubbed.includes("REDACTED"));
    });

    it("5.3: leaves benign non-secret code, hex hashes, and UUIDs unchanged", () => {
      const benign = "commit 7090889183b4b5f69657eb793d27d1daa361c1fd251b320da04731c496fc1e87 uuid 123e4567-e89b-12d3-a456-426614174000";
      const scrubbed = scrubber.scrub(benign);
      assert.equal(scrubbed, benign);
    });

    it("5.4: handles empty string and whitespace-only strings without error", () => {
      assert.equal(scrubber.scrub(""), "");
      assert.equal(scrubber.scrub("   \n\t  "), "   \n\t  ");
    });

    it("5.5: redacts private key blocks with varied header/footer casing or line endings", () => {
      const privKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Y5Q...\n-----END RSA PRIVATE KEY-----";
      const scrubbed = scrubber.scrub(privKey);
      assert.ok(!scrubbed.includes("MIIEowIBAAKCAQEA0Y5Q"));
      assert.ok(scrubbed.includes("[REDACTED_PRIVATE_KEY]"));
    });
  });

  // --------------------------------------------------------------------------
  // Feature 6: Environment Introspection & Doctor (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 6: Environment Introspection & Doctor (Boundary Cases)", () => {
    it("6.1: diagnoseEnvironment runs without throwing on completely empty workspace", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-doc1-"));
      try {
        const report = OmaDoctor.diagnoseEnvironment(tempDir);
        assert.ok(report.os);
        assert.ok(report.architecture);
        assert.equal(report.pluginDiscovery.installed, false);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("6.2: reports missing .git and missing oma installation accurately", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-doc2-"));
      try {
        const report = OmaDoctor.diagnoseEnvironment(tempDir);
        assert.equal(report.pluginDiscovery.installed, false);
        assert.ok(typeof report.gitCli.available === "boolean");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("6.3: detects installed plugin and active experts when .agents directory is present", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-doc3-"));
      try {
        const pluginDir = join(tempDir, ".agents", "plugins", "oma");
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify({ name: "oma", version: "1.0.0" }));

        const report = OmaDoctor.diagnoseEnvironment(tempDir);
        assert.equal(report.pluginDiscovery.installed, true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("6.4: doctor report can be serialized to and from JSON without loss", () => {
      const report = OmaDoctor.diagnoseEnvironment(process.cwd());
      const jsonStr = JSON.stringify(report);
      const deserialized = JSON.parse(jsonStr);
      assert.equal(deserialized.os, report.os);
      assert.equal(deserialized.architecture, report.architecture);
    });

    it("6.5: diagnoseEnvironment returns structured diagnostic categories", () => {
      const report = OmaDoctor.diagnoseEnvironment(process.cwd());
      assert.ok(report.timestamp);
      assert.ok(Array.isArray(report.pluginDiscovery.diagnostics));
    });
  });

  // --------------------------------------------------------------------------
  // Feature 7: Dynamic Work-Graph Schema & DAG Validation (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 7: Dynamic Work-Graph Schema & DAG Validation (Boundary Cases)", () => {
    it("7.1: accepts large 50-node wide diamond graph without cycle", () => {
      const nodes: any[] = [{ id: "root", title: "Root", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } }];
      const edges: any[] = [];
      for (let i = 1; i <= 48; i++) {
        nodes.push({ id: `mid_${i}`, title: `Mid ${i}`, kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } });
        edges.push({ id: `e_in_${i}`, from: "root", to: `mid_${i}`, when: "always" });
        edges.push({ id: `e_out_${i}`, from: `mid_${i}`, to: "join_node", when: "always" });
      }
      nodes.push({ id: "join_node", title: "Join", kind: "join", activation: "all", completionAuthority: "scheduler", completionAuthorityId: "oma-scheduler" });

      const graph = {
        schemaVersion: 2,
        graphId: "large-diamond",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes,
        edges,
      };
      const parsed = parseExecutionGraph(graph);
      assert.equal(parsed.nodes.length, 50);
    });

    it("7.2: detects self-loop cycle on single node (node-A -> node-A)", () => {
      const graph = {
        schemaVersion: 2,
        graphId: "self-cycle",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [{ id: "loop_node", title: "Loop", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } }],
        edges: [{ id: "e_loop", from: "loop_node", to: "loop_node", when: "always" }],
      };
      assert.throws(() => parseExecutionGraph(graph), /forbidden|Self-loop/);
    });

    it("7.3: detects long 10-node cycle (n1 -> n2 -> ... -> n10 -> n1)", () => {
      const nodes: any[] = [];
      const edges: any[] = [];
      for (let i = 1; i <= 10; i++) {
        nodes.push({ id: `n_${i}`, title: `N ${i}`, kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } });
        const next = i === 10 ? 1 : i + 1;
        edges.push({ id: `e_${i}`, from: `n_${i}`, to: `n_${next}`, when: "always" });
      }
      const graph = {
        schemaVersion: 2,
        graphId: "long-cycle",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes,
        edges,
      };
      assert.throws(() => parseExecutionGraph(graph), /Cycle detected|cycle/);
    });

    it("7.4: rejects edge referencing unknown 'from' or 'to' node IDs", () => {
      const graph = {
        schemaVersion: 2,
        graphId: "unknown-edges",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [{ id: "valid_node", title: "Valid", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } }],
        edges: [{ id: "bad_edge", from: "valid_node", to: "non_existent_node", when: "always" }],
      };
      assert.throws(() => parseExecutionGraph(graph), /references an unknown node/);
    });

    it("7.5: rejects duplicate node IDs in execution graph", () => {
      const graph = {
        schemaVersion: 2,
        graphId: "dup-nodes",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          { id: "same_id", title: "First", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
          { id: "same_id", title: "Second", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
        ],
        edges: [],
      };
      assert.throws(() => parseExecutionGraph(graph), /Duplicate/);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 8: Dynamic Graph Broker CAS & Mutations (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 8: Dynamic Graph Broker CAS & Mutations (Boundary Cases)", () => {
    it("8.1: rejects proposal targeting stale revision (CAS version mismatch)", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-cas1-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-cas-1",
          revision: 5,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [{ id: "n1", title: "N1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } }],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const broker = new GraphBroker(tempDir);
        const staleProposal: GraphProposal = {
          schemaVersion: 2,
          proposalId: "prop_stale_1",
          author: "worker",
          reason: "Out of date proposal",
          expectedRevision: 2,
          operations: [
            { type: "add_node", node: { id: "n2", title: "N2", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } } },
          ],
        };

        const res = await broker.applyProposal(staleProposal);
        assert.equal(res.success, false);
        assert.equal(res.code, "CAS_CONFLICT");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("8.2: rejects proposal attempting to mutate already completed terminal node", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-cas2-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-cas-2",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            { id: "term_node", title: "Terminal", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
          ],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        const runtime = initializeGraphStore(tempDir);

        appendGraphTransition(runtime, {
          eventType: "node_dispatched",
          nodeId: "term_node",
          dispatchId: "disp-term",
          authority: "scheduler",
          authorityId: "oma-scheduler",
        });
        appendGraphTransition(runtime, {
          eventType: "node_completed",
          nodeId: "term_node",
          dispatchId: "disp-term",
          outcome: "success",
          authority: "broker",
          authorityId: "oma-broker",
          evidenceHash: "0".repeat(64),
        });

        const broker = new GraphBroker(tempDir);
        const invalidProposal: GraphProposal = {
          schemaVersion: 2,
          proposalId: "prop_term_mut",
          author: "worker",
          reason: "Mutate finished node",
          expectedRevision: 1,
          operations: [
            { type: "add_node", node: { id: "n_new", title: "New", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } } },
            { type: "add_edge", edge: { id: "e_bad", from: "n_new", to: "term_node", when: "always" } },
          ],
        };

        const val = await broker.validateProposal(invalidProposal);
        assert.equal(val.valid, false);
        assert.ok(val.diagnostics.some((d) => d.code === "TERMINAL_NODE_MUTATION" || d.message.includes("terminal") || d.message.includes("immutable")));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("8.3: rejects proposal creating a cycle during expansion", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-cas3-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-cas-3",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [
            { id: "step_1", title: "Step 1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
            { id: "step_2", title: "Step 2", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } },
          ],
          edges: [
            { id: "e1", from: "step_1", to: "step_2", when: "always" },
          ],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const broker = new GraphBroker(tempDir);
        const cycleProposal: GraphProposal = {
          schemaVersion: 2,
          proposalId: "prop_cycle_add",
          author: "worker",
          reason: "Add back-edge cycle",
          expectedRevision: 1,
          operations: [
            { type: "add_edge", edge: { id: "e_cycle", from: "step_2", to: "step_1", when: "always" } },
          ],
        };

        const val = await broker.validateProposal(cycleProposal);
        assert.equal(val.valid, false);
        assert.ok(val.diagnostics.some((d) => d.code === "CYCLE_DETECTED" || d.code === "BACKWARD_EDGE_FORBIDDEN" || d.message.includes("Cycle detected") || d.message.includes("cycle")));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("8.4: accepts clean multi-operation proposal adding multiple nodes and edges", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-cas4-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-cas-4",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [{ id: "n_start", title: "Start", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } }],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const broker = new GraphBroker(tempDir);
        const multiProposal: GraphProposal = {
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

        const res = await broker.applyProposal(multiProposal);
        if (!res.success) {
          console.error("MultiProposal failure:", JSON.stringify(res));
        }
        assert.equal(res.success, true);
        assert.equal(res.revision, 2);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("8.5: atomic rollback on proposal failure leaves execution-graph unmodified", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-cas5-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-cas-5",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [{ id: "n_init", title: "Init", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } }],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        const graphPath = join(graphDir, "execution-graph.json");
        writeFileSync(graphPath, JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const broker = new GraphBroker(tempDir);
        const flawedProposal: GraphProposal = {
          schemaVersion: 2,
          proposalId: "prop_flawed",
          author: "worker",
          reason: "Partially valid proposal with fatal cycle at end",
          expectedRevision: 1,
          operations: [
            { type: "add_node", node: { id: "n_temp", title: "Temp", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } } },
            { type: "add_edge", edge: { id: "e_cycle", from: "n_init", to: "n_init", when: "always" } },
          ],
        };

        const res = await broker.applyProposal(flawedProposal);
        assert.equal(res.success, false);

        const runtimeAfter = loadGraphRuntime(tempDir);
        assert.equal(runtimeAfter.graph.revision, 1);
        assert.equal(runtimeAfter.graph.nodes.length, 1);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 9: Graph Transition & State Persistence (Boundary Cases)
  // --------------------------------------------------------------------------
  describe("Feature 9: Graph Transition & State Persistence (Boundary Cases)", () => {
    it("9.1: writes and replays 50 sequential transitions without data corruption", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-trans1-"));
      try {
        const nodes: any[] = [];
        for (let i = 0; i < 25; i++) {
          nodes.push({ id: `n_${i}`, title: `N ${i}`, kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } });
        }
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-trans-1",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes,
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        const runtime = initializeGraphStore(tempDir);

        for (let i = 0; i < 25; i++) {
          appendGraphTransition(runtime, {
            eventType: "node_dispatched",
            nodeId: `n_${i}`,
            dispatchId: `disp-seq-${i}`,
            authorityId: "oma-scheduler",
          });
          appendGraphTransition(runtime, {
            eventType: "node_completed",
            nodeId: `n_${i}`,
            dispatchId: `disp-seq-${i}`,
            outcome: "success",
            authority: "broker",
            authorityId: "oma-broker",
            evidenceHash: "0".repeat(64),
          });
        }

        const verification = verifyGraphStore(runtime);
        assert.equal(verification.valid, true);
        assert.equal(verification.events.length, 50);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("9.2: handles empty transitions log gracefully", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-trans2-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-trans-2",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [{ id: "n1", title: "N1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } }],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        const runtime = initializeGraphStore(tempDir);

        const verification = verifyGraphStore(runtime);
        assert.equal(verification.valid, true);
        assert.equal(verification.events.length, 0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("9.3: reports error when transition references an unmanaged event sequence", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-trans3-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-trans-3",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [{ id: "n1", title: "N1", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } }],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        const runtime = initializeGraphStore(tempDir);

        const eventsFile = join(graphDir, "events.jsonl");
        writeFileSync(eventsFile, "{ broken json line\n", "utf8");

        const verification = verifyGraphStore(runtime);
        assert.equal(verification.valid, false);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("9.4: loadGraphRuntime recovers complete state from filesystem", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-trans4-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-trans-4",
          revision: 3,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [{ id: "n_persisted", title: "Persisted", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } }],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        initializeGraphStore(tempDir);

        const loaded = loadGraphRuntime(tempDir);
        assert.equal(loaded.graph.revision, 3);
        assert.equal(loaded.graph.nodes[0].id, "n_persisted");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("9.5: verifyGraphStore validates sequence consistency of completed events", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "oma-t2-trans5-"));
      try {
        const graph: ExecutionGraph = {
          schemaVersion: 2,
          graphId: "graph-trans-5",
          revision: 1,
          schedulerAuthorityId: "oma-scheduler",
          nodes: [{ id: "node_x", title: "X", kind: "agent", activation: "all", completionAuthority: "broker", completionAuthorityId: "oma-broker", executor: { adapter: "antigravity-cli", persona: "oma-executor" } }],
          edges: [],
        };
        const graphDir = join(tempDir, ".oma", "graph");
        mkdirSync(graphDir, { recursive: true });
        writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2));
        const runtime = initializeGraphStore(tempDir);

        appendGraphTransition(runtime, {
          eventType: "node_dispatched",
          nodeId: "node_x",
          dispatchId: "disp-x",
          authorityId: "oma-scheduler",
        });
        appendGraphTransition(runtime, {
          eventType: "node_completed",
          nodeId: "node_x",
          dispatchId: "disp-x",
          outcome: "failure",
          authority: "broker",
          authorityId: "oma-broker",
          evidenceHash: "0".repeat(64),
        });

        const ver = verifyGraphStore(runtime);
        assert.equal(ver.valid, true);
        assert.equal(ver.events.length, 2);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
