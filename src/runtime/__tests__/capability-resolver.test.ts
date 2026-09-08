import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  CapabilityResolver,
  ROLE_ALIASES,
  type VisionRole,
} from "../capability-resolver.js";

describe("CapabilityResolver & VisionRole (T1.1 - T1.3)", () => {
  it("T1.1 & T1.8: defines VisionRole and exports ROLE_ALIASES", () => {
    const roles: VisionRole[] = [
      "orchestrator",
      "planner",
      "explorer",
      "executor",
      "reviewer",
      "verifier",
    ];
    assert.equal(roles.length, 6);
    assert.equal(ROLE_ALIASES.worker, "executor");
    assert.equal(ROLE_ALIASES.orchestrator, "session");
  });

  it("T1.2 & T1.8: includes explorer, verifier, and canonical executor in CORE_EXPERTS with aliases", () => {
    const executor = CapabilityResolver.CORE_EXPERTS.executor;
    assert.ok(executor, "executor must be canonical in CORE_EXPERTS");
    assert.equal(executor.id, "executor");
    assert.equal(executor.role, "executor");
    assert.equal(executor.readOnly, false);

    const workerAlias = CapabilityResolver.CORE_EXPERTS.worker;
    assert.ok(workerAlias, "worker alias must resolve from CORE_EXPERTS");
    assert.equal(workerAlias.id, "executor");

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

  it("T1.3 & T1.8: resolve() accepts VisionRole and is backwards-compatible: resolve('executor') ≡ resolve('worker')", () => {
    const executorRes = CapabilityResolver.resolve("executor" as VisionRole);
    const workerRes = CapabilityResolver.resolve("worker");

    assert.equal(executorRes.expertId, "executor");
    assert.equal(workerRes.expertId, "executor");
    assert.equal(executorRes.agentName, "executor");
    assert.equal(workerRes.agentName, "worker");
    assert.equal(executorRes.sandbox, workerRes.sandbox);
    assert.equal(executorRes.readOnly, workerRes.readOnly);
    assert.deepEqual(executorRes.allowedTools, workerRes.allowedTools);
    assert.equal(executorRes.modelSlug, workerRes.modelSlug);
    assert.equal(executorRes.effort, workerRes.effort);
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

  it("resolves orchestrator canonical role and session alias", () => {
    const orch = CapabilityResolver.CORE_EXPERTS.orchestrator;
    assert.ok(orch, "orchestrator must be in CORE_EXPERTS");
    assert.equal(orch.role, "orchestrator");
    assert.equal(orch.readOnly, true);

    const resolvedOrch = CapabilityResolver.resolve("orchestrator");
    assert.equal(resolvedOrch.expertId, "orchestrator");
    assert.equal(resolvedOrch.agentName, "orchestrator");
    assert.equal(resolvedOrch.readOnly, true);

    const resolvedSession = CapabilityResolver.resolve("session");
    assert.equal(resolvedSession.expertId, "orchestrator");
  });

  it("normalizes expert.role worker to executor when ExpertSpec object is passed", () => {
    const customWorkerSpec = {
      id: "custom-worker",
      role: "worker" as const,
      taskKinds: ["implementation"],
      modelClass: "balanced" as const,
      effort: "medium" as const,
      tools: ["view_file", "write_to_file"],
      readOnly: false,
    };
    const resolved = CapabilityResolver.resolve(customWorkerSpec);
    assert.equal(resolved.expertId, "custom-worker");
    assert.equal(resolved.agentName, "custom-worker");
    assert.equal(resolved.readOnly, false);
  });
});
