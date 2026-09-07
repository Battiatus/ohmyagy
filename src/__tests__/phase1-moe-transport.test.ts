import assert from "node:assert/strict";
import { describe, it, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installWorkspacePlugin } from "../packaging/install.js";
import { CapabilityResolver } from "../runtime/capability-resolver.js";
import { AgyDriver } from "../runtime/agy-driver.js";
import { evaluateStrictToolUse } from "../strict/policy.js";
import {
  MissionEventsStore,
  generateDeterministicRunId,
  generateDeterministicWorkItemId,
} from "../ledger/mission-events.js";

describe("Phase 1 — Transport AntiGravity et MoE Minimal", () => {
  it("Gate 1.1: Packaging installs complete plugin with agents, skills, and updated rules", () => {
    const testDir = join(process.cwd(), ".oma", "test-plugin-workspace");
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    try {
      const install = installWorkspacePlugin(testDir);
      assert.ok(existsSync(install.pluginDir));
      assert.ok(existsSync(join(install.pluginDir, "plugin.json")));
      assert.ok(existsSync(join(install.pluginDir, "hooks.json")));
      assert.ok(existsSync(join(install.pluginDir, "mcp_config.json")));
      assert.ok(existsSync(join(install.pluginDir, "rules", "oma-strict.md")));

      // Check agents deployed
      const agentsDir = join(install.pluginDir, "agents");
      assert.ok(existsSync(agentsDir));
      const agentFiles = readdirSync(agentsDir);
      assert.ok(agentFiles.includes("planner.md"), "planner.md must be deployed");
      assert.ok(agentFiles.includes("worker.md"), "worker.md must be deployed");
      assert.ok(agentFiles.includes("reviewer.md"), "reviewer.md must be deployed");

      // Check skills deployed
      const skillsDir = join(install.pluginDir, "skills");
      assert.ok(existsSync(skillsDir));
      assert.ok(existsSync(join(skillsDir, "dynamic-workflow", "SKILL.md")));
      assert.ok(existsSync(join(skillsDir, "quality-oracle", "SKILL.md")));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("Gate 1.2: Capability Resolver resolves planner, worker, reviewer into concrete specs", () => {
    const plannerCap = CapabilityResolver.resolve("planner");
    assert.equal(plannerCap.agentName, "planner");
    assert.equal(plannerCap.modelSlug, "agy-default");
    assert.equal(plannerCap.effort, "high");
    assert.equal(plannerCap.sandbox, "read-only");
    assert.equal(plannerCap.readOnly, true);
    assert.ok(!plannerCap.allowedTools.includes("write_to_file"));

    const workerCap = CapabilityResolver.resolve("worker");
    assert.equal(workerCap.agentName, "worker");
    assert.equal(workerCap.modelSlug, "agy-default");
    assert.equal(workerCap.effort, "medium");
    assert.equal(workerCap.sandbox, "workspace-write");
    assert.equal(workerCap.readOnly, false);
    assert.ok(workerCap.allowedTools.includes("write_to_file"));
    assert.ok(workerCap.allowedTools.includes("replace_file_content"));

    const reviewerCap = CapabilityResolver.resolve("reviewer");
    assert.equal(reviewerCap.agentName, "reviewer");
    assert.equal(reviewerCap.modelSlug, "agy-default");
    assert.equal(reviewerCap.effort, "high");
    assert.equal(reviewerCap.readOnly, true);
  });

  it("Gate 1.3: Strict hook permits file mutation inside authorized OMA worktree and denies outside", () => {
    const worktreeFile = join(process.cwd(), ".oma", "worktrees", "task-101", "src", "math.ts");
    const mainWorkspaceFile = join(process.cwd(), "src", "math.ts");
    const protectedFile = join(process.cwd(), ".oma", "graph", "execution-graph.json");

    // 1. Mutation inside OMA worktree -> ALLOW
    const allowRes = evaluateStrictToolUse({
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: worktreeFile, CodeContent: "test" },
      },
      workspacePaths: [process.cwd()],
    });
    assert.equal(allowRes.decision, "allow");

    // 2. Mutation in main workspace outside worktree -> DENY
    const denyMainRes = evaluateStrictToolUse({
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: mainWorkspaceFile, CodeContent: "test" },
      },
      workspacePaths: [process.cwd()],
    });
    assert.equal(denyMainRes.decision, "deny");

    // 3. Mutation targeting protected control path -> DENY
    const denyProtRes = evaluateStrictToolUse({
      toolCall: {
        name: "write_to_file",
        args: { TargetFile: protectedFile, CodeContent: "test" },
      },
      workspacePaths: [process.cwd()],
    });
    assert.equal(denyProtRes.decision, "deny");
  });

  it("Gate 1.4: Driver builds normalized CLI arguments with model, effort, sandbox and schema", () => {
    const driver = new AgyDriver();
    const args = driver.buildCliArguments({
      contractPrompt: "Implement task A",
      persona: "worker",
      worktreeDir: join(process.cwd(), ".oma", "worktrees", "task-1"),
      timeoutMs: 30000,
      modelOverride: "gemini-2.5-flash",
      reasoningEffort: "high",
    });

    assert.ok(args.includes("-p"));
    assert.ok(args.includes("Implement task A"));
    assert.ok(args.includes("--agent"));
    assert.ok(args.includes("worker"));
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("gemini-2.5-flash"));
    assert.ok(args.includes("--effort"));
    assert.ok(args.includes("high"));
    assert.ok(args.includes("--output-format"));
    assert.ok(args.includes("json"));
  });

  it("Gate 1.5: Minimal lifecycle persistence produces durable receipt and projection restoration", () => {
    const testDir = join(process.cwd(), ".oma", "test-phase1-events");
    const eventsPath = join(testDir, "events.jsonl");
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });

    try {
      const missionId = "mission-phase1-transport";
      const wiId = generateDeterministicWorkItemId("src/parser.ts");
      const runId = generateDeterministicRunId(wiId, "worker", 1);

      // 1. mission_started
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "mission_started",
        workflowDigest: "digest-transport-v1",
        rulebookRevision: "rev-001",
        goal: "Validate MoE transport",
      });

      // 2. work_item_discovered
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "work_item_discovered",
        workItemId: wiId,
        title: "Implement Parser",
        scope: ["src/parser.ts"],
        dependsOn: [],
        roleRequired: "worker",
        acceptanceCriteria: ["parseExpression"],
      });

      // 3. run_started
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "run_started",
        runId,
        workItemId: wiId,
        expertId: "worker",
        model: "gemini-3.7-flash",
        effort: "medium",
      });

      // 4. artifact_created
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "artifact_created",
        runId,
        workItemId: wiId,
        artifactPath: "artifacts/diff-task-1.patch",
        artifactHash: "e".repeat(64),
        artifactKind: "diff",
      });

      // 5. run_finished
      MissionEventsStore.appendEvent(eventsPath, missionId, {
        type: "run_finished",
        runId,
        workItemId: wiId,
        expertId: "worker",
        status: "succeeded",
        durationMs: 1250,
      });

      const events = MissionEventsStore.readEvents(eventsPath);
      assert.equal(events.length, 5);

      const verification = MissionEventsStore.verifyEventChain(events);
      assert.equal(verification.valid, true);

      const projection = MissionEventsStore.projectMission(events);
      assert.equal(projection.missionId, missionId);
      assert.equal(projection.workItems.get(wiId)?.state, "reviewed");
      assert.equal(projection.runs.get(runId)?.status, "succeeded");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
