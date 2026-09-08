import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  ROUTING_SUCCESS_STATUSES,
  ROUTING_TOOL_DEFINITIONS,
  ROUTING_TOOL_NAMES,
  executePlanRoute,
  executeRoutingTool,
} from "../routing-tools.js";

test("T2.3: ROUTING_TOOL_DEFINITIONS advertises plan_route with correct schema", () => {
  assert.equal(ROUTING_TOOL_NAMES.has("plan_route"), true);
  assert.equal(ROUTING_SUCCESS_STATUSES.has("routed"), true);

  const def = ROUTING_TOOL_DEFINITIONS.find((t) => t.name === "plan_route");
  assert.ok(def);
  assert.equal(def.name, "plan_route");
  assert.ok(def.description.includes("canonical"));
  assert.equal(def.inputSchema.type, "object");
  assert.ok("mode" in def.inputSchema.properties);
  assert.deepEqual(def.inputSchema.required, ["mode"]);
});

test("T2.3: executePlanRoute() routes canonical modes correctly", () => {
  // 1. bugfix
  const bugfix = executePlanRoute({ mode: "bugfix" });
  assert.equal(bugfix.status, "routed");
  assert.equal(bugfix.mode, "bugfix");
  assert.equal(bugfix.requestedMode, "bugfix");
  assert.deepEqual(bugfix.roles, ["planner", "executor", "verifier"]);
  assert.equal(bugfix.modeConfig.sandbox, "workspace-write");
  assert.ok(bugfix.modeConfig.promptOverlay.includes("BUGFIX"));

  // 2. feature
  const feature = executePlanRoute({ mode: "feature" });
  assert.equal(feature.status, "routed");
  assert.equal(feature.mode, "feature");
  assert.deepEqual(feature.roles, [
    "planner",
    "explorer",
    "executor",
    "reviewer",
    "verifier",
  ]);
  assert.equal(feature.modeConfig.sandbox, "workspace-write");

  // 3. diagnostic
  const diagnostic = executePlanRoute({ mode: "diagnostic" });
  assert.equal(diagnostic.status, "routed");
  assert.equal(diagnostic.mode, "diagnostic");
  assert.deepEqual(diagnostic.roles, ["explorer", "reviewer"]);
  assert.equal(diagnostic.modeConfig.sandbox, "read-only");

  // 4. infra
  const infra = executePlanRoute({ mode: "infra" });
  assert.equal(infra.status, "routed");
  assert.equal(infra.mode, "infra");
  assert.deepEqual(infra.roles, ["planner", "executor", "verifier"]);
  assert.equal(infra.modeConfig.sandbox, "workspace-write");

  // 5. pm
  const pm = executePlanRoute({ mode: "pm" });
  assert.equal(pm.status, "routed");
  assert.equal(pm.mode, "pm");
  assert.deepEqual(pm.roles, ["planner", "orchestrator"]);
  assert.equal(pm.modeConfig.sandbox, "read-only");
});

test("T2.3: executePlanRoute() routes aliases to canonical modes", () => {
  const debug = executePlanRoute({ mode: "debug" });
  assert.equal(debug.status, "routed");
  assert.equal(debug.mode, "bugfix");
  assert.equal(debug.requestedMode, "debug");
  assert.deepEqual(debug.roles, ["planner", "executor", "verifier"]);

  const refactor = executePlanRoute({ mode: "refactor" });
  assert.equal(refactor.status, "routed");
  assert.equal(refactor.mode, "feature");
  assert.equal(refactor.requestedMode, "refactor");

  const review = executePlanRoute({ mode: "review" });
  assert.equal(review.status, "routed");
  assert.equal(review.mode, "diagnostic");
  assert.equal(review.requestedMode, "review");

  const pmAlias = executePlanRoute({ mode: "project-management" });
  assert.equal(pmAlias.status, "routed");
  assert.equal(pmAlias.mode, "pm");
  assert.equal(pmAlias.requestedMode, "project-management");

  const explore = executePlanRoute({ mode: "exploration" });
  assert.equal(explore.status, "routed");
  assert.equal(explore.mode, "exploration");
  assert.deepEqual(explore.roles, ["planner", "explorer"]);
});

test("T2.3: executePlanRoute() respects custom promptOverlay and extraGates", () => {
  const customGate = {
    id: "security-scan",
    program: "npm",
    args: ["audit"],
    timeoutMs: 15000,
  };
  const result = executePlanRoute({
    mode: "bugfix",
    promptOverlay: "Emergency hotfix mode enabled.",
    extraGates: [customGate],
  });

  assert.equal(result.status, "routed");
  assert.equal(result.mode, "bugfix");
  assert.equal(result.modeConfig.promptOverlay, "Emergency hotfix mode enabled.");
  assert.deepEqual(result.modeConfig.extraGates, [customGate]);
});

test("T2.3: executeRoutingTool() executes plan_route and rejects unknown tools", () => {
  const routed = executeRoutingTool("plan_route", { mode: "infra" });
  assert.equal(routed.status, "routed");
  assert.equal(routed.mode, "infra");

  assert.throws(
    () => executeRoutingTool("non_existent_tool", { mode: "infra" }),
    /Unknown routing tool/u,
  );
});

test("T2.3: executePlanRoute() validates input and throws on invalid arguments", () => {
  assert.throws(() => executePlanRoute(null), /plan_route requires a non-empty 'mode' string/u);
  assert.throws(() => executePlanRoute({}), /plan_route requires a non-empty 'mode' string/u);
  assert.throws(
    () => executePlanRoute({ mode: "" }),
    /plan_route requires a non-empty 'mode' string/u,
  );
  assert.throws(
    () => executePlanRoute({ mode: "   " }),
    /plan_route requires a non-empty 'mode' string/u,
  );
  assert.throws(
    () => executePlanRoute({ mode: 123 }),
    /plan_route requires a non-empty 'mode' string/u,
  );
  assert.throws(
    () => executePlanRoute({ mode: "bugfix", promptOverlay: 123 }),
    /plan_route 'promptOverlay' must be a string/u,
  );
  assert.throws(
    () => executePlanRoute({ mode: "bugfix", sandbox: "root" }),
    /plan_route 'sandbox' must be either 'workspace-write' or 'read-only'/u,
  );
  assert.throws(
    () => executePlanRoute({ mode: "bugfix", extraGates: "not-an-array" }),
    /plan_route 'extraGates' must be an array/u,
  );
  assert.throws(
    () => executePlanRoute({ mode: "bugfix", extraGates: [{}] }),
    /must be an object with non-empty 'id' and 'program'/u,
  );
  assert.throws(
    () => executePlanRoute({ mode: "bugfix", extraGates: [{ id: "g1", program: "p1", args: [123] }] }),
    /args' must be an array of strings/u,
  );
});

test("T2.3: executePlanRoute() supports sandbox override and prototype collision modes", () => {
  const customSandbox = executePlanRoute({ mode: "bugfix", sandbox: "read-only" });
  assert.equal(customSandbox.status, "routed");
  assert.equal(customSandbox.mode, "bugfix");
  assert.equal(customSandbox.modeConfig.sandbox, "read-only");

  // Prototype keys as mode:
  const ctor = executePlanRoute({ mode: "constructor" });
  assert.equal(ctor.status, "routed");
  assert.equal(ctor.mode, "feature");
  assert.deepEqual(ctor.roles, ["planner", "explorer", "executor", "reviewer", "verifier"]);

  const proto = executePlanRoute({ mode: "__proto__" });
  assert.equal(proto.status, "routed");
  assert.equal(proto.mode, "feature");
});
