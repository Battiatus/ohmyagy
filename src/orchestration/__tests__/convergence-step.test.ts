import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  evaluateConvergenceStep,
  type DynamicWorkflowLimits,
} from "../convergence-step.js";
import type { ExecutionGraph, GraphEvent } from "../../graph/model.js";
import type { ProgressVector } from "../../oracle/objective-judge.js";

describe("evaluateConvergenceStep Unit Tests (T3.2)", () => {
  const defaultLimits: DynamicWorkflowLimits = {
    maxRounds: 5,
    maxTimeMs: 60_000,
    maxConsecutiveNoProgressRounds: 2,
  };

  const simpleGraph: ExecutionGraph = {
    schemaVersion: 2,
    graphId: "graph-test",
    revision: 1,
    schedulerAuthorityId: "scheduler-1",
    nodes: [
      {
        id: "task-1",
        title: "Task 1",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
      },
      {
        id: "task-2",
        title: "Task 2",
        kind: "agent",
        activation: "all",
        completionAuthority: "broker",
        completionAuthorityId: "oma-broker",
      },
    ],
    edges: [
      {
        id: "edge-1-2",
        from: "task-1",
        to: "task-2",
        when: "success",
      },
    ],
  };

  it("extracts ready nodes correctly on initial graph", () => {
    const events: GraphEvent[] = [];
    const progressHistory: ProgressVector[] = [];

    const result = evaluateConvergenceStep({
      graph: simpleGraph,
      events,
      progressHistory,
      limits: defaultLimits,
    });

    assert.equal(result.status, "in_progress");
    assert.equal(result.readyNodes.length, 1);
    assert.equal(result.readyNodes[0].id, "task-1");
    assert.equal(result.consecutiveNoProgressRounds, 0);
  });

  it("handles progress improvement across successive waves without blocking", () => {
    const v1: ProgressVector = {
      hiddenTestsFailing: 3,
      hiddenTestsPassed: 1,
      visibleTestsFailing: 2,
      visibleTestsPassed: 1,
      gateFailures: 1,
      openDiagnosticsCount: 3,
      acceptedWorkItems: 0,
      totalWorkItems: 2,
    };

    const v2: ProgressVector = {
      hiddenTestsFailing: 1, // Improved!
      hiddenTestsPassed: 3,
      visibleTestsFailing: 0, // Improved!
      visibleTestsPassed: 3,
      gateFailures: 1,
      openDiagnosticsCount: 1,
      acceptedWorkItems: 1,
      totalWorkItems: 2,
    };

    const result = evaluateConvergenceStep({
      graph: simpleGraph,
      events: [],
      progressHistory: [v1, v2],
      limits: defaultLimits,
    });

    assert.equal(result.status, "in_progress");
    assert.equal(result.consecutiveNoProgressRounds, 0);
    // Work-item counters are owned by the GRAPH, not echoed back from the
    // caller's history: no node completed here, so nothing is accepted however
    // optimistic the supplied vector is. The improvement itself is still
    // measured — that is what keeps consecutiveNoProgressRounds at 0.
    assert.equal(result.progress.acceptedWorkItems, 0);
  });

  it("detects 2-round stagnation and produces no_progress_blocked", () => {
    const stagnantVector: ProgressVector = {
      hiddenTestsFailing: 2,
      hiddenTestsPassed: 1,
      visibleTestsFailing: 1,
      visibleTestsPassed: 1,
      gateFailures: 1,
      openDiagnosticsCount: 2,
      acceptedWorkItems: 0,
      totalWorkItems: 2,
    };

    // 3 identical vectors = 2 consecutive non-improving transitions (v0->v1, v1->v2)
    const result = evaluateConvergenceStep({
      graph: simpleGraph,
      events: [],
      progressHistory: [stagnantVector, stagnantVector, stagnantVector],
      limits: defaultLimits,
    });

    assert.equal(result.status, "no_progress_blocked");
    assert.equal(result.consecutiveNoProgressRounds, 2);
    assert.ok(result.diagnosis?.includes("Stagnation detected"));
  });

  it("does not prematurely block after only 1 round of stagnation", () => {
    const v1: ProgressVector = {
      hiddenTestsFailing: 2,
      hiddenTestsPassed: 1,
      visibleTestsFailing: 1,
      visibleTestsPassed: 1,
      gateFailures: 1,
      openDiagnosticsCount: 2,
      acceptedWorkItems: 0,
      totalWorkItems: 2,
    };

    // 2 identical vectors = 1 non-improving transition
    const result = evaluateConvergenceStep({
      graph: simpleGraph,
      events: [],
      progressHistory: [v1, v1],
      limits: defaultLimits,
    });

    assert.equal(result.status, "in_progress");
    assert.equal(result.consecutiveNoProgressRounds, 1);
  });

  it("resets stagnation counter when progress occurs after a stagnant round", () => {
    const v1: ProgressVector = {
      hiddenTestsFailing: 3,
      hiddenTestsPassed: 0,
      visibleTestsFailing: 2,
      visibleTestsPassed: 0,
      gateFailures: 1,
      openDiagnosticsCount: 3,
      acceptedWorkItems: 0,
      totalWorkItems: 2,
    };
    const v2: ProgressVector = { ...v1 }; // Stagnant (1 round)
    const v3: ProgressVector = {
      ...v1,
      hiddenTestsFailing: 1, // Improved!
      acceptedWorkItems: 1,
    };

    const result = evaluateConvergenceStep({
      graph: simpleGraph,
      events: [],
      progressHistory: [v1, v2, v3],
      limits: defaultLimits,
    });

    assert.equal(result.status, "in_progress");
    assert.equal(result.consecutiveNoProgressRounds, 0);
  });

  it("does not declare success on isIntegrated alone when nothing was delivered", () => {
    const vClean: ProgressVector = {
      hiddenTestsFailing: 0,
      hiddenTestsPassed: 4,
      visibleTestsFailing: 0,
      visibleTestsPassed: 4,
      gateFailures: 0,
      openDiagnosticsCount: 0,
      acceptedWorkItems: 2,
      totalWorkItems: 2,
    };

    const result = evaluateConvergenceStep({
      graph: simpleGraph,
      events: [],
      progressHistory: [vClean],
      limits: defaultLimits,
      isIntegrated: true,
    });

    // This is the contract. `isIntegrated` states that integration happened; it
    // is not evidence that anything was delivered. It used to short-circuit the
    // whole evaluation and return `succeeded` with zero completed nodes.
    assert.notEqual(result.status, "succeeded");
    assert.equal(result.progress.acceptedWorkItems, 0);
  });

  it("declares budget_exhausted when round limit is reached", () => {
    const v1: ProgressVector = {
      hiddenTestsFailing: 2,
      hiddenTestsPassed: 1,
      visibleTestsFailing: 1,
      visibleTestsPassed: 1,
      gateFailures: 1,
      openDiagnosticsCount: 2,
      acceptedWorkItems: 0,
      totalWorkItems: 2,
    };

    const limitsWith2Rounds: DynamicWorkflowLimits = {
      ...defaultLimits,
      maxRounds: 2,
      maxConsecutiveNoProgressRounds: 10,
    };

    const result = evaluateConvergenceStep({
      graph: simpleGraph,
      events: [],
      progressHistory: [v1, { ...v1, visibleTestsFailing: 0 }], // Progress was made, so not stagnation
      limits: limitsWith2Rounds,
      currentRound: 2,
    });

    assert.equal(result.status, "budget_exhausted");
    assert.ok(result.diagnosis?.includes("Round budget exhausted"));
  });

  it("declares budget_exhausted when time limit is exceeded", () => {
    const v1: ProgressVector = {
      hiddenTestsFailing: 1,
      hiddenTestsPassed: 1,
      visibleTestsFailing: 0,
      visibleTestsPassed: 1,
      gateFailures: 1,
      openDiagnosticsCount: 1,
      acceptedWorkItems: 0,
      totalWorkItems: 2,
    };

    const startTime = 1000;
    const currentTime = startTime + defaultLimits.maxTimeMs + 100;

    const result = evaluateConvergenceStep({
      graph: simpleGraph,
      events: [],
      progressHistory: [v1],
      limits: defaultLimits,
      startTimeMs: startTime,
      currentTimeMs: currentTime,
    });

    assert.equal(result.status, "budget_exhausted");
    assert.ok(result.diagnosis?.includes("Time budget exhausted"));
  });

  it("handles terminal failure when graph projection status is failed", () => {
    const singleNodeGraph: ExecutionGraph = {
      schemaVersion: 2,
      graphId: "graph-single",
      revision: 1,
      schedulerAuthorityId: "scheduler-1",
      nodes: [
        {
          id: "task-fail",
          title: "Failing task",
          kind: "agent",
          activation: "all",
          completionAuthority: "broker",
          completionAuthorityId: "oma-broker",
        },
      ],
      edges: [],
    };

    const events: GraphEvent[] = [
      {
        sequence: 1,
        timestamp: new Date().toISOString(),
        graphId: "graph-single",
        graphRevision: 1,
        graphHash: "hash-0",
        nodeId: "task-fail",
        dispatchId: "disp-fail",
        authority: "scheduler",
        authorityId: "scheduler-1",
        previousHash: "prev-0",
        eventHash: "event-1",
        eventType: "node_dispatched",
      },
      {
        sequence: 2,
        timestamp: new Date().toISOString(),
        graphId: "graph-single",
        graphRevision: 1,
        graphHash: "hash-0",
        nodeId: "task-fail",
        dispatchId: "disp-fail",
        authority: "broker",
        authorityId: "oma-broker",
        previousHash: "event-1",
        eventHash: "event-2",
        eventType: "node_completed",
        outcome: "failure",
        evidenceHash: "ev-fail",
      },
    ];

    const result = evaluateConvergenceStep({
      graph: singleNodeGraph,
      events,
      progressHistory: [],
      limits: defaultLimits,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.readyNodes.length, 0);
    assert.ok(result.diagnosis?.includes("Graph execution failed"));
  });

  it("handles cloned or deserialized currentProgress without false stagnation blocking", () => {
    const v1: ProgressVector = {
      hiddenTestsFailing: 2,
      hiddenTestsPassed: 1,
      visibleTestsFailing: 1,
      visibleTestsPassed: 1,
      gateFailures: 1,
      openDiagnosticsCount: 2,
      acceptedWorkItems: 0,
      totalWorkItems: 2,
    };
    const v2: ProgressVector = { ...v1 }; // 1 round of stagnation

    // When currentProgress is passed as a cloned object (like from JSON / MCP),
    // it must not be appended as a duplicate 3rd round
    const result = evaluateConvergenceStep({
      graph: simpleGraph,
      events: [],
      progressHistory: [v1, v2],
      currentProgress: { ...v2 },
      limits: defaultLimits,
    });

    assert.equal(result.status, "in_progress");
    assert.equal(result.consecutiveNoProgressRounds, 1);
    assert.equal(result.totalRounds, 2);
  });

  it("rejects succeeded status when isIntegrated is explicitly false despite nodes succeeded", () => {
    const allSucceededGraph: ExecutionGraph = {
      schemaVersion: 2,
      graphId: "graph-ok",
      revision: 1,
      schedulerAuthorityId: "scheduler-1",
      nodes: [
        {
          id: "task-done",
          title: "Done task",
          kind: "agent",
          activation: "all",
          completionAuthority: "broker",
          completionAuthorityId: "oma-broker",
        },
      ],
      edges: [],
    };

    const events: GraphEvent[] = [
      {
        sequence: 1,
        timestamp: new Date().toISOString(),
        graphId: "graph-ok",
        graphRevision: 1,
        graphHash: "hash-0",
        nodeId: "task-done",
        dispatchId: "disp-1",
        authority: "scheduler",
        authorityId: "scheduler-1",
        previousHash: "prev-0",
        eventHash: "ev-1",
        eventType: "node_dispatched",
      },
      {
        sequence: 2,
        timestamp: new Date().toISOString(),
        graphId: "graph-ok",
        graphRevision: 1,
        graphHash: "hash-0",
        nodeId: "task-done",
        dispatchId: "disp-1",
        authority: "broker",
        authorityId: "oma-broker",
        previousHash: "ev-1",
        eventHash: "ev-2",
        eventType: "node_completed",
        outcome: "success",
        evidenceHash: "ev-done",
      },
    ];

    const cleanProgress: ProgressVector = {
      hiddenTestsFailing: 0,
      hiddenTestsPassed: 2,
      visibleTestsFailing: 0,
      visibleTestsPassed: 2,
      gateFailures: 0,
      openDiagnosticsCount: 0,
      acceptedWorkItems: 1,
      totalWorkItems: 1,
    };

    // Even if graph succeeded and test counts are clean, explicit isIntegrated: false blocks succeeded
    const result = evaluateConvergenceStep({
      graph: allSucceededGraph,
      events,
      progressHistory: [cleanProgress],
      limits: defaultLimits,
      isIntegrated: false,
    });

    assert.notEqual(result.status, "succeeded");
    assert.equal(result.status, "in_progress");
  });

  it("evaluates stalled graph with failed nodes and 0 ready nodes as failed", () => {
    const blockedGraph: ExecutionGraph = {
      schemaVersion: 2,
      graphId: "graph-stalled",
      revision: 1,
      schedulerAuthorityId: "scheduler-1",
      nodes: [
        {
          id: "task-a",
          title: "Task A",
          kind: "agent",
          activation: "all",
          completionAuthority: "broker",
          completionAuthorityId: "oma-broker",
        },
        {
          id: "task-b",
          title: "Task B",
          kind: "agent",
          activation: "all",
          completionAuthority: "broker",
          completionAuthorityId: "oma-broker",
        },
      ],
      edges: [
        {
          id: "edge-a-b",
          from: "task-a",
          to: "task-b",
          when: "success",
        },
      ],
    };

    // Task A failed -> Task B is blocked -> 0 ready nodes, graph stalled with failure
    const events: GraphEvent[] = [
      {
        sequence: 1,
        timestamp: new Date().toISOString(),
        graphId: "graph-stalled",
        graphRevision: 1,
        graphHash: "hash-0",
        nodeId: "task-a",
        dispatchId: "disp-a",
        authority: "scheduler",
        authorityId: "scheduler-1",
        previousHash: "prev-0",
        eventHash: "ev-a1",
        eventType: "node_dispatched",
      },
      {
        sequence: 2,
        timestamp: new Date().toISOString(),
        graphId: "graph-stalled",
        graphRevision: 1,
        graphHash: "hash-0",
        nodeId: "task-a",
        dispatchId: "disp-a",
        authority: "broker",
        authorityId: "oma-broker",
        previousHash: "ev-a1",
        eventHash: "ev-a2",
        eventType: "node_completed",
        outcome: "failure",
        evidenceHash: "ev-fail",
      },
    ];

    const result = evaluateConvergenceStep({
      graph: blockedGraph,
      events,
      progressHistory: [],
      limits: defaultLimits,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.readyNodes.length, 0);
  });
});
