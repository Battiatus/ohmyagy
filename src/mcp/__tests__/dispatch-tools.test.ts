import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "bun:test";
import { executeGraphInit, executeGraphMarkNode } from "../graph-tools.js";
import { executeDispatchNode } from "../dispatch-tools.js";
import { recordInterview } from "../../mission/interview-gate.js";
import { recordRun } from "../../mission/__tests__/support/attributed-run.js";
import { BrainStore } from "../../brain/brain-store.js";
import { executeBrainTool } from "../brain-tools.js";
import { readModelCatalog } from "../../runtime/model-catalog.js";
import { MissionEventsStore } from "../../ledger/mission-events.js";
import { eventsPathFor } from "../../mission/read-model.js";
import type {
  DriverExecutionResult,
  DriverInvocationOptions,
  IAgyDriver,
} from "../../runtime/agy-driver.js";

/**
 * Dispatching a node to its assigned expert is what makes the six roles agents instead of
 * configurations. Until this tool existed, the conductor did the work itself and wrote
 * whichever `expertId` it liked onto the node.
 *
 * The driver is injected, so these tests prove what OMA *asks the expert to be* — persona,
 * model class, effort, sandbox — without spending a model call. A real dispatch is proved
 * separately by `.oma/verify-dispatch-node.mjs`.
 */

interface CapturedInvocation {
  options: DriverInvocationOptions;
}

function fakeDriver(captured: CapturedInvocation[], status: "success" | "failed" = "success"): IAgyDriver {
  return {
    async invoke(options: DriverInvocationOptions): Promise<DriverExecutionResult> {
      captured.push({ options });
      const rawStdout =
        status === "success"
          ? '{"summary":"the databases are not synchronised","evidence":["job is manual"],"confidence":"high"}'
          : "";
      return {
        exitCode: status === "success" ? 0 : 1,
        status,
        timedOut: false,
        parsedOutput: status === "success" ? JSON.parse(rawStdout) : undefined,
        rawStdout,
        rawStderr: status === "success" ? "" : "invalid model selection",
        scrubbedStdout: rawStdout,
        scrubbedStderr: status === "success" ? "" : "invalid model selection",
        stdoutHash: "a".repeat(64),
        scrubbedStdoutHash: "a".repeat(64),
        durationMs: 1234,
        receipt: {
          runId: options.runId ?? "run",
          expertId: "unknown",
          model: options.modelOverride ?? "agy-default",
          effort: options.reasoningEffort ?? "agy-default",
          sandbox: "read-only",
          durationMs: 1234,
          exitCode: status === "success" ? 0 : 1,
          status,
          stdoutHash: "a".repeat(64),
          scrubbedStdoutHash: "a".repeat(64),
          receiptHash: "b".repeat(64),
        },
        ...(status === "success" ? {} : { error: "invalid model selection" }),
      };
    },
  };
}

function successResult(
  options: DriverInvocationOptions,
  rawStdout: string,
): DriverExecutionResult {
  return {
    exitCode: 0,
    status: "success",
    timedOut: false,
    parsedOutput: JSON.parse(rawStdout),
    rawStdout,
    rawStderr: "",
    scrubbedStdout: rawStdout,
    scrubbedStderr: "",
    stdoutHash: "a".repeat(64),
    scrubbedStdoutHash: "a".repeat(64),
    durationMs: 1234,
    receipt: {
      runId: options.runId ?? "run",
      expertId: "unknown",
      model: options.modelOverride ?? "agy-default",
      effort: options.reasoningEffort ?? "agy-default",
      sandbox: "workspace-write",
      durationMs: 1234,
      exitCode: 0,
      status: "success",
      stdoutHash: "a".repeat(64),
      scrubbedStdoutHash: "a".repeat(64),
      receiptHash: "b".repeat(64),
    },
  };
}

let root: string;

function explorerNode() {
  return {
    id: "explore-db",
    title: "Establish whether the two databases are synchronised",
    kind: "agent" as const,
    activation: "all" as const,
    completionAuthority: "broker" as const,
    completionAuthorityId: "oma-broker",
    executor: { adapter: "agy", persona: "explorer" },
    scope: ["src/db"],
  };
}

