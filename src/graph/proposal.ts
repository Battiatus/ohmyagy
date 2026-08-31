import {
  canonicalJson,
  isRecord,
  sha256,
} from "../ledger/canonical.js";
import type {
  GraphEdge,
  GraphNode,
  GraphNodeAcceptance,
  GraphNodeKind,
  GraphAuthority,
  GraphExecutor,
  GraphNodeMaxDiff,
} from "./model.js";

/**
 * Supported operations within a GraphProposal.
 */
export type GraphProposalOperation =
  | {
      type: "add_node";
      node: GraphNode;
    }
  | {
      type: "add_edge";
      edge: GraphEdge;
    }
  | {
      type: "remove_edge";
      edge: {
        id?: string;
        from: string;
        to: string;
      };
    };

export type ProposalOperation = GraphProposalOperation;

/**
 * Resource budget deltas allocated to this extension.
 */
export interface ProposalResourceBudgetDelta {
  maxAdditionalTokens?: number;
  maxAdditionalTimeMs?: number;
  maxAdditionalNodes?: number;
}

export type GraphResourceBudgetsDelta = ProposalResourceBudgetDelta;

/**
 * Structured rationale explaining the motivation and evidence for graph mutation.
 */
export interface ProposalRationale {
  summary: string;
  evidenceNodeId?: string;
  evidenceHash?: string;
}

export type GraphProposalRationale = ProposalRationale;

/**
 * Delta representation of graph mutations.
 */
export interface GraphProposalDelta {
  nodesToAdd: GraphNode[];
  nodesToModify?: Array<Partial<GraphNode> & { id: string }>;
  edgesToAdd: GraphEdge[];
  edgesToDelete?: string[];
}

/**
 * The normative GraphProposal data model.
 */
export interface GraphProposal {
  schemaVersion: 1 | 2;
  proposalId: string;
  expectedRevision?: number;
  parentRevision?: number;
  author?: string;
  proposerPersona?: string;
  reason?: string;
  missionId?: string;
  parentGraphHash?: string;
  parentJournalHeadHash?: string;
  rationale?: ProposalRationale;
  resourceBudgetsDelta?: ProposalResourceBudgetDelta;
  operations?: GraphProposalOperation[];
  delta?: GraphProposalDelta;
  proposalDigest?: string;
}

/**
 * Rejection codes for malformed proposals.
 */
export type ProposalRejectionCode =
  | "MALFORMED_PROPOSAL"
  | "INVALID_OPERATION"
  | "INVALID_NODE"
  | "INVALID_EDGE"
  | "SCHEMA_VIOLATION"
  | "DIGEST_MISMATCH"
  | "UNSUPPORTED_SCHEMA_VERSION";

export class ProposalValidationError extends Error {
  constructor(
    public readonly code: ProposalRejectionCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProposalValidationError";
  }
}

const proposalIdPattern = /^prop_[a-z0-9_.-]{3,64}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

/**
 * Calculates canonical SHA-256 digest of a GraphProposal (excluding proposalDigest).
 */
export function calculateProposalDigest(
  proposal: Omit<GraphProposal, "proposalDigest"> | GraphProposal,
): string {
  const { proposalDigest, ...unsigned } = proposal as GraphProposal;
  return sha256(canonicalJson(unsigned));
}

/**
 * Validates and parses an unknown input into a strictly checked GraphProposal.
 */
