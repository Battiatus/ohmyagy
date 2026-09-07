import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, describe, it, afterEach } from "bun:test";
import { GraphBroker } from "../broker.js";
import {
  calculateProposalDigest,
  type GraphProposal,
} from "../proposal.js";
import {
  initializeGraphStore,
  loadGraphRuntime,
  verifyGraphStore,
  appendGraphTransition,
  type LoadedGraphRuntime,
} from "../store.js";
import { projectGraph } from "../kernel.js";
import type { ExecutionGraph, GraphNode, GraphEdge } from "../model.js";
import { JournalStore } from "../../ledger/journal-store.js";
import { GENESIS_HASH, verifyHashChain } from "../../ledger/hash-chain.js";

describe("WP-2 GraphBroker Multi-Tiered Test Suite", () => {
  let rootDir: string;
  let broker: GraphBroker;
  let journalStore: JournalStore;

  function baseExecutionGraph(): ExecutionGraph {
    return {
      schemaVersion: 2,
      graphId: "mission_test_graph",
      revision: 1,
      schedulerAuthorityId: "oma-scheduler",
      nodes: [
        {
          id: "node_A",
          title: "Initial Analysis Task",
          kind: "agent",
          activation: "all",
          completionAuthority: "broker",
          completionAuthorityId: "oma-broker",
          executor: { adapter: "antigravity", persona: "oma-planner" },
          scope: ["src/analysis"],
        },
        {
          id: "node_B",
          title: "Implementation Task",
          kind: "agent",
          activation: "all",
          completionAuthority: "broker",
          completionAuthorityId: "oma-broker",
          executor: { adapter: "antigravity", persona: "oma-executor" },
          scope: ["src/impl"],
        },
      ],
      edges: [
        {
          id: "edge_A_B",
          from: "node_A",
          to: "node_B",
          when: "success",
        },
      ],
    };
  }

  function setupFixture(initialGraph = baseExecutionGraph()) {
    rootDir = mkdtempSync(join(tmpdir(), "oma-broker-test-"));
    const graphDir = join(rootDir, ".oma", "graph");
    const ledgerDir = join(rootDir, ".oma", "ledger");
    mkdirSync(graphDir, { recursive: true });
    mkdirSync(ledgerDir, { recursive: true });

    writeFileSync(
      join(graphDir, "execution-graph.json"),
      JSON.stringify(initialGraph, null, 2),
      "utf8",
    );

    const runtime = initializeGraphStore(rootDir);
    journalStore = new JournalStore(join(ledgerDir, "events.jsonl"));
    broker = new GraphBroker({ rootDir, journalStore });
    return { rootDir, runtime, journalStore, broker };
  }

  function createProposal(
    parentRuntime: LoadedGraphRuntime,
    delta: GraphProposal["delta"],
    overrides?: Partial<GraphProposal>,
  ): GraphProposal {
    const head = journalStore.getHead();
    const raw: Omit<GraphProposal, "proposalDigest"> = {
      schemaVersion: 2,
      proposalId: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      missionId: "mission_01",
      proposerPersona: "oma-planner",
      parentRevision: parentRuntime.graph.revision,
      parentGraphHash: parentRuntime.graphHash,
      parentJournalHeadHash: head.hash,
      rationale: {
        summary: "Adding dynamic subtask branches based on discovered workload.",
        evidenceNodeId: "node_A",
        evidenceHash: createHash("sha256").update("evidence-payload").digest("hex"),
      },
      delta,
      resourceBudgetsDelta: {
        maxAdditionalTokens: 25000,
        maxAdditionalTimeMs: 60000,
        maxAdditionalNodes: delta?.nodesToAdd?.length || 1,
      },
      ...(overrides || {}),
    };

    const proposalDigest = calculateProposalDigest(raw);
    return {
      ...raw,
      proposalDigest,
      ...(overrides?.proposalDigest ? { proposalDigest: overrides.proposalDigest } : {}),
    };
  }

  afterEach(() => {
    if (rootDir && existsSync(rootDir)) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // TIER 1: Valid Proposal Acceptance, Graph Expansion & CAS Revision Increment
  // ==========================================================================
  describe("Tier 1: Valid Proposal Acceptance & Revision Increment", () => {
    it("validates and accepts a valid graph expansion proposal", async () => {
      const { runtime } = setupFixture();

      const newNode: GraphNode = {
        id: "node_C",
        title: "Dynamic Verification Node",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
        executor: { adapter: "antigravity", persona: "oma-reviewer" },
        scope: ["src/verify"],
      };

      const newEdge: GraphEdge = {
        id: "edge_B_C",
        from: "node_B",
        to: "node_C",
        when: "success",
      };

      const proposal = createProposal(runtime, {
        nodesToAdd: [newNode],
        edgesToAdd: [newEdge],
        edgesToDelete: [],
      });

      const validation = await broker.validateProposal(proposal);
      assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
      assert.ok(validation.proposedGraph);
      assert.equal(validation.proposedGraph.nodes.length, 3);
      assert.equal(validation.proposedGraph.edges.length, 2);
      assert.equal(validation.proposedGraph.revision, 2);
    });

    it("publishes revision N+1 atomically via CAS and updates execution-graph.json", async () => {
      const { runtime } = setupFixture();

      const newNode: GraphNode = {
        id: "node_C",
        title: "Dynamic Verification Node",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
        executor: { adapter: "antigravity", persona: "oma-reviewer" },
        scope: ["src/verify"],
      };

      const newEdge: GraphEdge = {
        id: "edge_B_C",
        from: "node_B",
        to: "node_C",
        when: "success",
      };

      const proposal = createProposal(runtime, {
        nodesToAdd: [newNode],
        edgesToAdd: [newEdge],
        edgesToDelete: [],
      });

      const result = await broker.applyProposal(proposal);

      assert.equal(result.success, true);
      assert.equal(result.revision, 2);

      // Verify execution-graph.json was updated
      const updatedRuntime = loadGraphRuntime(rootDir);
      assert.equal(updatedRuntime.graph.revision, 2);
      assert.equal(updatedRuntime.graph.nodes.length, 3);
      assert.ok(updatedRuntime.graph.nodes.some((n) => n.id === "node_C"));
      assert.ok(updatedRuntime.graph.edges.some((e) => e.id === "edge_B_C"));

      // Verify revision archive was created
      const revisionPath = join(rootDir, ".oma", "graph", "revisions", "rev_2.json");
      assert.ok(existsSync(revisionPath), "rev_2.json archive should exist");

      // Verify journal event was logged
      const journalEvents = journalStore.readEvents();
      const mutationEvent = journalEvents.find((e) => e.eventType === "revision_published");
      assert.ok(mutationEvent);
      assert.equal(mutationEvent?.oldRevision, 1);
      assert.equal(mutationEvent?.newRevision, 2);
      assert.equal(mutationEvent?.proposalId, proposal.proposalId);
    });

    it("supports edge deletion and rerouting via edgesToDelete", async () => {
      const { runtime } = setupFixture();

      // Replace edge A->B with A->C and C->B
      const nodeC: GraphNode = {
        id: "node_C",
        title: "Intermediary Transformer",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
        executor: { adapter: "antigravity", persona: "oma-executor" },
      };

      const proposal = createProposal(runtime, {
        nodesToAdd: [nodeC],
        edgesToAdd: [
          { id: "edge_A_C", from: "node_A", to: "node_C", when: "success" },
          { id: "edge_C_B", from: "node_C", to: "node_B", when: "success" },
        ],
        edgesToDelete: ["edge_A_B"],
      });

      const result = await broker.applyProposal(proposal);
      assert.equal(result.success, true);

      const updated = loadGraphRuntime(rootDir);
      assert.equal(updated.graph.edges.length, 2);
      assert.ok(!updated.graph.edges.some((e) => e.id === "edge_A_B"));
      assert.ok(updated.graph.edges.some((e) => e.id === "edge_A_C"));
      assert.ok(updated.graph.edges.some((e) => e.id === "edge_C_B"));
    });
  });

  // ==========================================================================
  // TIER 2: Boundary, Edge & Anti-Loop Validation
  // ==========================================================================
  describe("Tier 2: Cycle Rejection, Invariants & CAS Mismatch", () => {
    it("rejects direct cycle A -> B -> A with exact cyclePath diagnostics", async () => {
      const { runtime } = setupFixture();

      // Existing edge: node_A -> node_B. Proposal adds: node_B -> node_A
      const proposal = createProposal(runtime, {
        nodesToAdd: [],
        edgesToAdd: [
          { id: "edge_cycle_direct", from: "node_B", to: "node_A", when: "success" },
        ],
        edgesToDelete: [],
      });

      const validation = await broker.validateProposal(proposal);

      assert.equal(validation.valid, false);
      assert.ok(validation.diagnostics?.some((d) => d.code === "CYCLE_DETECTED"));
      assert.deepEqual(validation.cyclePath, ["node_A", "node_B", "node_A"]);
    });

    it("rejects indirect cycle A -> B -> C -> A with full cycle path extraction", async () => {
      const { runtime } = setupFixture();

      const nodeC: GraphNode = {
        id: "node_C",
        title: "Downstream Task",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
        executor: { adapter: "antigravity", persona: "oma-executor" },
      };

      // Proposal adds B -> C and C -> A
      const proposal = createProposal(runtime, {
        nodesToAdd: [nodeC],
        edgesToAdd: [
          { id: "edge_B_C", from: "node_B", to: "node_C", when: "success" },
          { id: "edge_C_A", from: "node_C", to: "node_A", when: "success" },
        ],
        edgesToDelete: [],
      });

      const validation = await broker.validateProposal(proposal);

      assert.equal(validation.valid, false);
      assert.ok(validation.diagnostics?.some((d) => d.code === "CYCLE_DETECTED"));
      assert.deepEqual(validation.cyclePath, ["node_A", "node_B", "node_C", "node_A"]);
    });

    it("rejects self-loops (node_A -> node_A)", async () => {
      const { runtime } = setupFixture();

      const proposal = createProposal(runtime, {
        nodesToAdd: [],
        edgesToAdd: [
          { id: "edge_self_loop", from: "node_A", to: "node_A", when: "failure" },
        ],
        edgesToDelete: [],
      });

      const validation = await broker.validateProposal(proposal);

      assert.equal(validation.valid, false);
      assert.ok(
        validation.diagnostics?.some(
          (d) => d.code === "SELF_LOOP_FORBIDDEN" || d.code === "CYCLE_DETECTED" || d.code === "SELF_LOOP_DETECTED",
        ),
      );
    });

    it("rejects mutation or reactivation of terminal nodes (status succeeded/failed)", async () => {
      const { runtime } = setupFixture();

      // Dispatch and complete node_A
      appendGraphTransition(runtime, {
        eventType: "node_dispatched",
        nodeId: "node_A",
        dispatchId: "disp_01",
        authorityId: "oma-scheduler",
      });
      appendGraphTransition(runtime, {
        eventType: "node_completed",
        nodeId: "node_A",
        dispatchId: "disp_01",
        authority: "broker",
        authorityId: "oma-broker",
        outcome: "success",
        evidenceHash: "e".repeat(64),
      });

      // Attempt to add a new incoming edge to terminal node_A
      const nodeX: GraphNode = {
        id: "node_X",
        title: "Rogue Predecessor",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
        executor: { adapter: "antigravity", persona: "oma-executor" },
      };

      const proposal = createProposal(runtime, {
        nodesToAdd: [nodeX],
        edgesToAdd: [
          { id: "edge_X_A", from: "node_X", to: "node_A", when: "success" },
        ],
        edgesToDelete: [],
      });

      const validation = await broker.validateProposal(proposal);

      assert.equal(validation.valid, false);
      assert.ok(
        validation.diagnostics?.some(
          (d) =>
            d.code === "TERMINAL_NODE_MUTATION" ||
            d.code === "BACKWARD_EDGE_FORBIDDEN",
        ),
        "Must reject incoming edge targeting terminal node",
      );
    });

    it("rejects stale revision CAS proposal (rev 1 submitted when rev 2 is active)", async () => {
      const { runtime } = setupFixture();

      // First valid proposal advances rev to 2
      const prop1 = createProposal(runtime, {
        nodesToAdd: [
          {
            id: "node_C",
            title: "Task C",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-executor" },
          },
        ],
        edgesToAdd: [{ id: "e_BC", from: "node_B", to: "node_C", when: "success" }],
        edgesToDelete: [],
      });
      const res1 = await broker.applyProposal(prop1);
      assert.equal(res1.success, true);
      assert.equal(res1.revision, 2);

      // Concurrent stale proposal referencing rev 1
      const staleProposal = createProposal(
        runtime,
        {
          nodesToAdd: [
            {
              id: "node_D",
              title: "Task D",
              kind: "agent",
              activation: "all",
              completionAuthority: "broker",
              completionAuthorityId: "oma-broker",
              executor: { adapter: "antigravity", persona: "oma-executor" },
            },
          ],
          edgesToAdd: [{ id: "e_BD", from: "node_B", to: "node_D", when: "success" }],
          edgesToDelete: [],
        },
        {
          parentRevision: 1, // Stale parent
        },
      );

      const resStale = await broker.applyProposal(staleProposal);
      assert.equal(resStale.success, false);
      assert.equal(resStale.code, "CAS_CONFLICT");
    });

    it("rejects parallel unsequenced nodes with overlapping file scopes", async () => {
      const { runtime } = setupFixture();

      // Propose two parallel sibling nodes with identical scope: ["src/auth"]
      const nodeX: GraphNode = {
        id: "node_auth_jwt",
        title: "Auth JWT",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
        executor: { adapter: "antigravity", persona: "oma-executor" },
        scope: ["src/auth"],
      };

      const nodeY: GraphNode = {
        id: "node_auth_oauth",
        title: "Auth OAuth",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
        executor: { adapter: "antigravity", persona: "oma-executor" },
        scope: ["src/auth"],
      };

      const proposal = createProposal(runtime, {
        nodesToAdd: [nodeX, nodeY],
        edgesToAdd: [
          { id: "e_A_X", from: "node_A", to: "node_auth_jwt", when: "success" },
          { id: "e_A_Y", from: "node_A", to: "node_auth_oauth", when: "success" },
        ],
        edgesToDelete: [],
      });

      const validation = await broker.validateProposal(proposal);
      assert.equal(validation.valid, false);
      assert.ok(validation.diagnostics?.some((d) => d.code === "SCOPE_COLLISION_DETECTED"));
    });

    it("allows overlapping scopes when causal ordering edge exists", async () => {
      const { runtime } = setupFixture();

      const nodeX: GraphNode = {
        id: "node_seq_1",
        title: "Sequential Part 1",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
        executor: { adapter: "antigravity", persona: "oma-executor" },
        scope: ["src/graph"],
      };

      const nodeY: GraphNode = {
        id: "node_seq_2",
        title: "Sequential Part 2",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
        executor: { adapter: "antigravity", persona: "oma-executor" },
        scope: ["src/graph"],
      };

      // Sequenced with causal edge X -> Y
      const proposal = createProposal(runtime, {
        nodesToAdd: [nodeX, nodeY],
        edgesToAdd: [
          { id: "e_B_X", from: "node_B", to: "node_seq_1", when: "success" },
          { id: "e_X_Y", from: "node_seq_1", to: "node_seq_2", when: "success" },
        ],
        edgesToDelete: [],
      });

      const validation = await broker.validateProposal(proposal);
      assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
    });
  });

  // ==========================================================================
  // TIER 3: Atomicity Rollback, Cryptographic Hash Chaining & Recovery
  // ==========================================================================
  describe("Tier 3: Atomic CAS Rollback & Hash Chain Integrity", () => {
    it("ensures zero dirty state or dangling locks when publication fails midway", async () => {
      const { runtime } = setupFixture();
      const graphFile = join(rootDir, ".oma", "graph", "execution-graph.json");
      const originalGraphContent = readFileSync(graphFile, "utf8");

      // Inject a faulty proposal that will fail post-lock acquisition (hash drift)
      const faultyProposal = createProposal(
        runtime,
        {
          nodesToAdd: [
            {
              id: "node_fail",
              title: "Will Fail",
              kind: "agent",
              activation: "all",
              completionAuthority: "broker",
              completionAuthorityId: "oma-broker",
              executor: { adapter: "antigravity", persona: "oma-executor" },
            },
          ],
          edgesToAdd: [],
          edgesToDelete: [],
        },
        {
          parentGraphHash: "deadbeef".repeat(8), // Invalid parent graph hash
        },
      );

      const result = await broker.applyProposal(faultyProposal);
      assert.equal(result.success, false);
      assert.equal(result.code, "CAS_CONFLICT");

      // Verify file content is completely intact (no partial write)
      assert.equal(readFileSync(graphFile, "utf8"), originalGraphContent);

      // Verify lock was released
      const lockPath = join(rootDir, ".oma", "graph", "graph.lock");
      assert.equal(existsSync(lockPath), false, "Lock file must be released");

      // Verify a valid proposal can immediately proceed
      const validProp = createProposal(runtime, {
        nodesToAdd: [
          {
            id: "node_recovered",
            title: "Recovered Subtask",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-executor" },
          },
        ],
        edgesToAdd: [{ id: "e_rec", from: "node_A", to: "node_recovered", when: "success" }],
        edgesToDelete: [],
      });

      const validResult = await broker.applyProposal(validProp);
      assert.equal(validResult.success, true);
      assert.equal(validResult.revision, 2);
    });

    it("maintains strict SHA-256 hash chaining across multiple dynamic mutations", async () => {
      const { runtime } = setupFixture();

      // Mutation 1: Rev 1 -> Rev 2
      const prop1 = createProposal(runtime, {
        nodesToAdd: [
          {
            id: "node_C",
            title: "Task C",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-executor" },
          },
        ],
        edgesToAdd: [{ id: "e_BC", from: "node_B", to: "node_C", when: "success" }],
        edgesToDelete: [],
      });
      await broker.applyProposal(prop1);

      // Mutation 2: Rev 2 -> Rev 3
      const runtime2 = loadGraphRuntime(rootDir);
      const prop2 = createProposal(runtime2, {
        nodesToAdd: [
          {
            id: "node_D",
            title: "Task D",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-executor" },
          },
        ],
        edgesToAdd: [{ id: "e_CD", from: "node_C", to: "node_D", when: "success" }],
        edgesToDelete: [],
      });
      await broker.applyProposal(prop2);

      // Verify entire events.jsonl cryptographic chain
      const events = journalStore.readEvents();
      assert.equal(events.length, 2);

      const chainVerification = verifyHashChain(events);
      assert.equal(chainVerification.valid, true, chainVerification.errorReason ?? "");

      // Explicit assert of sequence, parentHash linkage, and SHA-256 hashes
      assert.equal(events[0].sequenceNumber, 1);
      assert.equal(events[0].parentHash, GENESIS_HASH);
      assert.equal(events[1].sequenceNumber, 2);
      assert.equal(events[1].parentHash, events[0].eventHash);
    });

    it("detects corrupted events journal and fails closed on integrity violation", async () => {
      const { runtime } = setupFixture();

      // Publish mutation event
      const prop = createProposal(runtime, {
        nodesToAdd: [
          {
            id: "node_C",
            title: "Task C",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-executor" },
          },
        ],
        edgesToAdd: [{ id: "e_BC", from: "node_B", to: "node_C", when: "success" }],
        edgesToDelete: [],
      });
      await broker.applyProposal(prop);

      // Tamper with events.jsonl
      const eventsFile = join(rootDir, ".oma", "ledger", "events.jsonl");
      const content = readFileSync(eventsFile, "utf8");
      writeFileSync(eventsFile, content.replace("oma-planner", "malicious-hacker"), "utf8");

      // Re-opening journal must fail integrity check
      assert.throws(
        () => new JournalStore(eventsFile),
        (err: unknown) =>
          err instanceof Error &&
          /Event hash mismatch/i.test(err.message),
      );

      // GraphBroker must reject subsequent proposals when journal is corrupted
      const freshRuntime = loadGraphRuntime(rootDir);
      const nextProp = createProposal(freshRuntime, {
        nodesToAdd: [
          {
            id: "node_D",
            title: "Task D",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-executor" },
          },
        ],
        edgesToAdd: [],
        edgesToDelete: [],
      });

      const applyRes = await broker.applyProposal(nextProp);
      assert.equal(applyRes.success, false);
      assert.equal(applyRes.code, "JOURNAL_INTEGRITY_MISMATCH");
    });
  });

  // ==========================================================================
  // TIER 4: Dynamic Workflow Simulation (10+ Nodes, Fan-out, Fan-in & Failure)
  // ==========================================================================
  describe("Tier 4: Complex Dynamic Workflow Simulation (13 Nodes, 5 Revisions)", () => {
    it("executes a complete dynamic mission lifecycle across 5 revisions and 13 nodes", async () => {
      // Step 0: Initialize Root Mission Node (Rev 1)
      const initialGraph: ExecutionGraph = {
        schemaVersion: 2,
        graphId: "mission_dynamic_e2e",
        revision: 1,
        schedulerAuthorityId: "oma-scheduler",
        nodes: [
          {
            id: "node_init",
            title: "Mission Initialization & Scope Contract",
            kind: "human",
            activation: "all",
            completionAuthority: "human",
            completionAuthorityId: "user",
          },
        ],
        edges: [],
      };

      const { runtime } = setupFixture(initialGraph);

      // Execute node_init
      appendGraphTransition(runtime, {
        eventType: "node_dispatched",
        nodeId: "node_init",
        dispatchId: "disp_init",
        authorityId: "oma-scheduler",
      });
      appendGraphTransition(runtime, {
        eventType: "node_completed",
        nodeId: "node_init",
        dispatchId: "disp_init",
        authority: "human",
        authorityId: "user",
        outcome: "success",
        evidenceHash: "1".repeat(64),
      });

      // ----------------------------------------------------------------------
      // Step 1: Expansion to Rev 2 (Fan-out 3 parallel analysis nodes + join)
      // ----------------------------------------------------------------------
      let currentRuntime = loadGraphRuntime(rootDir);
      const propRev2 = createProposal(currentRuntime, {
        nodesToAdd: [
          {
            id: "analysis_fe",
            title: "Frontend Analysis",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-explorer" },
            scope: ["src/ui"],
          },
          {
            id: "analysis_be",
            title: "Backend Analysis",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-explorer" },
            scope: ["src/api"],
          },
          {
            id: "analysis_db",
            title: "Database Schema Analysis",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-explorer" },
            scope: ["src/db"],
          },
          {
            id: "analysis_join",
            title: "Consolidate Analysis",
            kind: "join",
            activation: "all",
            completionAuthority: "scheduler",
            completionAuthorityId: "oma-scheduler",
          },
        ],
        edgesToAdd: [
          { id: "e_init_fe", from: "node_init", to: "analysis_fe", when: "success" },
          { id: "e_init_be", from: "node_init", to: "analysis_be", when: "success" },
          { id: "e_init_db", from: "node_init", to: "analysis_db", when: "success" },
          { id: "e_fe_join", from: "analysis_fe", to: "analysis_join", when: "success" },
          { id: "e_be_join", from: "analysis_be", to: "analysis_join", when: "success" },
          { id: "e_db_join", from: "analysis_db", to: "analysis_join", when: "success" },
        ],
        edgesToDelete: [],
      });

      const resRev2 = await broker.applyProposal(propRev2);
      assert.equal(resRev2.success, true);
      assert.equal(resRev2.revision, 2);

      // Dispatch and complete the 3 analysis nodes and the join
      currentRuntime = loadGraphRuntime(rootDir);
      for (const node of ["analysis_fe", "analysis_be", "analysis_db"]) {
        appendGraphTransition(currentRuntime, {
          eventType: "node_dispatched",
          nodeId: node,
          dispatchId: `disp_${node}`,
          authorityId: "oma-scheduler",
        });
        appendGraphTransition(currentRuntime, {
          eventType: "node_completed",
          nodeId: node,
          dispatchId: `disp_${node}`,
          authority: "broker",
          authorityId: "oma-broker",
          outcome: "success",
          evidenceHash: "2".repeat(64),
        });
      }
      appendGraphTransition(currentRuntime, {
        eventType: "node_dispatched",
        nodeId: "analysis_join",
        dispatchId: "disp_join_1",
        authorityId: "oma-scheduler",
      });
      appendGraphTransition(currentRuntime, {
        eventType: "node_completed",
        nodeId: "analysis_join",
        dispatchId: "disp_join_1",
        authority: "scheduler",
        authorityId: "oma-scheduler",
        outcome: "success",
        evidenceHash: "3".repeat(64),
      });

      // ----------------------------------------------------------------------
      // Step 2: Expansion to Rev 3 (Fan-out 4 parallel implementation nodes)
      // ----------------------------------------------------------------------
      currentRuntime = loadGraphRuntime(rootDir);
      const propRev3 = createProposal(currentRuntime, {
        nodesToAdd: [
          {
            id: "impl_auth",
            title: "Auth Service Implementation",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-executor" },
            scope: ["src/auth"],
          },
          {
            id: "impl_api",
            title: "REST Endpoints",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-executor" },
            scope: ["src/api/routes"],
          },
          {
            id: "impl_ui",
            title: "React UI Components",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-executor" },
            scope: ["src/ui/components"],
          },
          {
            id: "impl_db",
            title: "Migration Scripts",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-executor" },
            scope: ["src/db/migrations"],
          },
        ],
        edgesToAdd: [
          { id: "e_join_auth", from: "analysis_join", to: "impl_auth", when: "success" },
          { id: "e_join_api", from: "analysis_join", to: "impl_api", when: "success" },
          { id: "e_join_ui", from: "analysis_join", to: "impl_ui", when: "success" },
          { id: "e_join_db", from: "analysis_join", to: "impl_db", when: "success" },
        ],
        edgesToDelete: [],
      });

      const resRev3 = await broker.applyProposal(propRev3);
      assert.equal(resRev3.success, true);
      assert.equal(resRev3.revision, 3);

      // Execute impl_api, impl_ui, impl_db as success; impl_auth fails!
      currentRuntime = loadGraphRuntime(rootDir);
      for (const node of ["impl_api", "impl_ui", "impl_db"]) {
        appendGraphTransition(currentRuntime, {
          eventType: "node_dispatched",
          nodeId: node,
          dispatchId: `disp_${node}`,
          authorityId: "oma-scheduler",
        });
        appendGraphTransition(currentRuntime, {
          eventType: "node_completed",
          nodeId: node,
          dispatchId: `disp_${node}`,
          authority: "broker",
          authorityId: "oma-broker",
          outcome: "success",
          evidenceHash: "4".repeat(64),
        });
      }

      // Failure of impl_auth
      appendGraphTransition(currentRuntime, {
        eventType: "node_dispatched",
        nodeId: "impl_auth",
        dispatchId: "disp_impl_auth",
        authorityId: "oma-scheduler",
      });
      appendGraphTransition(currentRuntime, {
        eventType: "node_completed",
        nodeId: "impl_auth",
        dispatchId: "disp_impl_auth",
        authority: "broker",
        authorityId: "oma-broker",
        outcome: "failure",
        evidenceHash: "5".repeat(64),
      });

      // ----------------------------------------------------------------------
      // Step 3: Expansion to Rev 4 (Remediation branch on failure)
      // ----------------------------------------------------------------------
      currentRuntime = loadGraphRuntime(rootDir);
      const propRev4 = createProposal(currentRuntime, {
        nodesToAdd: [
          {
            id: "diag_auth",
            title: "Diagnose Auth Failure",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-forensic" },
            scope: ["src/auth"],
          },
          {
            id: "fix_auth_patch",
            title: "Apply Auth Security Patch",
            kind: "agent",
            activation: "all",
            completionAuthority: "broker",
            completionAuthorityId: "oma-broker",
            executor: { adapter: "antigravity", persona: "oma-repairer" },
            scope: ["src/auth"],
          },
        ],
        edgesToAdd: [
          { id: "e_auth_diag", from: "impl_auth", to: "diag_auth", when: "failure" },
          { id: "e_diag_fix", from: "diag_auth", to: "fix_auth_patch", when: "success" },
        ],
        edgesToDelete: [],
      });

      const resRev4 = await broker.applyProposal(propRev4);
      assert.equal(resRev4.success, true);
      assert.equal(resRev4.revision, 4);

      // Execute remediation nodes
      currentRuntime = loadGraphRuntime(rootDir);
      for (const node of ["diag_auth", "fix_auth_patch"]) {
        appendGraphTransition(currentRuntime, {
          eventType: "node_dispatched",
          nodeId: node,
          dispatchId: `disp_${node}`,
          authorityId: "oma-scheduler",
        });
        appendGraphTransition(currentRuntime, {
          eventType: "node_completed",
          nodeId: node,
          dispatchId: `disp_${node}`,
          authority: "broker",
          authorityId: "oma-broker",
          outcome: "success",
          evidenceHash: "6".repeat(64),
        });
      }

      // ----------------------------------------------------------------------
      // Step 4: Expansion to Rev 5 (Final Quality Gate & Signoff Join)
      // ----------------------------------------------------------------------
      currentRuntime = loadGraphRuntime(rootDir);
      const propRev5 = createProposal(currentRuntime, {
        nodesToAdd: [
          {
            id: "gate_e2e",
            title: "Oracle Integration Verification Gate",
            kind: "gate",
            activation: "all",
            completionAuthority: "oracle",
            completionAuthorityId: "oma-oracle",
          },
          {
            id: "mission_complete",
            title: "Final Mission Signoff",
            kind: "human",
            activation: "all",
            completionAuthority: "human",
            completionAuthorityId: "user",
          },
        ],
        edgesToAdd: [
          { id: "e_patch_gate", from: "fix_auth_patch", to: "gate_e2e", when: "success" },
          { id: "e_api_gate", from: "impl_api", to: "gate_e2e", when: "success" },
          { id: "e_ui_gate", from: "impl_ui", to: "gate_e2e", when: "success" },
          { id: "e_db_gate", from: "impl_db", to: "gate_e2e", when: "success" },
          { id: "e_gate_signoff", from: "gate_e2e", to: "mission_complete", when: "success" },
        ],
        edgesToDelete: [],
      });

      const resRev5 = await broker.applyProposal(propRev5);
      assert.equal(resRev5.success, true);
      assert.equal(resRev5.revision, 5);

      // Execute Gate and Signoff
      currentRuntime = loadGraphRuntime(rootDir);
      appendGraphTransition(currentRuntime, {
        eventType: "node_dispatched",
        nodeId: "gate_e2e",
        dispatchId: "disp_gate",
        authorityId: "oma-scheduler",
      });
      appendGraphTransition(currentRuntime, {
        eventType: "node_completed",
        nodeId: "gate_e2e",
        dispatchId: "disp_gate",
        authority: "oracle",
        authorityId: "oma-oracle",
        outcome: "success",
        evidenceHash: "7".repeat(64),
      });

      appendGraphTransition(currentRuntime, {
        eventType: "node_dispatched",
        nodeId: "mission_complete",
        dispatchId: "disp_final",
        authorityId: "oma-scheduler",
      });
      appendGraphTransition(currentRuntime, {
        eventType: "node_completed",
        nodeId: "mission_complete",
        dispatchId: "disp_final",
        authority: "human",
        authorityId: "user",
        outcome: "success",
        evidenceHash: "8".repeat(64),
      });

      // ----------------------------------------------------------------------
      // Final End-to-End Invariant Assertions
      // ----------------------------------------------------------------------
      const finalRuntime = loadGraphRuntime(rootDir);
      const storeVerification = verifyGraphStore(finalRuntime);

      assert.equal(storeVerification.valid, true, storeVerification.errors.join("\n"));
      assert.equal(finalRuntime.graph.revision, 5);
      assert.equal(finalRuntime.graph.nodes.length, 13, "Expected exactly 13 nodes in graph");
      assert.equal(finalRuntime.graph.edges.length, 17, "Expected exactly 17 edges in graph");

      const finalProjection = projectGraph(finalRuntime.graph, storeVerification.events);
      assert.equal(finalProjection.status, "succeeded");
      assert.equal(finalProjection.readySet.length, 0);

      // Verify all 13 nodes reached terminal state
      assert.equal(
        finalProjection.nodes.filter((n) => n.state === "succeeded" || n.state === "failed").length,
        13,
      );

      // Verify cryptographic journal integrity across entire execution
      const allEvents = journalStore.readEvents();
      assert.equal(allEvents.length, 4, "Expected 4 revision_published events");
      assert.equal(journalStore.verifyIntegrity().valid, true);
    });
  });
});
