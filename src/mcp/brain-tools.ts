import { basename } from "node:path";
import { BrainStore, BrainStoreError } from "../brain/brain-store.js";
import {
  MEMORY_DIMENSIONS,
  type MemoryDimension,
  type ProjectRecord,
} from "../brain/types.js";
import { isRecord } from "../ledger/canonical.js";

/**
 * MCP tool surface for the Neural Brain.
 *
 * Three idempotent JSON-RPC tools give a session skill programmatic control of
 * persistent memory: store typed memories, query them by dimension/keyword, and
 * compact an interaction round into durable high-density memory. Every tool
 * defaults its project scope to the current workspace so a skill can call them
 * without first bootstrapping a project row.
 */

export const BRAIN_TOOL_NAMES = new Set([
  "brain_store",
  "brain_query",
  "brain_summarize",
  "brain_compact",
  "project_model",
]);

/** Result statuses the broker must treat as success (not JSON-RPC errors). */
export const BRAIN_SUCCESS_STATUSES = new Set([
  "stored",
  "queried",
  "summarized",
  "compacted",
  "reported",
]);


const DIMENSION_ENUM = [...MEMORY_DIMENSIONS];

export const BRAIN_TOOL_DEFINITIONS = [
  {
    name: "brain_store",
    description:
      "Persist a typed memory entry (architectural decision, past error, run summary, project context, or user preference) into the project-scoped Neural Brain so future sessions never repeat mistakes or contradict established decisions.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Target project id. Defaults to the current workspace project.",
        },
        sessionId: { type: "string" },
        dimension: { type: "string", enum: DIMENSION_ENUM },
        title: { type: "string", minLength: 1 },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["dimension", "title", "content"],
    },
  },
  {
    name: "brain_query",
    description:
      "Recall a project's memory in one call: durable facts from `entries`/`count`, and the most recent condensed exchanges from `summaries`/`summaryCount`. A captured conversation is written to the second, so reading only the first reports zero while memory exists. Strictly scoped to one project. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Target project id. Defaults to the current workspace project.",
        },
        dimensions: {
          type: "array",
          items: { type: "string", enum: DIMENSION_ENUM },
        },
        query: { type: "string" },
        limit: { type: "number", minimum: 1 },
        includeSummaries: {
          type: "boolean",
          description:
            "Include condensed interaction summaries. Defaults to true; set false for facts only.",
        },
      },
    },
  },
  {
    name: "brain_summarize",
    description:
      "Compact one orchestration round into the Brain: records an interaction summary and, when content is given, a durable run_summary memory entry. Auto-creates a session when none is supplied and returns its id for reuse across rounds.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        sessionId: {
          type: "string",
          description: "Existing session id. When omitted a new session is started.",
        },
        objective: {
          type: "string",
          description: "Objective used when auto-starting a session.",
        },
        roundNumber: { type: "number", minimum: 0 },
        context: {
          type: "string",
          description: "Canonical context: user intent, starting situation, and context for this round.",
        },
        actions: {
          type: "string",
          description: "Canonical actions: what was actually done and the concrete outcome.",
        },
        userIntent: { type: "string" },
        actionsTaken: { type: "string" },
        outcome: { type: "string" },
        nodeRef: { type: "string" },
        title: { type: "string" },
        content: {
          type: "string",
          description: "Condensed summary stored as a run_summary memory entry.",
        },
      },
    },
  },
  {
    name: "brain_compact",
    description:
      "Compact the Neural Brain: deduplicates redundant entries, prunes older or low-confidence run summaries while strictly preserving durable dimensions, and prunes or condenses older interaction summaries.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Target project id. Defaults to the current workspace project.",
        },
        maxRunSummaries: {
          type: "number",
          description: "Maximum number of run summaries to retain per project. Default: 50.",
          minimum: 1,
        },
        runSummaryMinConfidence: {
          type: "number",
          description: "Prune run summaries with confidence strictly below this threshold. Default: 0.5.",
          minimum: 0,
          maximum: 1,
        },
        runSummaryMaxAgeMs: {
          type: "number",
          description: "Prune run summaries older than this age in milliseconds.",
          minimum: 1,
        },
        maxInteractionsPerSession: {
          type: "number",
          description: "Maximum interaction summaries to retain per session. Default: 100.",
          minimum: 1,
        },
        interactionRetentionMs: {
          type: "number",
          description: "Retention window in milliseconds for interaction summaries.",
          minimum: 1,
        },
        condenseInteractions: {
          type: "boolean",
          description: "If true, condense older interactions into a rollup summary instead of deleting. Default: false.",
        },
        deduplicationMode: {
          type: "string",
          enum: ["exact", "redundant"],
          description: "Deduplication strategy: exact or redundant (retains freshest/highest confidence). Default: redundant.",
        },
        vacuum: {
          type: "boolean",
          description: "Whether to execute SQLite VACUUM to reclaim space after pruning. Default: true.",
        },
      },
    },
  },
  {
    name: "project_model",
    description:
      "Read the durable shape of the project: which areas exploration has looked at, how often, and the most recent thing learned about each. Accumulated across missions and sessions, so a new session starts from what is already known instead of rediscovering it. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Target project id. Defaults to the current workspace project.",
        },
        limit: {
          type: "number",
          description: "Maximum components to return, most recently seen first. Default: 20.",
          minimum: 1,
        },
      },
    },
  },
] as const;


