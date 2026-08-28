import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectGraph } from "../kernel.js";
import { parseExecutionGraph } from "../model.js";
import {
  appendGraphTransition,
  initializeGraphStore,
  loadGraphRuntime,
  verifyGraphStore,
} from "../store.js";

test("produces a deterministic fan-out ready set and waits for fan-in", () => {
  const fixture = createFixture(fanGraph());
  try {
    const runtime = initializeGraphStore(fixture.root);
    assert.deepEqual(project(runtime).readySet, ["contract"]);
    dispatch(runtime, "contract", "d-contract");
    complete(runtime, "contract", "d-contract", "success", "human", "user");
    assert.deepEqual(project(runtime).readySet, ["analysis", "implementation"]);

    dispatch(runtime, "analysis", "d-analysis");
    dispatch(runtime, "implementation", "d-implementation");
    complete(runtime, "analysis", "d-analysis", "success", "broker", "oma-broker");
    assert.equal(nodeState(runtime, "join"), "blocked");
    complete(
      runtime,
      "implementation",
      "d-implementation",
      "success",
      "broker",
      "oma-broker",
    );
    assert.deepEqual(project(runtime).readySet, ["join"]);
    dispatch(runtime, "join", "d-join");
    complete(runtime, "join", "d-join", "success", "scheduler", "oma-scheduler");
    assert.deepEqual(project(runtime).readySet, ["validation"]);
  } finally {
    fixture.cleanup();
  }
});

test("routes failure through explicit edges and skips the success branch", () => {
  const fixture = createFixture(branchGraph());
  try {
    const runtime = initializeGraphStore(fixture.root);
    dispatch(runtime, "work", "d-work");
    complete(runtime, "work", "d-work", "failure", "broker", "oma-broker");
    const projection = project(runtime);
    assert.deepEqual(projection.readySet, ["diagnostic"]);
    assert.equal(projection.nodes.find((node) => node.id === "publish")?.state, "skipped");
  } finally {
    fixture.cleanup();
  }
});

test("forbids LLM self-approval, duplicate dispatch and implicit retries", () => {
  const fixture = createFixture(singleAgentGraph());
  try {
    const runtime = initializeGraphStore(fixture.root);
    dispatch(runtime, "agent", "d-agent");
    assert.throws(
      () => complete(runtime, "agent", "d-agent", "success", "human", "model"),
      /requires broker completion authority/iu,
    );
    assert.throws(
      () => dispatch(runtime, "agent", "d-agent-duplicate"),
      /running, not ready/iu,
    );
    complete(runtime, "agent", "d-agent", "failure", "broker", "oma-broker");
    assert.throws(
      () => dispatch(runtime, "agent", "d-agent-retry"),
      /failed, not ready/iu,
    );
    assert.equal(project(runtime).status, "failed");
  } finally {
    fixture.cleanup();
  }
});

test("replays identically regardless of node declaration order", () => {
  const first = parseExecutionGraph(fanGraph());
  const reversedRaw = fanGraph();
  reversedRaw.nodes.reverse();
  reversedRaw.edges.reverse();
  const second = parseExecutionGraph(reversedRaw);
  assert.deepEqual(projectGraph(first, []), projectGraph(second, []));
});

test("rejects cycles, self-loops, unknown nodes and hidden fields", () => {
  const cycle = fanGraph();
  cycle.edges.push({ id: "cycle", from: "validation", to: "contract", when: "success" });
  assert.throws(() => parseExecutionGraph(cycle), /cycle/iu);

  const selfLoop = singleAgentGraph();
  selfLoop.edges.push({ id: "self", from: "agent", to: "agent", when: "failure" });
  assert.throws(() => parseExecutionGraph(selfLoop), /self-loop/iu);

  const unknown = singleAgentGraph();
  unknown.edges.push({ id: "unknown", from: "agent", to: "missing", when: "success" });
  assert.throws(() => parseExecutionGraph(unknown), /unknown node/iu);

  const hidden = singleAgentGraph() as unknown as Record<string, unknown>;
  hidden.loopUntilDone = true;
  assert.throws(() => parseExecutionGraph(hidden), /unexpected fields/iu);
});