function executorNode() {
  return {
    ...explorerNode(),
    id: "write-fix",
    title: "Patch the synchronisation job",
    executor: { adapter: "agy", persona: "executor" },
  };
}

function authorise(missionId: string): void {
  recordInterview({
    workspaceRoot: root,
    missionId,
    questions: ["What proves the databases are synchronised?"],
    answers: ["A reconciliation run with its log."],
    confirmed: true,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oma-dispatch-"));
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

describe("dispatch_node runs the expert the node is assigned to", () => {
  it("runs the node's persona with its model class, effort and read-only sandbox", async () => {
    executeGraphInit(root, { missionId: "m-dispatch", goal: "g", nodes: [explorerNode()], edges: [] });
    authorise("m-dispatch");

    const captured: CapturedInvocation[] = [];
    const result = await executeDispatchNode({
      workspaceRoot: root,
      input: { nodeId: "explore-db", missionId: "m-dispatch" },
      driver: fakeDriver(captured),
    });

    assert.equal(captured.length, 1);
    const asked = captured[0].options;
    assert.equal(asked.persona, "explorer", "the node's assigned persona must run");
    assert.equal(asked.sandboxMode, "read-only");
    assert.equal(asked.worktreeDir, root);
    assert.ok(
      asked.contractPrompt?.includes("Establish whether the two databases are synchronised"),
      "the expert must be told the node's task",
    );
    assert.ok(asked.contractPrompt?.includes("src/db"), "and its scope");

    // The model class is what the role model promises; the slug is whatever the installed
    // build calls it today.
    const catalog = readModelCatalog();
    if (catalog.source !== "unavailable") {
      assert.ok(
        asked.modelOverride !== undefined && catalog.slugs.includes(asked.modelOverride),
        `dispatched model '${asked.modelOverride}' is not offered by agy`,
      );
    }
    assert.equal(asked.reasoningEffort, "medium", "explorer is a balanced/medium expert");

    assert.equal(result.status, "dispatched");
    assert.equal(result.succeeded, true);
    assert.equal((result.expert as Record<string, unknown>).expertId, "explorer");
    assert.deepEqual(result.output, {
      summary: "the databases are not synchronised",
      evidence: ["job is manual"],
      confidence: "high",
    });
  });

  it("records the run under the expert that actually ran", async () => {
    executeGraphInit(root, { missionId: "m-record", goal: "g", nodes: [explorerNode()], edges: [] });
    authorise("m-record");
    await executeDispatchNode({
      workspaceRoot: root,
      input: { nodeId: "explore-db", missionId: "m-record" },
      driver: fakeDriver([]),
    });

    const events = MissionEventsStore.readEvents(eventsPathFor(root, "m-record"));
    const started = events.filter((event) => event.type === "run_started");
    const finished = events.filter((event) => event.type === "run_finished");
    assert.equal(started.length, 1);
    assert.equal(finished.length, 1);
    const startedEvent = started[0] as unknown as Record<string, unknown>;
    const finishedEvent = finished[0] as unknown as Record<string, unknown>;
    assert.equal(startedEvent.expertId, "explorer");
    assert.equal(startedEvent.workItemId, "explore-db");
    assert.equal(finishedEvent.expertId, "explorer");
    assert.equal(finishedEvent.status, "succeeded");
    assert.equal(startedEvent.runId, finishedEvent.runId);
  });

  it("dispatches a writer into an isolated copy and returns a changeSet, never touching the workspace", async () => {
    const liveFile = join(root, "src", "db.ts");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(liveFile, "export const mode = 'manual';\n", "utf8");

    executeGraphInit(root, { missionId: "m-writer", goal: "g", nodes: [executorNode()], edges: [] });
    authorise("m-writer");

    // The fake writer edits the tree it was given, which must not be the live workspace.
    const writingDriver: IAgyDriver = {
      async invoke(options: DriverInvocationOptions): Promise<DriverExecutionResult> {
        writeFileSync(join(options.worktreeDir, "src", "db.ts"), "export const mode = 'sync';\n", "utf8");
        writeFileSync(join(options.worktreeDir, "src", "new-file.ts"), "export const added = true;\n", "utf8");
        const rawStdout = '{"summary":"made the job automatic","evidence":["src/db.ts"],"confidence":"high"}';
        return successResult(options, rawStdout);
      },
    };

    const result = await executeDispatchNode({
      workspaceRoot: root,
      input: { nodeId: "write-fix", missionId: "m-writer" },
      driver: writingDriver,
    });

    assert.equal(result.succeeded, true);
    assert.equal((result.expert as Record<string, unknown>).sandbox, "workspace-write");

    // The live workspace is untouched: the change exists only as a proposal-ready change set.
    assert.equal(readFileSync(liveFile, "utf8"), "export const mode = 'manual';\n");
    assert.equal(existsSync(join(root, "src", "new-file.ts")), false);

    const changeSet = result.changeSet as { operations: Array<Record<string, unknown>>; changedPaths: string[] };
    assert.deepEqual(changeSet.changedPaths.sort(), ["src/db.ts", "src/new-file.ts"]);
    const modified = changeSet.operations.find((operation) => operation.path === "src/db.ts");
    assert.equal(modified?.kind, "write");
    assert.equal(modified?.content, "export const mode = 'sync';\n");
    assert.match(String(modified?.baseHash), /^[a-f0-9]{64}$/u, "a modification carries the hash it replaces");
    const created = changeSet.operations.find((operation) => operation.path === "src/new-file.ts");
    assert.equal(created?.baseHash, null, "a creation carries no base hash");
  });

  it("reports a binary change instead of smuggling it into a text operation", async () => {
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "logo.bin"), Buffer.from([1, 2, 3]), "utf8");
    executeGraphInit(root, { missionId: "m-binary", goal: "g", nodes: [executorNode()], edges: [] });
    authorise("m-binary");

    const binaryDriver: IAgyDriver = {
      async invoke(options: DriverInvocationOptions): Promise<DriverExecutionResult> {
        writeFileSync(join(options.worktreeDir, "assets", "logo.bin"), Buffer.from([1, 0, 2, 3]));
        return successResult(options, '{"summary":"n/a","evidence":[],"confidence":"low"}');
      },
    };

    const result = await executeDispatchNode({
      workspaceRoot: root,
      input: { nodeId: "write-fix", missionId: "m-binary" },
      driver: binaryDriver,
    });
    const changeSet = result.changeSet as { operations: unknown[]; binaryPaths?: string[] };
    assert.deepEqual(changeSet.binaryPaths, ["assets/logo.bin"]);
    assert.equal(changeSet.operations.length, 0);
  });

  it("refuses a submission that no dispatched run backs", async () => {
    executeGraphInit(root, { missionId: "m-unattributed", goal: "g", nodes: [explorerNode()], edges: [] });
    authorise("m-unattributed");

    // The old code wrote its own `run_finished` for this transition, attributed to whichever
    // expert the caller named, so any node could be completed with nothing behind it.
    assert.throws(
      () => executeGraphMarkNode(root, { missionId: "m-unattributed", nodeId: "explore-db", state: "succeeded" }),
      /no run was ever started for it[\s\S]*dispatch_node/u,
    );
  });

  it("is gated by the interview like every other execution path", async () => {
    executeGraphInit(root, { missionId: "m-gated", goal: "g", nodes: [explorerNode()], edges: [] });

    await assert.rejects(
      () =>
        executeDispatchNode({
          workspaceRoot: root,
          input: { nodeId: "explore-db", missionId: "m-gated" },
          driver: fakeDriver([]),
        }),
      /no recorded interview/u,
    );
  });

  it("refuses the engine's own seed node, which is not a work item", async () => {
    executeGraphInit(root, { missionId: "m-seed", goal: "g" });
    authorise("m-seed");

    await assert.rejects(
      () =>
        executeDispatchNode({
          workspaceRoot: root,
          input: { nodeId: "bootstrap", missionId: "m-seed" },
          driver: fakeDriver([]),
        }),
      /engine's own seed/u,
    );
  });

  it("returns the expert's answer, not agy's transport envelope", async () => {
    executeGraphInit(root, { missionId: "m-envelope", goal: "g", nodes: [explorerNode()], edges: [] });
    authorise("m-envelope");

    // The shape a real dispatch returns: parsedOutput is the envelope, and the model's own
    // JSON sits inside `response`. Taking the first balanced object out of raw stdout
    // returned the envelope — observed on a real run.
    const envelopeDriver: IAgyDriver = {
      async invoke(options: DriverInvocationOptions): Promise<DriverExecutionResult> {
        const envelope = {
          conversation_id: "b66b83e2",
          status: "SUCCESS",
          response:
            'Voici mon rapport.\n{"summary":"only .oma is present","evidence":[".oma/graph"],"confidence":"high"}\n',
        };
        return {
          exitCode: 0,
          status: "success",
          timedOut: false,
          parsedOutput: envelope,
          rawStdout: JSON.stringify(envelope),
          rawStderr: "",
          scrubbedStdout: JSON.stringify(envelope),
          scrubbedStderr: "",
          stdoutHash: "a".repeat(64),
          scrubbedStdoutHash: "a".repeat(64),
          durationMs: 10,
          receipt: {
            runId: options.runId ?? "run",
            expertId: "explorer",
            model: options.modelOverride ?? "m",
            effort: options.reasoningEffort ?? "medium",
            sandbox: "read-only",
            durationMs: 10,
            exitCode: 0,
            status: "success",
            stdoutHash: "a".repeat(64),
            scrubbedStdoutHash: "a".repeat(64),
            receiptHash: "b".repeat(64),
          },
        };
      },
    };

    const result = await executeDispatchNode({
      workspaceRoot: root,
      input: { nodeId: "explore-db", missionId: "m-envelope" },
      driver: envelopeDriver,
    });
    assert.deepEqual(result.output, {
      summary: "only .oma is present",
      evidence: [".oma/graph"],
      confidence: "high",
    });
  });

  it("refuses a completion that no dispatched run backs", async () => {
    executeGraphInit(root, { missionId: "m-unattributed", goal: "g", nodes: [explorerNode()], edges: [] });
    authorise("m-unattributed");

    // The old code wrote its own `run_finished` for this transition, attributed to whichever
    // expert the caller named, so any node could be completed with nothing behind it.
    assert.throws(
      () => executeGraphMarkNode(root, { missionId: "m-unattributed", nodeId: "explore-db", state: "succeeded" }),
      /no run was ever started for it[\s\S]*dispatch_node/u,
    );
  });

  it("accepts a completion once the node's own expert has run", async () => {
    executeGraphInit(root, { missionId: "m-attributed", goal: "g", nodes: [explorerNode()], edges: [] });
    authorise("m-attributed");

    const dispatched = await executeDispatchNode({
      workspaceRoot: root,
      input: { nodeId: "explore-db", missionId: "m-attributed" },
      driver: fakeDriver([]),
    });
    assert.equal(dispatched.succeeded, true);

    const marked = executeGraphMarkNode(root, {
      missionId: "m-attributed",
      nodeId: "explore-db",
      state: "succeeded",
    });
    assert.equal(marked.status, "node_marked");
    assert.equal(marked.state, "succeeded");
  });

  it("refuses a completion performed by an expert other than the node's own", async () => {
    executeGraphInit(root, { missionId: "m-wrong-expert", goal: "g", nodes: [explorerNode()], edges: [] });
    authorise("m-wrong-expert");

    // A successful run happened — but a verifier did it, and this node is assigned to an
    // explorer. Attribution to the node's own expert is the point of the rule.
    recordRun({
      workspaceRoot: root,
      missionId: "m-wrong-expert",
      nodeId: "explore-db",
      expertId: "verifier",
    });

    assert.throws(
      () =>
        executeGraphMarkNode(root, {
          missionId: "m-wrong-expert",
          nodeId: "explore-db",
          state: "succeeded",
        }),
      /assigned to expert 'explorer'[\s\S]*'verifier'/u,
    );
  });

  it("feeds the durable project model with the areas the expert actually examined", async () => {
    executeGraphInit(root, { missionId: "m-model", goal: "g", nodes: [explorerNode()], edges: [] });
    authorise("m-model");

    const brain = new BrainStore(join(root, ".oma", "brain.sqlite"));
    try {
      const evidenceDriver: IAgyDriver = {
        async invoke(options: DriverInvocationOptions): Promise<DriverExecutionResult> {
          return successResult(
            options,
            '{"summary":"the databases are not synchronised","evidence":["src/db/a.ts","src/db/b.ts"],"confidence":"high"}',
          );
        },
      };

      await executeDispatchNode({
        workspaceRoot: root,
        input: { nodeId: "explore-db", missionId: "m-model" },
        driver: evidenceDriver,
        brain,
      });

      const project = brain.ensureProject({ name: "x", rootPath: root });
      const after = brain.listComponents({ projectId: project.id });
      assert.deepEqual(after.map((component) => component.path).sort(), ["src/db/a.ts", "src/db/b.ts"]);
      assert.equal(after[0].mentions, 1);
      assert.equal(after[0].summary, "the databases are not synchronised");
      assert.match(after[0].source, /^dispatch:/u);

      // A second dispatch mentioning the same area counts the mention instead of duplicating it.
      await executeDispatchNode({
        workspaceRoot: root,
        input: { nodeId: "explore-db", missionId: "m-model" },
        driver: evidenceDriver,
        brain,
      });
      const again = brain.listComponents({ projectId: project.id });
      assert.equal(again.length, 2, "an area is upserted by path, not appended");
      const a = again.find((component) => component.path === "src/db/a.ts");
      assert.equal(a?.mentions, 2);
    } finally {
      brain.close();
    }
  });

  it("reports the project model through the brain tool, scoped to the workspace project", async () => {
    executeGraphInit(root, { missionId: "m-read", goal: "g", nodes: [explorerNode()], edges: [] });
    authorise("m-read");

    const brain = new BrainStore(join(root, ".oma", "brain.sqlite"));
    try {
      const other = brain.ensureProject({ name: "other", rootPath: join(root, "..", "other-project") });
      brain.recordComponent({ projectId: other.id, path: "not-mine.ts", kind: "file", source: "test" });

      await executeDispatchNode({
        workspaceRoot: root,
        input: { nodeId: "explore-db", missionId: "m-read" },
        driver: {
          async invoke(options: DriverInvocationOptions): Promise<DriverExecutionResult> {
            return successResult(
              options,
              '{"summary":"scope established","evidence":["src/db/a.ts"],"confidence":"medium"}',
            );
          },
        },
        brain,
      });

      const model = executeBrainTool(brain, root, "project_model", {}) as {
        status: string;
        count: number;
        components: Array<{ path: string }>;
      };
      assert.equal(model.status, "reported");
      assert.equal(model.count, 1, "another project's components must not leak into this one");
      assert.equal(model.components[0].path, "src/db/a.ts");
    } finally {
      brain.close();
    }
  });

  it("records a failed run as failed instead of reporting a dispatch", async () => {
    executeGraphInit(root, { missionId: "m-failed", goal: "g", nodes: [explorerNode()], edges: [] });
    authorise("m-failed");

    const result = await executeDispatchNode({
      workspaceRoot: root,
      input: { nodeId: "explore-db", missionId: "m-failed" },
      driver: fakeDriver([], "failed"),
    });
    assert.equal(result.succeeded, false);
    assert.equal(result.status, "dispatched");
    assert.match(String(result.error), /invalid model selection/u);

    const events = MissionEventsStore.readEvents(eventsPathFor(root, "m-failed"));
    const finished = events.filter((event) => event.type === "run_finished");
    assert.equal((finished[0] as unknown as Record<string, unknown>).status, "failed");
  });
});
