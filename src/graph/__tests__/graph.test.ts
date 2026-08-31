import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { resolveGraphGates } from "../gate-registry.js";
import { projectGraph } from "../kernel.js";
import { parseExecutionGraph } from "../model.js";
import { resolveRepoPath } from "../paths.js";
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

test("schema v1 rejects every contract field as unexpected", () => {
  const fields = {
    scope: ["src/graph"],
    acceptance: [acceptanceCriterion("build")],
    artifacts: ["dist/src/graph/model.js"],
    maxDiff: { files: 2, lines: 200 },
  };

  for (const [field, value] of Object.entries(fields)) {
    const graph = singleAgentGraph();
    Object.assign(graph.nodes[0], { [field]: value });
    assert.throws(
      () => parseExecutionGraph(graph),
      new RegExp(`unexpected fields: ${field}`, "iu"),
    );
  }
});

test("schema v2 parses without a node contract", () => {
  const parsed = parseExecutionGraph(versionTwoGraph());

  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.nodes[0]?.scope, undefined);
  assert.equal(parsed.nodes[0]?.acceptance, undefined);
  assert.equal(parsed.nodes[0]?.artifacts, undefined);
  assert.equal(parsed.nodes[0]?.maxDiff, undefined);
});

test("schema v2 round-trips every agent node contract value", () => {
  const graph = versionTwoGraph();
  const contract = {
    scope: ["src/graph", "docs"],
    acceptance: [
      {
        id: "build",
        description: "The TypeScript build succeeds",
        gateId: "npm-build",
      },
    ],
    artifacts: ["src/graph/model.ts", "dist/graph/model.js"],
    maxDiff: { files: 2, lines: 200 },
  };
  Object.assign(graph.nodes[0], contract);

  const parsed = parseExecutionGraph(graph);

  assert.deepEqual(parsed.nodes[0]?.scope, contract.scope);
  assert.deepEqual(parsed.nodes[0]?.acceptance, contract.acceptance);
  assert.deepEqual(parsed.nodes[0]?.artifacts, contract.artifacts);
  assert.deepEqual(parsed.nodes[0]?.maxDiff, contract.maxDiff);
});

test("rejects schema versions other than 1 and 2", () => {
  assert.throws(
    () => parseExecutionGraph({ ...singleAgentGraph(), schemaVersion: 3 }),
    /unsupported execution graph schema/iu,
  );
});

test("rejects invalid gateId shapes", () => {
  for (const gateId of ["", "Npm-test", "-npm-test", "a".repeat(65), "gates/npm-test"]) {
    const graph = versionTwoGraph();
    Object.assign(graph.nodes[0], {
      acceptance: [acceptanceCriterion("build", gateId)],
    });
    assert.throws(
      () => parseExecutionGraph(graph),
      /(?:expected non-empty gateId|gateId must match)/iu,
      `expected ${JSON.stringify(gateId)} to be rejected`,
    );
  }
});

test("rejects an absolute scope path", () => {
  const graph = versionTwoGraph();
  Object.assign(graph.nodes[0], { scope: ["/etc/passwd"] });

  assert.throws(() => parseExecutionGraph(graph), /scope\[0\] must be repo-relative/iu);
});

test("rejects a scope path containing a parent segment", () => {
  const graph = versionTwoGraph();
  Object.assign(graph.nodes[0], { scope: ["src/../package.json"] });

  assert.throws(() => parseExecutionGraph(graph), /scope\[0\] must not contain \.\. segments/iu);
});

test("rejects duplicate acceptance ids within an agent node", () => {
  const graph = versionTwoGraph();
  Object.assign(graph.nodes[0], {
    acceptance: [acceptanceCriterion("build"), acceptanceCriterion("build")],
  });

  assert.throws(() => parseExecutionGraph(graph), /duplicate acceptance id: build/iu);
});

test("rejects an unknown field in an acceptance entry", () => {
  const graph = versionTwoGraph();
  Object.assign(graph.nodes[0], {
    acceptance: [{ ...acceptanceCriterion("build"), unexpected: true }],
  });

  assert.throws(
    () => parseExecutionGraph(graph),
    /acceptance\[0\] contains unexpected fields: unexpected/iu,
  );
});

test("rejects zero and non-integer maxDiff values", () => {
  for (const maxDiff of [
    { files: 0, lines: 10 },
    { files: 1, lines: 1.5 },
  ]) {
    const graph = versionTwoGraph();
    Object.assign(graph.nodes[0], { maxDiff });

    assert.throws(() => parseExecutionGraph(graph), /expected positive integer (?:files|lines)/iu);
  }
});