test("detects event tampering and graph revision drift", () => {
  const fixture = createFixture(singleAgentGraph());
  try {
    let runtime = initializeGraphStore(fixture.root);
    dispatch(runtime, "agent", "d-agent");
    const original = readFileSync(runtime.paths.events, "utf8");
    writeFileSync(runtime.paths.events, original.replace("oma-scheduler", "fake-scheduler"), "utf8");
    assert.equal(verifyGraphStore(runtime).valid, false);

    writeFileSync(runtime.paths.events, original, "utf8");
    const definition = JSON.parse(readFileSync(runtime.paths.definition, "utf8")) as {
      revision: number;
    };
    definition.revision = 2;
    writeFileSync(runtime.paths.definition, JSON.stringify(definition, null, 2), "utf8");
    runtime = loadGraphRuntime(fixture.root);
    assert.equal(verifyGraphStore(runtime).valid, false);
    assert.match(verifyGraphStore(runtime).errors.join("\n"), /Graph identity mismatch/iu);
  } finally {
    fixture.cleanup();
  }
});

function createFixture(graph: ReturnType<typeof fanGraph>) {
  const root = mkdtempSync(join(tmpdir(), "oma-graph-"));
  const graphDir = join(root, ".oma", "graph");
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, "execution-graph.json"), JSON.stringify(graph, null, 2), "utf8");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function project(runtime: ReturnType<typeof loadGraphRuntime>) {
  const verification = verifyGraphStore(runtime);
  assert.equal(verification.valid, true, verification.errors.join("\n"));
  return projectGraph(runtime.graph, verification.events);
}

function nodeState(runtime: ReturnType<typeof loadGraphRuntime>, nodeId: string) {
  return project(runtime).nodes.find((node) => node.id === nodeId)?.state;
}

function dispatch(
  runtime: ReturnType<typeof loadGraphRuntime>,
  nodeId: string,
  dispatchId: string,
) {
  return appendGraphTransition(runtime, {
    eventType: "node_dispatched",
    nodeId,
    dispatchId,
    authorityId: "oma-scheduler",
  });
}

function complete(
  runtime: ReturnType<typeof loadGraphRuntime>,
  nodeId: string,
  dispatchId: string,
  outcome: "success" | "failure",
  authority: "broker" | "oracle" | "scheduler" | "human",
  authorityId: string,
) {
  return appendGraphTransition(runtime, {
    eventType: "node_completed",
    nodeId,
    dispatchId,
    outcome,
    authority,
    authorityId,
    evidenceHash: createHash("sha256").update(`evidence-${nodeId}-${outcome}`).digest("hex"),
  });
}

function fanGraph() {
  return {
    schemaVersion: 1 as const,
    graphId: "fan-graph",
    revision: 1,
    schedulerAuthorityId: "oma-scheduler",
    nodes: [
      node("contract", "human", "human"),
      agentNode("analysis"),
      agentNode("implementation"),
      node("join", "join", "scheduler"),
      node("validation", "gate", "oracle"),
    ],
    edges: [
      edge("contract-analysis", "contract", "analysis", "success"),
      edge("contract-implementation", "contract", "implementation", "success"),
      edge("analysis-join", "analysis", "join", "success"),
      edge("implementation-join", "implementation", "join", "success"),
      edge("join-validation", "join", "validation", "success"),
    ],
  };
}

function branchGraph() {
  return {
    schemaVersion: 1 as const,
    graphId: "branch-graph",
    revision: 1,
    schedulerAuthorityId: "oma-scheduler",
    nodes: [
      agentNode("work"),
      agentNode("diagnostic"),
      node("publish", "gate", "oracle"),
    ],
    edges: [
      edge("work-diagnostic", "work", "diagnostic", "failure"),
      edge("work-publish", "work", "publish", "success"),
    ],
  };
}

function singleAgentGraph() {
  return {
    schemaVersion: 1 as const,
    graphId: "single-agent",
    revision: 1,
    schedulerAuthorityId: "oma-scheduler",
    nodes: [agentNode("agent")],
    edges: [] as Array<ReturnType<typeof edge>>,
  };
}

function node(
  id: string,
  kind: "broker" | "gate" | "join" | "human",
  completionAuthority: "broker" | "oracle" | "scheduler" | "human",
) {
  return {
    id,
    title: id,
    kind,
    activation: "all" as const,
    completionAuthority,
    completionAuthorityId:
      completionAuthority === "human"
        ? "user"
        : completionAuthority === "scheduler"
          ? "oma-scheduler"
          : completionAuthority === "oracle"
            ? "oma-oracle"
            : "oma-broker",
  };
}

function agentNode(id: string) {
  return {
    id,
    title: id,
    kind: "agent" as const,
    activation: "all" as const,
    completionAuthority: "broker" as const,
    completionAuthorityId: "oma-broker",
    executor: { adapter: "antigravity", persona: `${id}-persona` },
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  when: "success" | "failure" | "always",
) {
  return { id, from, to, when };
}
