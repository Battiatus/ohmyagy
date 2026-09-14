import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "bun:test";
import { handleRequest, type BrokerConfig } from "../../mcp/broker-server.js";
import { MissionJournal } from "../../ledger/mission-journal.js";
import type { GraphNode } from "../../graph/model.js";
import { assertInterviewAuthorisesExecution, recordInterview } from "../interview-gate.js";

/**
 * The interview gate as a contract.
 *
 * The requirement is unambiguous: **no run and no execution before the user has answered
 * and confirmed.** It used to live only as prose in the `oma-start` skill, and the test
 * that "proved" it asserted a regular expression against that Markdown — while
 * `ask_question` did not exist as a tool at all. A conductor could create a graph and
 * dispatch a node without asking anything, and nothing noticed.
 *
 * These tests drive the real MCP tool surface, so they fail if the gate stops being
 * consulted — not merely if its implementation changes.
 */

let root: string;
let config: BrokerConfig;
let journal: MissionJournal;
let stagedRecords: Map<string, never>;

function callTool(
  name: string,
  args: Record<string, unknown>,
): { structured: Record<string, unknown>; isError: boolean } {
  const response = handleRequest(
    config,
    journal,
    stagedRecords as Map<string, never>,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  );
  const result = response.result as Record<string, unknown>;
  return {
    structured: result.structuredContent as Record<string, unknown>,
    isError: Boolean(result.isError),
  };
}

function deliverableNode(): GraphNode {
  return {
    id: "work",
    title: "Real deliverable",
    kind: "agent",
    activation: "all",
    completionAuthority: "broker",
    completionAuthorityId: "oma-broker",
    executor: { adapter: "agy", persona: "executor" },
    scope: ["src/index.ts"],
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oma-interview-gate-"));
  config = { workspaceRoot: root, gates: [], missionId: "test-mission" };
  journal = new MissionJournal("test-mission", "code-change", {
    journalStorePath: join(root, ".oma", "ledger", "events.jsonl"),
  });
  stagedRecords = new Map();
});

afterEach(() => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(20);
    }
  }
});

describe("the interview gate blocks execution until the user confirms", () => {
  it("does not record an interview the user never answered", () => {
    assert.throws(
      () =>
        recordInterview({
          workspaceRoot: root,
          missionId: "m-empty-answers",
          questions: ["Which database is authoritative?"],
          answers: [],
          confirmed: true,
        }),
      /cannot authorise execution/u,
    );
    assert.throws(
      () =>
        recordInterview({
          workspaceRoot: root,
          missionId: "m-empty-questions",
          questions: [],
          answers: ["BigQuery"],
          confirmed: true,
        }),
      /at least one non-empty question/u,
    );
    assert.throws(
      () => assertInterviewAuthorisesExecution({ workspaceRoot: root, missionId: "m-empty-answers" }),
      /no recorded interview/u,
    );
  });

  it("refuses to drive a mission that was never interviewed", () => {
    const init = callTool("graph_init", { missionId: "m-never-asked", goal: "g" });
    assert.equal(init.isError, false);

    const step = callTool("converge_step", { missionId: "m-never-asked" });
    assert.equal(step.isError, true, "the loop must not advance without an interview");
    assert.match(JSON.stringify(step.structured), /no recorded interview/u);
  });

  it("refuses a mission whose interview the user never confirmed", () => {
    callTool("graph_init", { missionId: "m-unconfirmed", goal: "g" });
    recordInterview({
      workspaceRoot: root,
      missionId: "m-unconfirmed",
      questions: ["Which scope?"],
      answers: ["Backend only."],
      confirmed: false,
    });

    const step = callTool("converge_step", { missionId: "m-unconfirmed" });
    assert.equal(step.isError, true, "asking is not confirmation");
    assert.match(JSON.stringify(step.structured), /never confirmed/u);
  });

  it("refuses to dispatch a node before the interview", () => {
    callTool("graph_init", {
      missionId: "m-no-dispatch",
      goal: "g",
      nodes: [deliverableNode()],
      edges: [],
    });

    const marked = callTool("graph_mark_node", { nodeId: "work", state: "running" });
    assert.equal(marked.isError, true);
    assert.match(JSON.stringify(marked.structured), /no recorded interview/u);
  });

  it("authorises the loop and the dispatch once the user answered and confirmed", () => {
    callTool("graph_init", {
      missionId: "m-confirmed",
      goal: "g",
      nodes: [deliverableNode()],
      edges: [],
    });

    const recorded = callTool("record_interview", {
      missionId: "m-confirmed",
      questions: ["What proves the databases are synchronised?"],
      answers: ["A job run that reconciles both stores, with its log."],
      confirmed: true,
    });
    assert.equal(recorded.isError, false, JSON.stringify(recorded.structured));
    assert.equal(recorded.structured.status, "interview_recorded");
    assert.equal(recorded.structured.confirmed, true);
    assert.equal(recorded.structured.blocking, null);

    const marked = callTool("graph_mark_node", { nodeId: "work", state: "running" });
    assert.equal(marked.isError, false, JSON.stringify(marked.structured));

    const step = callTool("converge_step", { missionId: "m-confirmed" });
    assert.equal(step.isError, false, JSON.stringify(step.structured));
  });

  it("keeps execution blocked when confirmation is recorded later without it", () => {
    callTool("graph_init", { missionId: "m-two-step", goal: "g" });
    callTool("record_interview", {
      missionId: "m-two-step",
      questions: ["Is the scope right?"],
      answers: ["Yes."],
      confirmed: false,
    });
    assert.equal(callTool("converge_step", { missionId: "m-two-step" }).isError, true);

    callTool("record_interview", {
      missionId: "m-two-step",
      questions: ["Is the scope right?"],
      answers: ["Yes."],
      confirmed: true,
    });
    assert.equal(callTool("converge_step", { missionId: "m-two-step" }).isError, false);
  });
});