test("rejects scope on a non-agent node", () => {
  const graph = versionTwoGraph();
  const gateNode = { ...node("validation", "gate", "oracle"), scope: ["src"] };

  assert.throws(
    () => parseExecutionGraph({ ...graph, nodes: [gateNode] }),
    /only agent nodes may define scope/iu,
  );
});

test("rejects an unknown field in maxDiff", () => {
  const graph = versionTwoGraph();
  Object.assign(graph.nodes[0], { maxDiff: { files: 1, lines: 10, unexpected: true } });

  assert.throws(
    () => parseExecutionGraph(graph),
    /maxDiff contains unexpected fields: unexpected/iu,
  );
});

test("resolves a valid gate registry to OracleGate definitions per node", () => {
  const root = mkdtempSync(join(tmpdir(), "oma-gates-"));
  try {
    const graph = versionTwoGraph();
    Object.assign(graph.nodes[0], { acceptance: [acceptanceCriterion("build", "npm-test")] });
    writeGateRegistry(root, [validRegistryGate("npm-test")]);

    const resolved = resolveGraphGates(parseExecutionGraph(graph), root);

    assert.deepEqual(resolved.get("agent"), [validRegistryGate("npm-test")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed on an unknown gateId", () => {
  const root = mkdtempSync(join(tmpdir(), "oma-gates-"));
  try {
    const graph = versionTwoGraph();
    Object.assign(graph.nodes[0], { acceptance: [acceptanceCriterion("build", "missing")] });
    writeGateRegistry(root, []);

    assert.throws(
      () => resolveGraphGates(parseExecutionGraph(graph), root),
      /unknown gateId missing for node agent acceptance build/iu,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed on duplicate gate registry ids", () => {
  const root = mkdtempSync(join(tmpdir(), "oma-gates-"));
  try {
    const graph = versionTwoGraph();
    Object.assign(graph.nodes[0], { acceptance: [acceptanceCriterion("build", "npm-test")] });
    writeGateRegistry(root, [validRegistryGate("npm-test"), validRegistryGate("npm-test")]);

    assert.throws(
      () => resolveGraphGates(parseExecutionGraph(graph), root),
      /duplicate gate registry id: npm-test/iu,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed on malformed gate registries", () => {
  const root = mkdtempSync(join(tmpdir(), "oma-gates-"));
  const graph = versionTwoGraph();
  Object.assign(graph.nodes[0], { acceptance: [acceptanceCriterion("build", "npm-test")] });
  const parsed = parseExecutionGraph(graph);
  try {
    for (const malformed of [
      null,
      { schemaVersion: 2, gates: [] },
      { schemaVersion: 1, gates: {} },
      { schemaVersion: 1, gates: [{ ...validRegistryGate("npm-test"), timeoutMs: 0 }] },
    ]) {
      writeGateRegistryValue(root, malformed);
      assert.throws(
        () => resolveGraphGates(parsed, root),
        /malformed gate registry|malformed gate registry entry/iu,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyGraphStore reports an unknown gateId as invalid", () => {
  const graph = versionTwoGraph();
  Object.assign(graph.nodes[0], { acceptance: [acceptanceCriterion("build", "missing")] });
  const fixture = createFixture(graph);
  try {
    writeGateRegistry(fixture.root, []);
    const verification = verifyGraphStore(loadGraphRuntime(fixture.root));

    assert.equal(verification.valid, false);
    assert.match(verification.errors.join("\n"), /gate registry resolution failed: unknown gateId missing/iu);
  } finally {
    fixture.cleanup();
  }
});

test("contract-bearing graph stores with valid gates are accepted in schema v2", () => {
  const graph = versionTwoGraph();
  Object.assign(graph.nodes[0], { acceptance: [acceptanceCriterion("build", "npm-test")] });
  const fixture = createFixture(graph);
  try {
    writeGateRegistry(fixture.root, [validRegistryGate("npm-test")]);
    const runtime = initializeGraphStore(fixture.root);
    const verification = verifyGraphStore(runtime);

    assert.equal(verification.valid, true);
    assert.equal(verification.errors.length, 0);
  } finally {
    fixture.cleanup();
  }
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

function createFixture(graph: unknown) {
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

function versionTwoGraph() {
  return { ...singleAgentGraph(), schemaVersion: 2 as const };
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

function acceptanceCriterion(id: string, gateId = "npm-test") {
  return {
    id,
    description: "The TypeScript build succeeds",
    gateId,
  };
}

function validRegistryGate(id: string) {
  return {
    id,
    program: process.execPath,
    args: ["--version"],
    timeoutMs: 30_000,
  };
}

function writeGateRegistry(root: string, gates: ReturnType<typeof validRegistryGate>[]): void {
  writeGateRegistryValue(root, { schemaVersion: 1, gates });
}

function writeGateRegistryValue(root: string, value: unknown): void {
  const registryDir = join(root, ".agents", "plugins", "oma");
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(registryDir, "gates.json"), JSON.stringify(value, null, 2), "utf8");
}

function edge(
  id: string,
  from: string,
  to: string,
  when: "success" | "failure" | "always",
) {
  return { id, from, to, when };
}

test("rejects drive-prefixed, absolute and UNC scope paths", () => {
  for (const entry of ["C:foo", "D:artifact", "C:/foo", "c:", "//server/share", "/etc/passwd"]) {
    const graph = versionTwoGraph();
    Object.assign(graph.nodes[0], { scope: [entry] });

    assert.throws(
      () => parseExecutionGraph(graph),
      /scope\[0\] must be repo-relative/iu,
      `expected ${entry} to be rejected`,
    );
  }
});

test("rejects backslash separators in artifact paths", () => {
  const backslash = String.fromCharCode(92);
  for (const entry of [`${backslash}${backslash}server${backslash}share`, `src${backslash}graph`]) {
    const graph = versionTwoGraph();
    Object.assign(graph.nodes[0], { artifacts: [entry] });

    assert.throws(
      () => parseExecutionGraph(graph),
      /artifacts\[0\] must use forward slashes/iu,
      `expected ${entry} to be rejected`,
    );
  }
});

test("rejects a scope path containing a NUL byte", () => {
  const graph = versionTwoGraph();
  Object.assign(graph.nodes[0], { scope: ["src/graph\0.ts"] });

  assert.throws(() => parseExecutionGraph(graph), /scope\[0\] must not contain NUL bytes/iu);
});

test("accepts repo-relative scope and artifact paths", () => {
  const graph = versionTwoGraph();
  Object.assign(graph.nodes[0], {
    scope: ["src/graph", "src/graph/model.ts", "./dist"],
    artifacts: ["dist/graph/model.js"],
  });

  const parsed = parseExecutionGraph(graph);

  assert.deepEqual(parsed.nodes[0]?.scope, ["src/graph", "src/graph/model.ts", "./dist"]);
  assert.deepEqual(parsed.nodes[0]?.artifacts, ["dist/graph/model.js"]);
});

test("resolveRepoPath contains repo-relative paths and rejects traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "oma-paths-"));
  try {
    assert.equal(resolveRepoPath(root, "src/graph/model.ts"), resolve(root, "src/graph/model.ts"));
    assert.equal(resolveRepoPath(root, "./dist/graph"), resolve(root, "dist/graph"));

    for (const entry of ["", ".", "..", "../outside", "src/../../outside"]) {
      assert.throws(
        () => resolveRepoPath(root, entry),
        /escapes the repository root/iu,
        `expected ${JSON.stringify(entry)} to be rejected`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRepoPath rejects absolute, drive-relative and UNC escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "oma-paths-"));
  try {
    const escapes = [resolve(root, "..", "outside"), "C:/other", "D:other", "//server/share"];
    for (const entry of escapes) {
      assert.throws(
        () => resolveRepoPath(root, entry),
        /escapes the repository root/iu,
        `expected ${entry} to be rejected`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRepoPath rejects a real symlink that escapes the root", (context) => {
  const root = mkdtempSync(join(tmpdir(), "oma-paths-root-"));
  const outside = mkdtempSync(join(tmpdir(), "oma-paths-outside-"));
  try {
    const link = join(root, "escape");
    if (!createDirectoryLinkOrSkip(context, outside, link, "dir")) return;

    assert.throws(
      () => resolveRepoPath(root, "escape/secret.txt"),
      /escapes the repository root|symbolic link or junction/iu,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveRepoPath rejects a Windows junction that escapes the root", (context) => {
  const root = mkdtempSync(join(tmpdir(), "oma-paths-root-"));
  const outside = mkdtempSync(join(tmpdir(), "oma-paths-outside-"));
  try {
    const junction = join(root, "escape-junction");
    if (!createDirectoryLinkOrSkip(context, outside, junction, "junction")) return;

    assert.throws(
      () => resolveRepoPath(root, "escape-junction/secret.txt"),
      /escapes the repository root|symbolic link or junction/iu,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function createDirectoryLinkOrSkip(
  context: TestContext,
  target: string,
  link: string,
  type: "dir" | "junction",
): boolean {
  try {
    symlinkSync(target, link, type);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(
      code === "EPERM" || /UnauthorizedAccess/iu.test(message),
      `link fixture failed without a privilege error: ${message}`,
    );
    if (context && typeof (context as { skip?: (reason?: string) => void }).skip === "function") {
      try {
        (context as { skip: (reason?: string) => void }).skip(`link fixture requires unavailable privileges: ${code || "UnauthorizedAccess"}`);
      } catch {
        // Ignore if skip is not supported in runner
      }
    }
    return false;
  }
}
