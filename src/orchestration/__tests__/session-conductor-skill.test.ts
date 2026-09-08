import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { installWorkspacePlugin } from "../../packaging/install.js";
import { executePlanRoute } from "../../mcp/routing-tools.js";
import { executeGraphTool } from "../../mcp/graph-tools.js";
import { executeConvergeStep, executeGraphReplan } from "../../mcp/orchestration-tools.js";

describe("Phase 4: Session-Native Conductor Skill & Invariants (T4.1 - T4.4)", () => {
  const repoRoot = resolve(process.cwd());
  const skillPaths = [
    join(repoRoot, "src", "plugin-assets", "skills", "oma-start", "SKILL.md"),
    join(repoRoot, ".agents", "skills", "oma-start", "SKILL.md"),
    join(repoRoot, ".agents", "plugins", "oma", "skills", "oma-start", "SKILL.md"),
  ];

  const commandPaths = [
    join(repoRoot, "src", "plugin-assets", "commands", "start.md"),
    join(repoRoot, ".agents", "plugins", "oma", "commands", "start.md"),
  ];

  function md5(content: string): string {
    return createHash("md5").update(content, "utf8").digest("hex");
  }

  function cleanDir(dir: string): void {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      }
    }
  }

  it("T4.1: all 3 copies of oma-start/SKILL.md exist and have strictly identical MD5 checksums", () => {
    assert.equal(skillPaths.length, 3);
    const hashes: string[] = [];

    for (const filePath of skillPaths) {
      assert.ok(existsSync(filePath), `Skill file must exist at ${filePath}`);
      const content = readFileSync(filePath, "utf8");
      hashes.push(md5(content));
    }

    assert.equal(hashes[0], hashes[1], "Source and .agents/skills copies must have identical checksum");
    assert.equal(hashes[0], hashes[2], "Source and .agents/plugins/oma copies must have identical checksum");
  });

  it("T4.1: command start.md copies exist, have strictly identical MD5 checksums, and guide conductor loop", () => {
    assert.equal(commandPaths.length, 2);
    const hashes: string[] = [];

    for (const filePath of commandPaths) {
      assert.ok(existsSync(filePath), `Command file must exist at ${filePath}`);
      const content = readFileSync(filePath, "utf8");
      hashes.push(md5(content));
    }

    assert.equal(hashes[0], hashes[1], "Source and .agents/plugins/oma command copies must have identical checksum");

    const content = readFileSync(commandPaths[0], "utf8");
    assert.match(content, /oma-start/i);
    assert.match(content, /Mission Conductor/i);
    assert.match(content, /Late-Init/i);
    assert.match(content, /interview gate/i);
    assert.match(content, /plan_route/i);
    assert.match(content, /converge_step/i);
    assert.match(content, /brain_summarize/i);
    assert.match(content, /Do \*\*not\*\* call `run_mission`/i);
  });

  it("T4.1: skill specifies the 3-level Late-Init context ingestion cascade with graceful fallback", () => {
    const content = readFileSync(skillPaths[0], "utf8");

    // Level 1: Active session working memory
    assert.match(content, /Level 1/i);
    assert.match(content, /Active Session Working Memory/i);

    // Level 2: Cross-session SQLite facts & graph state
    assert.match(content, /Level 2/i);
    assert.match(content, /brain_query/i);
    assert.match(content, /converge_status/i);

    // Level 3: Optional transcript with graceful fallback and concrete runtime path
    assert.match(content, /Level 3/i);
    assert.match(content, /transcript/i);
    assert.match(content, /graceful/i);
    assert.match(content, /\.system_generated.*logs.*transcript\.jsonl/i);
  });

  it("T4.2: skill enforces mandatory blocking surgical interview gate before any run", () => {
    const content = readFileSync(skillPaths[0], "utf8");

    // Sequence 1: 2-3 sentence summary
    assert.match(content, /2(\s*(-|to)\s*|\s+)3 sentences/i);

    // Sequence 2: 2-3 targeted questions on frictions
    assert.match(content, /2(\s*(-|to)\s*|\s+)3 targeted questions/i);
    assert.match(content, /measurable/i);
    assert.match(content, /constraints/i);
    assert.match(content, /mode/i);

    // Sequence 3: Zero run/execution before explicit user confirmation
    assert.match(content, /zero run/i);
    assert.match(content, /blocked/i);
    assert.match(content, /MUST NOT call `graph_init`/i);
  });

  it("T4.3: skill specifies mode selection calling plan_route {mode} to obtain canonical roles & ModeConfig", () => {
    const content = readFileSync(skillPaths[0], "utf8");

    assert.match(content, /plan_route/i);
    assert.match(content, /modeConfig/i);
    assert.match(content, /planner/);
    assert.match(content, /explorer/);
    assert.match(content, /executor/);
    assert.match(content, /reviewer/);
    assert.match(content, /verifier/);
  });

  it("T4.4: skill specifies session-native loop driven by converge_step, 2PC lifecycle, and graph_replan", () => {
    const content = readFileSync(skillPaths[0], "utf8");

    assert.match(content, /converge_step/i);
    assert.match(content, /no_progress_blocked/i);
    assert.match(content, /budget_exhausted/i);
    assert.match(content, /failed/i);
    assert.match(content, /graph_mark_node/i);
    assert.match(content, /propose_change/i);
    assert.match(content, /attest_review/i);
    assert.match(content, /promote_change/i);
    assert.match(content, /graph_replan/i);
  });

  it("packaging: installWorkspacePlugin preserves skill and command synchronization in deployed workspaces", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "oma-skill-test-"));
    try {
      const sourceSkillContent = readFileSync(skillPaths[0], "utf8");
      const sourceSkillHash = md5(sourceSkillContent);

      const sourceCommandContent = readFileSync(commandPaths[0], "utf8");
      const sourceCommandHash = md5(sourceCommandContent);

      installWorkspacePlugin(tempDir, { force: true });

      // 1. Check .agents/plugins/oma/skills/oma-start/SKILL.md
      const pluginSkillPath = join(
        tempDir,
        ".agents",
        "plugins",
        "oma",
        "skills",
        "oma-start",
        "SKILL.md",
      );
      assert.ok(existsSync(pluginSkillPath), "Deployed workspace must contain .agents/plugins/oma/skills/oma-start/SKILL.md");
      assert.equal(md5(readFileSync(pluginSkillPath, "utf8")), sourceSkillHash);

      // 2. Check native .agents/skills/oma-start/SKILL.md
      const nativeSkillPath = join(
        tempDir,
        ".agents",
        "skills",
        "oma-start",
        "SKILL.md",
      );
      assert.ok(existsSync(nativeSkillPath), "Deployed workspace must contain .agents/skills/oma-start/SKILL.md");
      assert.equal(md5(readFileSync(nativeSkillPath, "utf8")), sourceSkillHash);

      // 3. Check .agents/plugins/oma/commands/start.md
      const commandPath = join(
        tempDir,
        ".agents",
        "plugins",
        "oma",
        "commands",
        "start.md",
      );
      assert.ok(existsSync(commandPath), "Deployed workspace must contain .agents/plugins/oma/commands/start.md");
      assert.equal(md5(readFileSync(commandPath, "utf8")), sourceCommandHash);
    } finally {
      cleanDir(tempDir);
    }
  });

  it("end-to-end conductor tool simulation: plan_route -> graph_init -> converge_step -> graph_replan", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "oma-conductor-e2e-"));
    try {
      // Step 3: plan_route
      const route = executePlanRoute({ mode: "bugfix" });
      assert.equal(route.status, "routed");
      assert.deepEqual(route.roles, ["planner", "executor", "verifier"]);
      assert.equal(route.modeConfig.mode, "bugfix");

      // Step 4: graph_init
      const missionId = "mission-conductor-sim";
      const initResult = executeGraphTool(tempDir, "graph_init", {
        goal: "Fix parsing edge case in parser.ts",
        missionId,
        nodes: [
          {
            id: "node-verify-repro",
            title: "Write reproduction test",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "agy", persona: "verifier" },
            scope: ["src/parser.ts"],
          },
        ],
      });
      assert.equal(initResult.status, "initialized");

      // Step 5.1: converge_step round 1
      const step1 = executeConvergeStep(tempDir, {
        missionId,
        currentRound: 1,
      });
      assert.equal(step1.status, "in_progress");
      assert.equal(step1.readyNodes.length, 1);
      assert.equal(step1.readyNodes[0].id, "node-verify-repro");

      // Step 5.2: Node executes and fails verifier gate
      executeGraphTool(tempDir, "graph_mark_node", {
        nodeId: "node-verify-repro",
        state: "running",
      });
      executeGraphTool(tempDir, "graph_mark_node", {
        nodeId: "node-verify-repro",
        state: "failed",
        outcome: "failure",
      });

      // Step 5.4: Verifier failure triggers dynamic replanning via graph_replan
      const replanResult = executeGraphReplan(tempDir, {
        failedNodeId: "node-verify-repro",
        failureReason: "Reproducing test failed with unexpected token at line 42",
        role: "explorer",
        missionId,
      });
      assert.equal(replanResult.status, "replanned");
      assert.equal(replanResult.role, "explorer");
      assert.equal(replanResult.failedNodeId, "node-verify-repro");
      assert.equal(replanResult.isReady, true);
      assert.ok(typeof replanResult.newNodeId === "string");

      // Step 5.1: converge_step round 2 picks up replanned diagnostic node
      const step2 = executeConvergeStep(tempDir, {
        missionId,
        currentRound: 2,
      });
      assert.equal(step2.status, "in_progress");
      assert.ok(
        step2.readyNodes.some((n: any) => n.id === replanResult.newNodeId),
        "Replanned diagnostic node must be in readyNodes for next wave",
      );
    } finally {
      cleanDir(tempDir);
    }
  });
});
