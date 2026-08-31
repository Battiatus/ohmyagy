import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { canonicalJson, hashJson, sha256 } from "../../ledger/canonical.js";
import {
  calculateProposalDigest,
  parseGraphProposal,
  type GraphProposal,
  type ProposalOperation,
  ProposalValidationError,
} from "../proposal.js";
import type { GraphNode, GraphEdge } from "../model.js";

describe("GraphProposal Schema & Validation Suite", () => {
  const validNode: GraphNode = {
    id: "analysis_v2",
    title: "Secondary Deep Analysis",
    kind: "agent",
    activation: "all",
    completionAuthority: "broker",
    completionAuthorityId: "oma-broker",
    executor: {
      adapter: "antigravity",
      persona: "oma-explorer",
    },
    scope: ["src/graph", "src/broker"],
    acceptance: [
      {
        id: "typecheck",
        description: "TypeScript compiler pass",
        gateId: "npm-build",
      },
    ],
    artifacts: ["src/graph/proposal.ts"],
    maxDiff: { files: 3, lines: 150 },
  };

  const validEdge: GraphEdge = {
    id: "contract-to-analysis-v2",
    from: "contract",
    to: "analysis_v2",
    when: "success",
  };

  function createValidProposal(overrides?: Partial<GraphProposal>): GraphProposal {
    const raw: Omit<GraphProposal, "proposalDigest"> = {
      schemaVersion: 2,
      proposalId: "prop_dynamic_expansion_01",
      missionId: "mission_alpha_01",
      proposerPersona: "oma-planner",
      parentRevision: 1,
      parentGraphHash: "a".repeat(64),
      parentJournalHeadHash: "b".repeat(64),
      rationale: {
        summary: "Discovered complex dependency requiring dedicated analysis node.",
        evidenceNodeId: "contract",
        evidenceHash: "c".repeat(64),
      },
      delta: {
        nodesToAdd: [validNode],
        edgesToAdd: [validEdge],
        edgesToDelete: [],
      },
      resourceBudgetsDelta: {
        maxAdditionalTokens: 50000,
        maxAdditionalTimeMs: 120000,
        maxAdditionalNodes: 2,
      },
      ...(overrides || {}),
    };

    const proposalDigest = calculateProposalDigest(raw);
    return {
      ...raw,
      proposalDigest,
      ...(overrides?.proposalDigest ? { proposalDigest: overrides.proposalDigest } : {}),
    } as GraphProposal;
  }

  it("parses and validates a canonical, well-formed GraphProposal", () => {
    const proposal = createValidProposal();
    const parsed = parseGraphProposal(proposal);

    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.proposalId, "prop_dynamic_expansion_01");
    assert.equal(parsed.missionId, "mission_alpha_01");
    assert.equal(parsed.parentRevision, 1);
    assert.ok(parsed.delta);
    assert.equal(parsed.delta.nodesToAdd.length, 1);
    assert.equal(parsed.delta.nodesToAdd[0].id, "analysis_v2");
    assert.equal(parsed.delta.edgesToAdd.length, 1);
    assert.equal(parsed.delta.edgesToAdd[0].id, "contract-to-analysis-v2");
    assert.equal(parsed.proposalDigest, calculateProposalDigest(parsed));
  });

  it("calculates deterministic RFC 8785 Canonical Digest across key reordering", () => {
    const proposalA = createValidProposal();
    const proposalB = {
      proposalDigest: proposalA.proposalDigest,
      resourceBudgetsDelta: proposalA.resourceBudgetsDelta,
      delta: proposalA.delta,
      rationale: proposalA.rationale,
      parentJournalHeadHash: proposalA.parentJournalHeadHash,
      parentGraphHash: proposalA.parentGraphHash,
      parentRevision: proposalA.parentRevision,
      proposerPersona: proposalA.proposerPersona,
      missionId: proposalA.missionId,
      proposalId: proposalA.proposalId,
      schemaVersion: proposalA.schemaVersion,
    };

    const digestA = calculateProposalDigest(proposalA);
    const digestB = calculateProposalDigest(proposalB);

    assert.equal(digestA, digestB);
    assert.match(digestA, /^[a-f0-9]{64}$/);
  });

  it("rejects proposal when proposalDigest does not match payload", () => {
    const proposal = createValidProposal();
    proposal.proposalDigest = "f".repeat(64); // Tampered digest

    assert.throws(
      () => parseGraphProposal(proposal),
      (err: unknown) =>
        err instanceof ProposalValidationError &&
        /Digest mismatch/i.test(err.message),
    );
  });

  it("rejects invalid schema version", () => {
    const invalid = createValidProposal({ schemaVersion: 3 as unknown as 2 });
    assert.throws(
      () => parseGraphProposal(invalid),
      (err: unknown) =>
        err instanceof ProposalValidationError &&
        /Unsupported proposal schema version/i.test(err.message),
    );
  });

  it("rejects invalid proposalId patterns", () => {
    const invalidIds = [
      "",
      "p",
      "prop",
      "INVALID_CAPS",
      "prop_with_spaces in it",
      "prop_$pecial!",
      "a".repeat(70),
    ];

    for (const proposalId of invalidIds) {
      const invalid = createValidProposal({ proposalId });
      assert.throws(
        () => parseGraphProposal(invalid),
        (err: unknown) =>
          err instanceof ProposalValidationError &&
          /Invalid proposalId/i.test(err.message),
        `Expected proposalId '${proposalId}' to be rejected`,
      );
    }
  });

  it("rejects rationale with summary shorter than 10 characters", () => {
    const invalid = createValidProposal({
      rationale: {
        summary: "Too short",
      },
    });

    assert.throws(
      () => parseGraphProposal(invalid),
      (err: unknown) =>
        err instanceof ProposalValidationError &&
        /Rationale summary must be at least 10 characters/i.test(err.message),
    );
  });

  it("rejects excessive or invalid resource budgets delta", () => {
    // maxAdditionalNodes > 20
    const tooManyNodes = createValidProposal({
      resourceBudgetsDelta: {
        maxAdditionalTokens: 1000,
        maxAdditionalTimeMs: 1000,
        maxAdditionalNodes: 25,
      },
    });

    assert.throws(
      () => parseGraphProposal(tooManyNodes),
      (err: unknown) =>
        err instanceof ProposalValidationError &&
        /maxAdditionalNodes exceeds maximum allowed/i.test(err.message),
    );

    // Negative tokens
    const negativeTokens = createValidProposal({
      resourceBudgetsDelta: {
        maxAdditionalTokens: -100,
        maxAdditionalTimeMs: 1000,
        maxAdditionalNodes: 2,
      },
    });

    assert.throws(
      () => parseGraphProposal(negativeTokens),
      (err: unknown) =>
        err instanceof ProposalValidationError &&
        /Resource budget values must be positive integers/i.test(err.message),
    );
  });

  it("rejects unknown or forbidden fields in proposal (fail closed on hidden fields)", () => {
    const hiddenFieldProposal = {
      ...createValidProposal(),
      loopUntilDone: true,
      bypassReview: "true",
    };

    assert.throws(
      () => parseGraphProposal(hiddenFieldProposal),
      (err: unknown) =>
        err instanceof ProposalValidationError &&
        /unexpected fields/i.test(err.message),
    );
  });

  it("validates nested node contracts within delta (scope, acceptance, maxDiff)", () => {
    const invalidNodeScope: GraphNode = {
      ...validNode,
      id: "node_bad_scope",
      scope: ["/absolute/path/forbidden"],
    };

    const invalidProposal = createValidProposal({
      delta: {
        nodesToAdd: [invalidNodeScope],
        edgesToAdd: [],
        edgesToDelete: [],
      },
    });

    assert.throws(
      () => parseGraphProposal(invalidProposal),
      (err: unknown) =>
        err instanceof ProposalValidationError &&
        /must be repo-relative/i.test(err.message),
    );
  });

  it("supports operations array format", () => {
    const raw: Omit<GraphProposal, "proposalDigest"> = {
      schemaVersion: 2,
      proposalId: "prop_ops_format_01",
      expectedRevision: 1,
      author: "oma-planner",
      reason: "Adding new node via operations array format",
      operations: [
        { type: "add_node", node: validNode },
        { type: "add_edge", edge: validEdge },
      ],
    };
    const proposal = {
      ...raw,
      proposalDigest: calculateProposalDigest(raw),
    };
    const parsed = parseGraphProposal(proposal);
    assert.equal(parsed.operations?.length, 2);
    assert.equal(parsed.delta?.nodesToAdd.length, 1);
    assert.equal(parsed.delta?.edgesToAdd.length, 1);
  });

  it("rejects empty operations array", () => {
    const invalid: GraphProposal = {
      schemaVersion: 2,
      proposalId: "prop_empty_ops",
      expectedRevision: 1,
      author: "oma-planner",
      reason: "Empty operations array",
      operations: [],
    };
    assert.throws(
      () => parseGraphProposal(invalid),
      (err: unknown) =>
        err instanceof ProposalValidationError &&
        /requires at least one operation/i.test(err.message),
    );
  });
});