export function parseGraphProposal(input: unknown): GraphProposal {
  if (!isRecord(input)) {
    throw new ProposalValidationError(
      "MALFORMED_PROPOSAL",
      "GraphProposal must be a non-null object.",
    );
  }

  const allowedKeys = [
    "schemaVersion",
    "proposalId",
    "expectedRevision",
    "parentRevision",
    "author",
    "proposerPersona",
    "reason",
    "missionId",
    "parentGraphHash",
    "parentJournalHeadHash",
    "rationale",
    "resourceBudgetsDelta",
    "operations",
    "delta",
    "proposalDigest",
  ];

  assertExactKeys(
    input,
    allowedKeys,
    "GraphProposal",
    [
      "expectedRevision",
      "parentRevision",
      "author",
      "proposerPersona",
      "reason",
      "missionId",
      "parentGraphHash",
      "parentJournalHeadHash",
      "rationale",
      "resourceBudgetsDelta",
      "operations",
      "delta",
      "proposalDigest",
    ],
  );

  const schemaVersion = input.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new ProposalValidationError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Unsupported proposal schema version: ${String(schemaVersion)}`,
    );
  }

  if (typeof input.proposalId !== "string" || !proposalIdPattern.test(input.proposalId)) {
    throw new ProposalValidationError(
      "SCHEMA_VIOLATION",
      `Invalid proposalId "${String(input.proposalId)}": must match ${proposalIdPattern.toString()}`,
    );
  }
  const proposalId = input.proposalId;

  const expectedRevValue = input.expectedRevision ?? input.parentRevision;
  if (expectedRevValue === undefined) {
    throw new ProposalValidationError(
      "SCHEMA_VIOLATION",
      "GraphProposal requires expectedRevision or parentRevision",
    );
  }
  const expectedRevision = requirePositiveInteger({ expectedRevision: expectedRevValue }, "expectedRevision");

  const authorValue = input.author ?? input.proposerPersona;
  if (authorValue === undefined) {
    throw new ProposalValidationError(
      "SCHEMA_VIOLATION",
      "GraphProposal requires author or proposerPersona",
    );
  }
  const author = requireString({ author: authorValue }, "author");

  let reason = typeof input.reason === "string" ? input.reason : undefined;

  let missionId: string | undefined;
  if ("missionId" in input && input.missionId !== undefined) {
    missionId = requireString(input, "missionId");
  }

  let parentGraphHash: string | undefined;
  if ("parentGraphHash" in input && input.parentGraphHash !== undefined) {
    parentGraphHash = requireSha256(input, "parentGraphHash");
  }

  let parentJournalHeadHash: string | undefined;
  if ("parentJournalHeadHash" in input && input.parentJournalHeadHash !== undefined) {
    parentJournalHeadHash = requireSha256(input, "parentJournalHeadHash");
  }

  let rationale: ProposalRationale | undefined;
  if ("rationale" in input && input.rationale !== undefined) {
    if (!isRecord(input.rationale)) {
      throw new ProposalValidationError(
        "SCHEMA_VIOLATION",
        "rationale must be an object",
      );
    }
    assertExactKeys(input.rationale, ["summary", "evidenceNodeId", "evidenceHash"], "rationale", [
      "evidenceNodeId",
      "evidenceHash",
    ]);
    const summary = requireString(input.rationale, "summary");
    if (summary.length < 10) {
      throw new ProposalValidationError(
        "SCHEMA_VIOLATION",
        `Rationale summary must be at least 10 characters, got ${summary.length}`,
      );
    }
    if (!reason) reason = summary;
    rationale = {
      summary,
      ...(typeof input.rationale.evidenceNodeId === "string"
        ? { evidenceNodeId: input.rationale.evidenceNodeId }
        : {}),
      ...(typeof input.rationale.evidenceHash === "string"
        ? { evidenceHash: requireSha256(input.rationale, "evidenceHash") }
        : {}),
    };
  }

  if (!reason) {
    throw new ProposalValidationError(
      "SCHEMA_VIOLATION",
      "GraphProposal requires reason or rationale.summary",
    );
  }

  let resourceBudgetsDelta: ProposalResourceBudgetDelta | undefined;
  if ("resourceBudgetsDelta" in input && input.resourceBudgetsDelta !== undefined) {
    if (!isRecord(input.resourceBudgetsDelta)) {
      throw new ProposalValidationError(
        "SCHEMA_VIOLATION",
        "resourceBudgetsDelta must be an object",
      );
    }
    assertExactKeys(
      input.resourceBudgetsDelta,
      ["maxAdditionalTokens", "maxAdditionalTimeMs", "maxAdditionalNodes"],
      "resourceBudgetsDelta",
      ["maxAdditionalTokens", "maxAdditionalTimeMs", "maxAdditionalNodes"],
    );
    if (
      "maxAdditionalTokens" in input.resourceBudgetsDelta &&
      (typeof input.resourceBudgetsDelta.maxAdditionalTokens !== "number" ||
        input.resourceBudgetsDelta.maxAdditionalTokens < 0 ||
        !Number.isInteger(input.resourceBudgetsDelta.maxAdditionalTokens))
    ) {
      throw new ProposalValidationError(
        "SCHEMA_VIOLATION",
        "Resource budget values must be positive integers (maxAdditionalTokens >= 0)",
      );
    }
    if (
      "maxAdditionalTimeMs" in input.resourceBudgetsDelta &&
      (typeof input.resourceBudgetsDelta.maxAdditionalTimeMs !== "number" ||
        input.resourceBudgetsDelta.maxAdditionalTimeMs < 0 ||
        !Number.isInteger(input.resourceBudgetsDelta.maxAdditionalTimeMs))
    ) {
      throw new ProposalValidationError(
        "SCHEMA_VIOLATION",
        "Resource budget values must be positive integers (maxAdditionalTimeMs >= 0)",
      );
    }
    if ("maxAdditionalNodes" in input.resourceBudgetsDelta) {
      const val = input.resourceBudgetsDelta.maxAdditionalNodes;
      if (typeof val !== "number" || val < 1 || !Number.isInteger(val)) {
        throw new ProposalValidationError(
          "SCHEMA_VIOLATION",
          "Resource budget values must be positive integers (maxAdditionalNodes >= 1)",
        );
      }
      if (val > 20) {
        throw new ProposalValidationError(
          "SCHEMA_VIOLATION",
          `maxAdditionalNodes exceeds maximum allowed (20): got ${val}`,
        );
      }
    }
    resourceBudgetsDelta = {
      ...(typeof input.resourceBudgetsDelta.maxAdditionalTokens === "number"
        ? { maxAdditionalTokens: input.resourceBudgetsDelta.maxAdditionalTokens }
        : {}),
      ...(typeof input.resourceBudgetsDelta.maxAdditionalTimeMs === "number"
        ? { maxAdditionalTimeMs: input.resourceBudgetsDelta.maxAdditionalTimeMs }
        : {}),
      ...(typeof input.resourceBudgetsDelta.maxAdditionalNodes === "number"
        ? { maxAdditionalNodes: input.resourceBudgetsDelta.maxAdditionalNodes }
        : {}),
    };
  }

  let operations: GraphProposalOperation[] | undefined;
  let delta: GraphProposalDelta | undefined;

  if ("operations" in input && input.operations !== undefined) {
    if (!Array.isArray(input.operations) || input.operations.length === 0) {
      throw new ProposalValidationError(
        "INVALID_OPERATION",
        "GraphProposal requires at least one operation in operations array.",
      );
    }
    operations = input.operations.map((op, idx) => parseOperation(op, idx, schemaVersion));
  }

  if ("delta" in input && input.delta !== undefined) {
    if (!isRecord(input.delta)) {
      throw new ProposalValidationError(
        "INVALID_OPERATION",
        "delta must be an object",
      );
    }
    assertExactKeys(
      input.delta,
      ["nodesToAdd", "nodesToModify", "edgesToAdd", "edgesToDelete"],
      "delta",
      ["nodesToModify", "edgesToDelete"],
    );
    if (!Array.isArray(input.delta.nodesToAdd) || !Array.isArray(input.delta.edgesToAdd)) {
      throw new ProposalValidationError(
        "INVALID_OPERATION",
        "delta requires nodesToAdd and edgesToAdd arrays",
      );
    }
    const nodesToAdd = input.delta.nodesToAdd.map((node, idx) =>
      parseProposalNode(node as Record<string, unknown>, idx, schemaVersion),
    );
    const edgesToAdd = input.delta.edgesToAdd.map((edge, idx) =>
      parseProposalEdge(edge as Record<string, unknown>, idx),
    );
    let edgesToDelete: string[] | undefined;
    if ("edgesToDelete" in input.delta && input.delta.edgesToDelete !== undefined) {
      if (!Array.isArray(input.delta.edgesToDelete)) {
        throw new ProposalValidationError("INVALID_EDGE", "edgesToDelete must be an array of strings");
      }
      edgesToDelete = input.delta.edgesToDelete.map((id, idx) => {
        if (typeof id !== "string" || id.length === 0) {
          throw new ProposalValidationError("INVALID_EDGE", `Invalid edge ID at edgesToDelete[${idx}]`);
        }
        return id;
      });
    }
    let nodesToModify: Array<Partial<GraphNode> & { id: string }> | undefined;
    if ("nodesToModify" in input.delta && input.delta.nodesToModify !== undefined) {
      if (!Array.isArray(input.delta.nodesToModify)) {
        throw new ProposalValidationError("INVALID_NODE", "nodesToModify must be an array");
      }
      nodesToModify = input.delta.nodesToModify.map((entry, idx) => {
        if (!isRecord(entry) || typeof entry.id !== "string") {
          throw new ProposalValidationError("INVALID_NODE", `nodesToModify[${idx}] requires an id`);
        }
        return entry as Partial<GraphNode> & { id: string };
      });
    }
    delta = {
      nodesToAdd,
      edgesToAdd,
      ...(edgesToDelete ? { edgesToDelete } : {}),
      ...(nodesToModify ? { nodesToModify } : {}),
    };
  }

  if (!operations && !delta) {
    throw new ProposalValidationError(
      "INVALID_OPERATION",
      "GraphProposal requires either operations or delta.",
    );
  }

  const proposalObj: Record<string, unknown> = {
    schemaVersion,
    proposalId,
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    ...(input.parentRevision !== undefined ? { parentRevision: input.parentRevision } : {}),
    ...(input.author !== undefined ? { author: input.author } : {}),
    ...(input.proposerPersona !== undefined ? { proposerPersona: input.proposerPersona } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(missionId ? { missionId } : {}),
    ...(parentGraphHash ? { parentGraphHash } : {}),
    ...(parentJournalHeadHash ? { parentJournalHeadHash } : {}),
    ...(rationale ? { rationale } : {}),
    ...(resourceBudgetsDelta ? { resourceBudgetsDelta } : {}),
    ...(operations ? { operations } : {}),
    ...(delta ? { delta } : {}),
  };

  // Define non-enumerable getters for aliases and derived structures so canonicalJson is not affected
  if (input.expectedRevision === undefined) {
    Object.defineProperty(proposalObj, "expectedRevision", {
      get: () => expectedRevision,
      enumerable: false,
    });
  }
  if (input.parentRevision === undefined) {
    Object.defineProperty(proposalObj, "parentRevision", {
      get: () => expectedRevision,
      enumerable: false,
    });
  }
  if (input.author === undefined) {
    Object.defineProperty(proposalObj, "author", {
      get: () => author,
      enumerable: false,
    });
  }
  if (input.proposerPersona === undefined) {
    Object.defineProperty(proposalObj, "proposerPersona", {
      get: () => author,
      enumerable: false,
    });
  }
  if (input.reason === undefined) {
    Object.defineProperty(proposalObj, "reason", {
      get: () => reason,
      enumerable: false,
    });
  }
  if (input.operations === undefined) {
    const derivedOperations = delta
      ? [
          ...delta.nodesToAdd.map((node): GraphProposalOperation => ({ type: "add_node", node })),
          ...delta.edgesToAdd.map((edge): GraphProposalOperation => ({ type: "add_edge", edge })),
          ...(delta.edgesToDelete ?? []).map(
            (edgeId): GraphProposalOperation => ({
              type: "remove_edge",
              edge: { id: edgeId, from: "", to: "" },
            }),
          ),
        ]
      : [];
    Object.defineProperty(proposalObj, "operations", {
      get: () => derivedOperations,
      enumerable: false,
    });
  }
  if (input.delta === undefined) {
    const nodesToAdd: GraphNode[] = [];
    const edgesToAdd: GraphEdge[] = [];
    const edgesToDelete: string[] = [];
    for (const op of operations ?? []) {
      if (op.type === "add_node") nodesToAdd.push(op.node);
      else if (op.type === "add_edge") edgesToAdd.push(op.edge);
      else if (op.type === "remove_edge") {
        if (op.edge.id) edgesToDelete.push(op.edge.id);
      }
    }
    const derivedDelta: GraphProposalDelta = {
      nodesToAdd,
      edgesToAdd,
      edgesToDelete,
    };
    Object.defineProperty(proposalObj, "delta", {
      get: () => derivedDelta,
      enumerable: false,
    });
  }

  let proposalDigest: string | undefined;
  if ("proposalDigest" in input && input.proposalDigest !== undefined) {
    proposalDigest = requireSha256(input, "proposalDigest");
    const computed = calculateProposalDigest(proposalObj as unknown as GraphProposal);
    if (proposalDigest !== computed) {
      throw new ProposalValidationError(
        "DIGEST_MISMATCH",
        `Digest mismatch: expected ${computed}, got ${proposalDigest}`,
      );
    }
    proposalObj.proposalDigest = proposalDigest;
  }

  return proposalObj as unknown as GraphProposal;
}

function parseOperation(
  value: unknown,
  index: number,
  schemaVersion: 1 | 2,
): GraphProposalOperation {
  if (!isRecord(value)) {
    throw new ProposalValidationError(
      "INVALID_OPERATION",
      `Operation at index ${index} must be an object.`,
    );
  }

  const type = value.type;
  if (type === "add_node") {
    assertExactKeys(value, ["type", "node"], `operations[${index}]`);
    if (!isRecord(value.node)) {
      throw new ProposalValidationError(
        "INVALID_NODE",
        `add_node operation at index ${index} requires a node object.`,
      );
    }
    const node = parseProposalNode(value.node, index, schemaVersion);
    return { type: "add_node", node };
  }

  if (type === "add_edge") {
    assertExactKeys(value, ["type", "edge"], `operations[${index}]`);
    if (!isRecord(value.edge)) {
      throw new ProposalValidationError(
        "INVALID_EDGE",
        `add_edge operation at index ${index} requires an edge object.`,
      );
    }
    const edge = parseProposalEdge(value.edge, index);
    return { type: "add_edge", edge };
  }

  if (type === "remove_edge") {
    assertExactKeys(value, ["type", "edge"], `operations[${index}]`);
    if (!isRecord(value.edge)) {
      throw new ProposalValidationError(
        "INVALID_EDGE",
        `remove_edge operation at index ${index} requires an edge object.`,
      );
    }
    assertExactKeys(value.edge, ["id", "from", "to"], `operations[${index}].edge`, ["id", "from", "to"]);
    const from = typeof value.edge.from === "string" ? value.edge.from : "";
    const to = typeof value.edge.to === "string" ? value.edge.to : "";
    const id = typeof value.edge.id === "string" ? value.edge.id : undefined;
    return {
      type: "remove_edge",
      edge: {
        from,
        to,
        ...(id ? { id } : {}),
      },
    };
  }

  throw new ProposalValidationError(
    "INVALID_OPERATION",
    `Unsupported operation type "${String(type)}" at index ${index}.`,
  );
}

function parseProposalNode(value: Record<string, unknown>, index: number, schemaVersion: 1 | 2): GraphNode {
  const contractFields = ["scope", "acceptance", "artifacts", "maxDiff"];
  assertExactKeys(
    value,
    [
      "id",
      "title",
      "kind",
      "activation",
      "completionAuthority",
      "completionAuthorityId",
      "executor",
      ...(schemaVersion === 2 ? contractFields : []),
    ],
    `node[${index}]`,
    ["executor", ...(schemaVersion === 2 ? contractFields : [])],
  );

  const kind = requireEnum(value, "kind", ["agent", "broker", "gate", "join", "human"] as const);
  const completionAuthority = requireEnum(value, "completionAuthority", [
    "broker",
    "oracle",
    "scheduler",
    "human",
  ] as const);

  const authorityByKind: Record<GraphNodeKind, GraphAuthority> = {
    agent: "broker",
    broker: "broker",
    gate: "oracle",
    join: "scheduler",
    human: "human",
  };

  if (completionAuthority !== authorityByKind[kind]) {
    throw new ProposalValidationError(
      "INVALID_NODE",
      `Node ${requireString(value, "id")} of kind ${kind} requires ${authorityByKind[kind]} completion authority`,
    );
  }

  let executor: GraphExecutor | undefined;
  let scope: string[] | undefined;
  let acceptance: GraphNodeAcceptance[] | undefined;
  let artifacts: string[] | undefined;
  let maxDiff: GraphNodeMaxDiff | undefined;

  if (kind === "agent") {
    if (!isRecord(value.executor)) {
      throw new ProposalValidationError(
        "INVALID_NODE",
        `Agent node ${requireString(value, "id")} requires executor`,
      );
    }
    assertExactKeys(value.executor, ["adapter", "persona"], `node[${index}].executor`);
    executor = {
      adapter: requireString(value.executor, "adapter"),
      persona: requireString(value.executor, "persona"),
    };
    if (schemaVersion === 2) {
      if ("scope" in value && value.scope !== undefined) {
        scope = parseRepoPaths(value.scope, `node[${index}].scope`);
      }
      if ("acceptance" in value && value.acceptance !== undefined) {
        acceptance = parseNodeAcceptance(value.acceptance, `node[${index}].acceptance`);
      }
      if ("artifacts" in value && value.artifacts !== undefined) {
        artifacts = parseRepoPaths(value.artifacts, `node[${index}].artifacts`);
      }
      if ("maxDiff" in value && value.maxDiff !== undefined) {
        maxDiff = parseNodeMaxDiff(value.maxDiff, `node[${index}].maxDiff`);
      }
    }
  } else if (value.executor !== undefined) {
    throw new ProposalValidationError(
      "INVALID_NODE",
      `Only agent nodes may define an executor`,
    );
  }

  if (kind !== "agent") {
    for (const field of ["scope", "acceptance", "artifacts", "maxDiff"] as const) {
      if (field in value && value[field] !== undefined) {
        throw new ProposalValidationError(
          "INVALID_NODE",
          `Only agent nodes may define ${field}`,
        );
      }
    }
  }

  return {
    id: requireString(value, "id"),
    title: requireString(value, "title"),
    kind,
    activation: requireEnum(value, "activation", ["all", "any"] as const),
    completionAuthority,
    completionAuthorityId: requireString(value, "completionAuthorityId"),
    ...(executor ? { executor } : {}),
    ...(scope ? { scope } : {}),
    ...(acceptance ? { acceptance } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(maxDiff ? { maxDiff } : {}),
  };
}

function parseProposalEdge(value: Record<string, unknown>, index: number): GraphEdge {
  assertExactKeys(value, ["id", "from", "to", "when"], `edge[${index}]`, ["id"]);
  const from = requireString(value, "from");
  const to = requireString(value, "to");
  const when = requireEnum(value, "when", ["success", "failure", "always"] as const);
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : `edge_${from}_to_${to}_${when}`;
  return { id, from, to, when };
}

function parseRepoPaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProposalValidationError("INVALID_NODE", `${label} must be a non-empty array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ProposalValidationError("INVALID_NODE", `Expected non-empty ${label}[${index}]`);
    }
    if (entry.includes("\0")) throw new ProposalValidationError("INVALID_NODE", `${label}[${index}] must not contain NUL bytes`);
    if (entry.includes("\\")) throw new ProposalValidationError("INVALID_NODE", `${label}[${index}] must use forward slashes`);
    if (entry.startsWith("/") || /^[A-Za-z]:/u.test(entry)) {
      throw new ProposalValidationError("INVALID_NODE", `${label}[${index}] must be repo-relative`);
    }
    if (entry.split("/").includes("..")) {
      throw new ProposalValidationError("INVALID_NODE", `${label}[${index}] must not contain .. segments`);
    }
    return entry;
  });
}

