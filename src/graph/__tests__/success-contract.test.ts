import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeGraphInit,
  executeGraphInspect,
  executeGraphMarkNode,
} from "../../mcp/graph-tools.js";
import { executeConvergeStep } from "../../mcp/orchestration-tools.js";

/**
 * Regression guard for the success contract.
 *
 * Before this, three separate paths let OMA declare victory with no delivered
 * work. All three were reproduced on the real broker by
 * docs/audits/2026-09-10-oma/probe.mjs, and one of them was observed again in a
 * live AntiGravity IDE run: right after `graph_init`, `graph_inspect` answered
 * `graphStatus: "succeeded"` with a single synthetic `bootstrap` node and 100%
 * progress.
 */

/** A node that represents real requested work, unlike the engine-seeded bootstrap. */
const DELIVERABLE_NODE = {
  id: "work",
  title: "Real deliverable",
  kind: "agent",
  activation: "all",
  completionAuthority: "broker",
  completionAuthorityId: "oma-broker",
  executor: { adapter: "antigravity", persona: "oma-explorer" },
};

function withWorkspace(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "oma-success-"));
  try {
    body(root);
  } finally {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        Bun.sleepSync(25);
      }
    }
  }
}

describe("success contract: no victory without delivered work", () => {
  test("graph_init alone declares no deliverable and cannot be succeeded", () => {
    withWorkspace((root) => {
      const init = executeGraphInit(root, { goal: "Audit something" });
      assert.equal(init.deliverableNodes, 0);
      assert.equal(init.requiresPlan, true, "a bare init must ask for a plan");

      const inspect = executeGraphInspect(root);
      assert.notEqual(
        inspect.graphStatus,
        "succeeded",
        "one synthetic bootstrap node must not make the graph a success",
      );

      const step = executeConvergeStep(root, { currentRound: 1 });
      assert.notEqual(step.status, "succeeded");
      assert.equal(step.status, "in_progress");
    });
  });

  test("the bootstrap seed is projected as synthetic, real nodes are not", () => {
    withWorkspace((root) => {
      executeGraphInit(root, { goal: "g" });
      const inspect = executeGraphInspect(root);
      const projection = inspect.projection as { nodes: Array<{ id: string; synthetic: boolean }> };
      const bootstrap = projection.nodes.find((node) => node.id === "bootstrap");
      assert.equal(bootstrap?.synthetic, true);
    });
  });

  test("isIntegrated can veto but can never force success", () => {
    withWorkspace((root) => {
      executeGraphInit(root, { goal: "g", nodes: [DELIVERABLE_NODE], edges: [] });
      // `work` has no incoming edge, so it is ready and nothing is delivered.
      const step = executeConvergeStep(root, { isIntegrated: true, currentRound: 1 });
      assert.notEqual(
        step.status,
        "succeeded",
        "a caller assertion must not short-circuit the evidence",
      );
      assert.equal(step.status, "in_progress");
    });
  });

  test("a converged graph with a delivered node DOES succeed (positive control)", () => {
    withWorkspace((root) => {
      executeGraphInit(root, { goal: "g", nodes: [DELIVERABLE_NODE], edges: [] });
      executeGraphMarkNode(root, { nodeId: "work", state: "succeeded" });

      const inspect = executeGraphInspect(root);
      assert.equal(inspect.graphStatus, "succeeded");

      const step = executeConvergeStep(root, { currentRound: 1 });
      assert.equal(step.status, "succeeded");
      assert.match(String(step.diagnosis), /delivered work item/);
    });
  });

  test("work-item counters come from the graph, not from the caller", () => {
    withWorkspace((root) => {
      executeGraphInit(root, { goal: "g", nodes: [DELIVERABLE_NODE], edges: [] });
      executeGraphMarkNode(root, { nodeId: "work", state: "succeeded" });

      // The caller lies: it claims nothing was accepted. The graph disagrees, and
      // the graph wins.
      const step = executeConvergeStep(root, {
        currentRound: 1,
        currentProgress: {
          visibleTestsPassed: 0,
          visibleTestsFailing: 0,
          acceptedWorkItems: 0,
          totalWorkItems: 999,
        },
      });
      const progress = step.progress as { acceptedWorkItems: number; totalWorkItems: number };
      assert.notEqual(progress.totalWorkItems, 999, "the caller must not own work-item totals");
      assert.ok(progress.acceptedWorkItems >= 1);
    });
  });

  test("a mission that does not own the graph is refused, not reported successful", () => {
    withWorkspace((root) => {
      executeGraphInit(root, { goal: "g", missionId: "mission-owner" });
      assert.throws(
        () => executeConvergeStep(root, { missionId: "unrelated-mission" }),
        /does not own the workspace execution graph/,
      );
    });
  });
});