/**
 * Resolve the project a brain tool call targets. An explicit `projectId` must
 * already exist; otherwise the current workspace is ensured as a project so the
 * tools work on a blank repository without any prior setup.
 */
function resolveProject(
  brain: BrainStore,
  workspaceRoot: string,
  input: Record<string, unknown>,
): ProjectRecord {
  if (typeof input.projectId === "string" && input.projectId.trim().length > 0) {
    const project = brain.getProject(input.projectId.trim());
    if (!project) {
      throw new BrainStoreError(
        "NOT_FOUND",
        `Unknown project '${input.projectId}'`,
      );
    }
    return project;
  }
  return brain.ensureProject({
    name: basename(workspaceRoot) || "workspace",
    rootPath: workspaceRoot,
  });
}

function asDimension(value: unknown): MemoryDimension {
  if (
    typeof value !== "string" ||
    !MEMORY_DIMENSIONS.includes(value as MemoryDimension)
  ) {
    throw new BrainStoreError(
      "VALIDATION_ERROR",
      `dimension must be one of: ${DIMENSION_ENUM.join(", ")}`,
    );
  }
  return value as MemoryDimension;
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new BrainStoreError("VALIDATION_ERROR", "tags must be an array of strings");
  }
  return value;
}

function executeStore(
  brain: BrainStore,
  workspaceRoot: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const project = resolveProject(brain, workspaceRoot, input);
  const entry = brain.storeMemory({
    projectId: project.id,
    sessionId:
      typeof input.sessionId === "string" ? input.sessionId : undefined,
    dimension: asDimension(input.dimension),
    title: typeof input.title === "string" ? input.title : "",
    content: typeof input.content === "string" ? input.content : "",
    tags: asStringArray(input.tags),
    confidence:
      typeof input.confidence === "number" ? input.confidence : undefined,
  });
  return { status: "stored", projectId: project.id, entry };
}

function executeQuery(
  brain: BrainStore,
  workspaceRoot: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const project = resolveProject(brain, workspaceRoot, input);
  const dimensions =
    input.dimensions === undefined
      ? undefined
      : (asStringArray(input.dimensions) ?? []).map(asDimension);
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit) && input.limit > 0
      ? Math.floor(input.limit)
      : 20;
  const entries = brain.queryMemory({
    projectId: project.id,
    dimensions,
    query: typeof input.query === "string" ? input.query : undefined,
    limit: typeof input.limit === "number" ? input.limit : undefined,
  });

  // The Brain holds two distinct things: durable facts in `memory_entries` and
  // condensed exchanges in `interaction_summaries`. Recall must return both.
  // Reading only the former is why a captured conversation looked like a
  // vanished one: the drain recorded it, and `brain_query` reported zero. That
  // split is the "write and read disagree" defect of the 2026-09-10 audit.
  const summaries =
    input.includeSummaries === false ? [] : collectRecentSummaries(brain, project.id, limit);

  return {
    status: "queried",
    projectId: project.id,
    count: entries.length,
    entries,
    summaryCount: summaries.length,
    summaries,
  };
}

interface RecallSummary {
  sessionId: string;
  roundNumber: number;
  context: string | null;
  actions: string | null;
  outcome: string | null;
  nodeRef: string | null;
  createdAt: number;
}

/** Most recent condensed exchanges across every session of a project. */
function collectRecentSummaries(
  brain: BrainStore,
  projectId: string,
  limit: number,
): RecallSummary[] {
  const collected: RecallSummary[] = [];
  try {
    for (const session of brain.listSessions(projectId)) {
      for (const interaction of brain.listInteractions(session.id)) {
        collected.push({
          sessionId: interaction.sessionId,
          roundNumber: interaction.roundNumber,
          context: interaction.context ?? null,
          actions: interaction.actions ?? null,
          outcome: interaction.outcome ?? null,
          nodeRef: interaction.nodeRef ?? null,
          createdAt: interaction.createdAt,
        });
      }
    }
  } catch {
    // Recall is best effort; a projection failure must not fail the read.
    return [];
  }
  collected.sort((left, right) => right.createdAt - left.createdAt);
  return collected.slice(0, limit);
}