function parseNodeAcceptance(value: unknown, label: string): GraphNodeAcceptance[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProposalValidationError("INVALID_NODE", `${label} must be a non-empty array`);
  }
  const seenIds = new Set<string>();
  return value.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (!isRecord(entry)) throw new ProposalValidationError("INVALID_NODE", `Invalid ${entryLabel}`);
    assertExactKeys(entry, ["id", "description", "gateId"], entryLabel);
    const id = requireString(entry, "id");
    if (seenIds.has(id)) {
      throw new ProposalValidationError("INVALID_NODE", `duplicate acceptance id: ${id}`);
    }
    seenIds.add(id);
    const gateId = requireString(entry, "gateId");
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(gateId)) {
      throw new ProposalValidationError("INVALID_NODE", `${entryLabel}.gateId must match /^[a-z0-9][a-z0-9-]{0,63}$/`);
    }
    return {
      id,
      description: requireString(entry, "description"),
      gateId,
    };
  });
}

function parseNodeMaxDiff(value: unknown, label: string): GraphNodeMaxDiff {
  if (!isRecord(value)) throw new ProposalValidationError("INVALID_NODE", `Invalid ${label}`);
  assertExactKeys(value, ["files", "lines"], label);
  return {
    files: requirePositiveInteger(value, "files"),
    lines: requirePositiveInteger(value, "lines"),
  };
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProposalValidationError("SCHEMA_VIOLATION", `Expected non-empty string for "${key}"`);
  }
  return value;
}

function requirePositiveInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new ProposalValidationError("SCHEMA_VIOLATION", `Expected positive integer for "${key}"`);
  }
  return Number(value);
}

function requireSha256(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key);
  if (!sha256Pattern.test(value)) {
    throw new ProposalValidationError("SCHEMA_VIOLATION", `"${key}" must be a 64-char lowercase SHA-256 hex digest`);
  }
  return value;
}

function requireEnum<const T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ProposalValidationError(
      "SCHEMA_VIOLATION",
      `Invalid "${key}": expected one of [${values.join(", ")}], got "${String(value)}"`,
    );
  }
  return value as T;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: string[],
  label: string,
  optional: string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new ProposalValidationError(
      "SCHEMA_VIOLATION",
      `${label} contains unexpected fields: ${unknown.join(", ")}`,
    );
  }
  const optionalSet = new Set(optional);
  const missing = allowed.filter((key) => !optionalSet.has(key) && !(key in record));
  if (missing.length > 0) {
    throw new ProposalValidationError(
      "SCHEMA_VIOLATION",
      `${label} is missing required fields: ${missing.join(", ")}`,
    );
  }
}
