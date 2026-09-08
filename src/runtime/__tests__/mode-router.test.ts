import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  CANONICAL_MODES,
  CANONICAL_ROLE_TOPOLOGIES,
  CANONICAL_MODE_CONFIGS,
  MODE_ALIASES,
  configForMode,
  normalizeMode,
  rolesForMode,
  type MissionMode,
} from "../mode-router.js";
import type { VisionRole } from "../capability-resolver.js";

test("T2.1: CANONICAL_MODES defines the 5 canonical modes", () => {
  assert.deepEqual([...CANONICAL_MODES], ["bugfix", "feature", "diagnostic", "infra", "pm"]);
});

test("T2.1: rolesForMode() returns expected canonical role topologies", () => {
  // 1. bugfix -> [planner, executor, verifier]
  assert.deepEqual(rolesForMode("bugfix"), ["planner", "executor", "verifier"]);

  // 2. feature -> [planner, explorer, executor, reviewer, verifier]
  assert.deepEqual(rolesForMode("feature"), [
    "planner",
    "explorer",
    "executor",
    "reviewer",
    "verifier",
  ]);

  // 3. diagnostic -> [explorer, reviewer]
  assert.deepEqual(rolesForMode("diagnostic"), ["explorer", "reviewer"]);

  // 4. infra -> [planner, executor, verifier]
  assert.deepEqual(rolesForMode("infra"), ["planner", "executor", "verifier"]);

  // 5. pm -> [planner, orchestrator]
  assert.deepEqual(rolesForMode("pm"), ["planner", "orchestrator"]);
});

test("T2.1: rolesForMode() normalizes aliases and alternative modes", () => {
  // debug -> bugfix
  assert.deepEqual(rolesForMode("debug"), ["planner", "executor", "verifier"]);

  // refactor -> feature
  assert.deepEqual(rolesForMode("refactor"), [
    "planner",
    "explorer",
    "executor",
    "reviewer",
    "verifier",
  ]);

  // review / post-mortem -> diagnostic
  assert.deepEqual(rolesForMode("review"), ["explorer", "reviewer"]);
  assert.deepEqual(rolesForMode("post-mortem"), ["explorer", "reviewer"]);

  // project-management -> pm
  assert.deepEqual(rolesForMode("project-management"), ["planner", "orchestrator"]);

  // exploration -> [planner, explorer]
  assert.deepEqual(rolesForMode("exploration"), ["planner", "explorer"]);
});

test("T2.1: rolesForMode() handles case, whitespace, and safe fallback for unknown modes", () => {
  assert.deepEqual(rolesForMode("  BUGFIX  "), ["planner", "executor", "verifier"]);
  assert.deepEqual(rolesForMode("Feature"), [
    "planner",
    "explorer",
    "executor",
    "reviewer",
    "verifier",
  ]);
  assert.deepEqual(rolesForMode("DIAGNOSTIC"), ["explorer", "reviewer"]);

  // Empty or invalid input falls back safely to feature
  assert.deepEqual(rolesForMode(""), [
    "planner",
    "explorer",
    "executor",
    "reviewer",
    "verifier",
  ]);
  assert.deepEqual(rolesForMode("unknown-custom-mode"), [
    "planner",
    "explorer",
    "executor",
    "reviewer",
    "verifier",
  ]);
});

test("T2.1: rolesForMode() returns a fresh mutable copy (immutability)", () => {
  const roles1 = rolesForMode("bugfix");
  roles1.push("reviewer" as VisionRole);
  const roles2 = rolesForMode("bugfix");
  assert.deepEqual(roles2, ["planner", "executor", "verifier"]);
});

test("T2.1: normalizeMode() resolves aliases and fallbacks cleanly", () => {
  assert.equal(normalizeMode("debug"), "bugfix");
  assert.equal(normalizeMode("refactor"), "feature");
  assert.equal(normalizeMode("review"), "diagnostic");
  assert.equal(normalizeMode("post-mortem"), "diagnostic");
  assert.equal(normalizeMode("project-management"), "pm");
  assert.equal(normalizeMode("exploration"), "exploration");
  assert.equal(normalizeMode("bugfix"), "bugfix");
  assert.equal(normalizeMode("feature"), "feature");
  assert.equal(normalizeMode("diagnostic"), "diagnostic");
  assert.equal(normalizeMode("infra"), "infra");
  assert.equal(normalizeMode("pm"), "pm");
  assert.equal(normalizeMode("unknown"), "feature");
  assert.equal(normalizeMode(""), "feature");
});

