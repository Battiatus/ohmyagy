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
]);

/** Result statuses the broker must treat as success (not JSON-RPC errors). */
export const BRAIN_SUCCESS_STATUSES = new Set([
  "stored",
  "queried",
  "summarized",
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
      "Retrieve memory entries for a project, optionally narrowed by dimension and a free-text keyword. Strictly scoped to one project. Read-only.",
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
  const entries = brain.queryMemory({
    projectId: project.id,
    dimensions,
    query: typeof input.query === "string" ? input.query : undefined,
    limit: typeof input.limit === "number" ? input.limit : undefined,
  });
  return {
    status: "queried",
    projectId: project.id,
    count: entries.length,
    entries,
  };
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
    default:
      throw new Error(`Unknown brain tool: ${toolName}`);
  }
}
