import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  CapabilityResolver,
  ROLE_ALIASES,
  type VisionRole,
} from "../capability-resolver.js";

describe("CapabilityResolver & VisionRole (T1.1 - T1.3)", () => {
  it("T1.1: defines VisionRole and exports ROLE_ALIASES", () => {
    const roles: VisionRole[] = [
      "orchestrator",
      "planner",
      "explorer",
      "executor",
      "reviewer",
      "verifier",
    ];
    assert.equal(roles.length, 6);
    assert.equal(ROLE_ALIASES.executor, "worker");
    assert.equal(ROLE_ALIASES.orchestrator, "session");
  });

  it("T1.2: includes explorer and verifier in CORE_EXPERTS with readOnly: true", () => {
    const explorer = CapabilityResolver.CORE_EXPERTS.explorer;
    assert.ok(explorer, "explorer must be present in CORE_EXPERTS");
    assert.equal(explorer.readOnly, true);
    assert.ok(explorer.tools.includes("view_file"));
    assert.ok(!explorer.tools.includes("write_to_file"));

    const verifier = CapabilityResolver.CORE_EXPERTS.verifier;
    assert.ok(verifier, "verifier must be present in CORE_EXPERTS");
    assert.equal(verifier.readOnly, true);
    assert.ok(verifier.tools.includes("run_command"));
    assert.ok(!verifier.tools.includes("write_to_file"));

    const resolvedExplorer = CapabilityResolver.resolve("explorer");
    assert.equal(resolvedExplorer.expertId, "explorer");
    assert.equal(resolvedExplorer.sandbox, "read-only");
    assert.equal(resolvedExplorer.readOnly, true);

    const resolvedVerifier = CapabilityResolver.resolve("verifier");
    assert.equal(resolvedVerifier.expertId, "verifier");
    assert.equal(resolvedVerifier.sandbox, "read-only");
    assert.equal(resolvedVerifier.readOnly, true);
  });

  it("T1.3: resolve() accepts VisionRole and is backwards-compatible: resolve('executor') ≡ resolve('worker')", () => {
    const executorRes = CapabilityResolver.resolve("executor" as VisionRole);
    const workerRes = CapabilityResolver.resolve("worker");

    assert.deepEqual(
      executorRes,
      workerRes,
      "resolve('executor') must be structurally equivalent to resolve('worker')",
    );
    assert.equal(executorRes.sandbox, "workspace-write");
    assert.equal(executorRes.readOnly, false);
    assert.ok(executorRes.allowedTools.includes("write_to_file"));
  });

  it("resolve() respects custom model and effort overrides", () => {
    const custom = CapabilityResolver.resolve("explorer", {
      modelOverride: "custom-gemini",
      effortOverride: "high",
    });
    assert.equal(custom.modelSlug, "custom-gemini");
    assert.equal(custom.effort, "high");
    assert.equal(custom.sandbox, "read-only");
  });
});