function executeSummarize(
  brain: BrainStore,
  workspaceRoot: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const project = resolveProject(brain, workspaceRoot, input);

  let sessionId: string;
  if (typeof input.sessionId === "string" && input.sessionId.trim().length > 0) {
    const session = brain.getSession(input.sessionId.trim());
    if (!session) {
      throw new BrainStoreError(
        "NOT_FOUND",
        `Unknown session '${input.sessionId}'`,
      );
    }
    sessionId = session.id;
  } else {
    const session = brain.startSession({
      projectId: project.id,
      objective:
        typeof input.objective === "string" ? input.objective : undefined,
    });
    sessionId = session.id;
  }

  const roundNumber =
    typeof input.roundNumber === "number" && Number.isInteger(input.roundNumber)
      ? input.roundNumber
      : brain.listInteractions(sessionId).length;

  const interaction = brain.recordInteraction({
    sessionId,
    roundNumber,
    context: typeof input.context === "string" ? input.context : undefined,
    actions: typeof input.actions === "string" ? input.actions : undefined,
    userIntent: typeof input.userIntent === "string" ? input.userIntent : undefined,
    actionsTaken:
      typeof input.actionsTaken === "string" ? input.actionsTaken : undefined,
    outcome: typeof input.outcome === "string" ? input.outcome : undefined,
    nodeRef: typeof input.nodeRef === "string" ? input.nodeRef : undefined,
  });

  let memoryId: string | undefined;
  if (typeof input.content === "string" && input.content.trim().length > 0) {
    const entry = brain.storeMemory({
      projectId: project.id,
      sessionId,
      dimension: "run_summary",
      title:
        typeof input.title === "string" && input.title.trim().length > 0
          ? input.title
          : `Round ${roundNumber} summary`,
      content: input.content,
    });
    memoryId = entry.id;
  }

  return {
    status: "summarized",
    projectId: project.id,
    sessionId,
    interaction,
    ...(memoryId ? { memoryId } : {}),
  };
}

function executeCompact(
  brain: BrainStore,
  workspaceRoot: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const project = resolveProject(brain, workspaceRoot, input);
  const result = brain.compact({
    projectId: project.id,
    maxRunSummaries:
      typeof input.maxRunSummaries === "number" ? input.maxRunSummaries : undefined,
    runSummaryMinConfidence:
      typeof input.runSummaryMinConfidence === "number"
        ? input.runSummaryMinConfidence
        : undefined,
    runSummaryMaxAgeMs:
      typeof input.runSummaryMaxAgeMs === "number"
        ? input.runSummaryMaxAgeMs
        : undefined,
    maxInteractionsPerSession:
      typeof input.maxInteractionsPerSession === "number"
        ? input.maxInteractionsPerSession
        : undefined,
    interactionRetentionMs:
      typeof input.interactionRetentionMs === "number"
        ? input.interactionRetentionMs
        : undefined,
    condenseInteractions:
      typeof input.condenseInteractions === "boolean"
        ? input.condenseInteractions
        : undefined,
    deduplicationMode:
      input.deduplicationMode === "exact" || input.deduplicationMode === "redundant"
        ? input.deduplicationMode
        : undefined,
    vacuum:
      typeof input.vacuum === "boolean" ? input.vacuum : undefined,
  });
  return {
    ...result,
    projectId: project.id,
  };
}


/**
 * Dispatch a brain tool call. Throws {@link BrainStoreError} on invalid input;
 * the broker maps thrown errors to a rejected JSON-RPC result.
 */
export function executeBrainTool(
  brain: BrainStore,
  workspaceRoot: string,
  toolName: string,
  input: unknown,
): Record<string, unknown> {
  const args: Record<string, unknown> = isRecord(input) ? input : {};
  switch (toolName) {
    case "brain_store":
      return executeStore(brain, workspaceRoot, args);
    case "brain_query":
      return executeQuery(brain, workspaceRoot, args);
    case "brain_summarize":
      return executeSummarize(brain, workspaceRoot, args);
    case "brain_compact":
      return executeCompact(brain, workspaceRoot, args);
    case "project_model":
      return executeProjectModel(brain, workspaceRoot, args);
    default:
      throw new Error(`Unknown brain tool: ${toolName}`);
  }
}

/**
 * The durable shape of the project: which areas exploration has actually looked at, how often,
 * and the most recent thing learned about each.
 *
 * Scoped to the workspace's own project, like every other Brain read.
 */
function executeProjectModel(
  brain: BrainStore,
  workspaceRoot: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const project = resolveProject(brain, workspaceRoot, args);
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  const components = brain.listComponents({ projectId: project.id, ...(limit !== undefined ? { limit } : {}) });
  return {
    status: "reported",
    projectId: project.id,
    projectName: project.name,
    components: components.map((component) => ({
      path: component.path,
      kind: component.kind,
      summary: component.summary,
      mentions: component.mentions,
      source: component.source,
      lastSeenAt: component.lastSeenAt,
    })),
    count: components.length,
  };
}