test("T2.2: configForMode() provides deterministic ModeConfig with proper sandbox", () => {
  // bugfix: write sandbox
  const bugfixConfig = configForMode("bugfix");
  assert.equal(bugfixConfig.mode, "bugfix");
  assert.equal(bugfixConfig.sandbox, "workspace-write");
  assert.ok(bugfixConfig.promptOverlay.includes("BUGFIX"));
  assert.ok(bugfixConfig.rolePromptOverlays?.executor);
  assert.deepEqual(bugfixConfig.extraGates, []);

  // feature: write sandbox
  const featureConfig = configForMode("feature");
  assert.equal(featureConfig.mode, "feature");
  assert.equal(featureConfig.sandbox, "workspace-write");
  assert.ok(featureConfig.promptOverlay.includes("FEATURE"));
  assert.ok(featureConfig.rolePromptOverlays?.reviewer);

  // diagnostic: read-only sandbox
  const diagConfig = configForMode("diagnostic");
  assert.equal(diagConfig.mode, "diagnostic");
  assert.equal(diagConfig.sandbox, "read-only");
  assert.ok(diagConfig.promptOverlay.includes("DIAGNOSTIC"));
  assert.ok(diagConfig.promptOverlay.includes("read-only"));

  // infra: write sandbox
  const infraConfig = configForMode("infra");
  assert.equal(infraConfig.mode, "infra");
  assert.equal(infraConfig.sandbox, "workspace-write");
  assert.ok(infraConfig.promptOverlay.includes("INFRASTRUCTURE"));

  // pm: read-only sandbox
  const pmConfig = configForMode("pm");
  assert.equal(pmConfig.mode, "pm");
  assert.equal(pmConfig.sandbox, "read-only");
  assert.ok(pmConfig.promptOverlay.includes("PROJECT MANAGEMENT"));

  // exploration: read-only sandbox
  const exploreConfig = configForMode("exploration");
  assert.equal(exploreConfig.mode, "exploration");
  assert.equal(exploreConfig.sandbox, "read-only");
  assert.ok(exploreConfig.promptOverlay.includes("EXPLORATION"));
});

test("T2.2: configForMode() maps aliases to canonical configs", () => {
  const debugConfig = configForMode("debug");
  assert.equal(debugConfig.mode, "bugfix");
  assert.equal(debugConfig.sandbox, "workspace-write");

  const reviewConfig = configForMode("review");
  assert.equal(reviewConfig.mode, "diagnostic");
  assert.equal(reviewConfig.sandbox, "read-only");

  const pmAliasConfig = configForMode("project-management");
  assert.equal(pmAliasConfig.mode, "pm");
  assert.equal(pmAliasConfig.sandbox, "read-only");
});

test("T2.2: configForMode() merges custom overrides cleanly", () => {
  const customGate = {
    id: "lint-gate",
    program: "npm",
    args: ["run", "lint"],
    timeoutMs: 5000,
  };
  const overridden = configForMode("bugfix", {
    promptOverlay: "Custom prompt overlay",
    extraGates: [customGate],
    sandbox: "read-only",
  });

  assert.equal(overridden.mode, "bugfix");
  assert.equal(overridden.promptOverlay, "Custom prompt overlay");
  assert.equal(overridden.sandbox, "read-only");
  assert.deepEqual(overridden.extraGates, [customGate]);
  // Keeps original role overlays when not overridden
  assert.ok(overridden.rolePromptOverlays?.executor);
});

test("T2.1: prototype collision strings do not throw and fall back safely to feature", () => {
  const prototypeCollisionKeys = [
    "constructor",
    "__proto__",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
  ];

  for (const key of prototypeCollisionKeys) {
    // 1. normalizeMode must fall back to 'feature' string without returning prototype methods
    const normalized = normalizeMode(key);
    assert.equal(normalized, "feature");

    // 2. rolesForMode must not throw TypeError and must return feature roles
    const roles = rolesForMode(key);
    assert.deepEqual(roles, [
      "planner",
      "explorer",
      "executor",
      "reviewer",
      "verifier",
    ]);

    // 3. configForMode must safely return feature config with mode === 'feature'
    const config = configForMode(key);
    assert.equal(config.mode, "feature");
    assert.equal(config.sandbox, "workspace-write");
  }
});

test("T2.1: extended aliases (fix, snake_case, explore) map to canonical modes", () => {
  assert.equal(normalizeMode("fix"), "bugfix");
  assert.deepEqual(rolesForMode("fix"), ["planner", "executor", "verifier"]);

  assert.equal(normalizeMode("bug_fix"), "bugfix");
  assert.deepEqual(rolesForMode("bug_fix"), ["planner", "executor", "verifier"]);

  assert.equal(normalizeMode("bug-fix"), "bugfix");
  assert.deepEqual(rolesForMode("bug-fix"), ["planner", "executor", "verifier"]);

  assert.equal(normalizeMode("postmortem"), "diagnostic");
  assert.deepEqual(rolesForMode("postmortem"), ["explorer", "reviewer"]);

  assert.equal(normalizeMode("post_mortem"), "diagnostic");
  assert.deepEqual(rolesForMode("post_mortem"), ["explorer", "reviewer"]);

  assert.equal(normalizeMode("project_management"), "pm");
  assert.deepEqual(rolesForMode("project_management"), ["planner", "orchestrator"]);

  assert.equal(normalizeMode("projectmanagement"), "pm");
  assert.deepEqual(rolesForMode("projectmanagement"), ["planner", "orchestrator"]);
});

test("T2.2: configForMode() deduplicates extraGates by id", () => {
  const initialGate = {
    id: "gate-a",
    program: "npm",
    args: ["test"],
    timeoutMs: 1000,
  };
  const replacementGate = {
    id: "gate-a",
    program: "bun",
    args: ["test"],
    timeoutMs: 2000,
  };
  const secondGate = {
    id: "gate-b",
    program: "node",
    args: ["--version"],
    timeoutMs: 500,
  };

  const baseWithGate = configForMode("bugfix", {
    extraGates: [initialGate],
  });
  assert.deepEqual(baseWithGate.extraGates, [initialGate]);

  // Override gate-a and add gate-b
  const overridden = configForMode("bugfix", {
    extraGates: [replacementGate, secondGate],
  });
  assert.deepEqual(overridden.extraGates, [replacementGate, secondGate]);
});
