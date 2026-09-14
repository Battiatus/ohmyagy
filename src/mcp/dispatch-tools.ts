import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { BrainStore } from "../brain/brain-store.js";
import { copyWorkspaceTree } from "../broker/nongit-staging.js";
import { snapshotWorkspace } from "../broker/workspace-snapshot.js";
import { loadGraphRuntime } from "../graph/store.js";
import { projectGraph } from "../graph/kernel.js";
import { MissionEventsStore } from "../ledger/mission-events.js";
import { isRecord } from "../ledger/canonical.js";
import { findActiveMissionId, ensureMissionStarted } from "../mission/read-model.js";
import { assertInterviewAuthorisesExecution } from "../mission/interview-gate.js";
import { AgyDriver, type IAgyDriver } from "../runtime/agy-driver.js";
import { CapabilityResolver } from "../runtime/capability-resolver.js";

/**
 * Dispatch a graph node to the expert it is assigned to, as a real process.
 *
 * Until now nothing in the IDE path dispatched anything: the conductor did the work
 * itself and wrote whatever `expertId` it liked onto the node's `run_started` event, so
 * the six roles were configurations rather than agents. This tool resolves the node's
 * `executor.persona` through `CapabilityResolver`, runs that expert with its own model
 * class, effort and sandbox, and records the run under the expert that really ran.
 *
 * Scope, deliberately: **read-only experts only.** A dispatch runs in the workspace with
 * the expert's own tools, and OMA's mutation path is the reviewed two-phase commit
 * (`propose_change` → `attest_review` → `promote_change`). Handing a writer persona a
 * shell in the live tree would route around every gate the project has, so it is refused
 * with a message pointing at the path that is allowed to write.
 */

export interface DispatchNodeOptions {
  workspaceRoot: string;
  input: unknown;
  /** Injectable so a test can prove dispatch without spending a model call. */
  driver?: IAgyDriver;
  timeoutMs?: number;
  /**
   * The workspace's Brain, so exploration feeds the durable project model. Optional: a dispatch
   * without one still runs, it simply does not teach the project anything.
   */
  brain?: BrainStore;
}

export const DISPATCH_TOOL_NAMES = new Set(["dispatch_node"]);

/** Measured 31-85 s for a one-line answer, because agy loads a large global context. */
const DEFAULT_DISPATCH_TIMEOUT_MS = 180_000;

export const DISPATCH_TOOL_DEFINITIONS = [
  {
    name: "dispatch_node",
    description:
      "Dispatch a ready graph node to the expert it is assigned to, as a real AntiGravity run with that expert's model class, effort and sandbox. A read-only expert runs in the workspace; a writer runs in an isolated copy and returns a changeSet of operations for propose_change, so dispatching never edits the live tree.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "Graph node to dispatch." },
        missionId: {
          type: "string",
          description: "Mission identifier. Defaults to the mission owning the workspace graph.",
        },
        instruction: {
          type: "string",
          description: "Optional extra instruction appended to the node's scope and acceptance criteria.",
        },
        timeoutMs: {
          type: "number",
          description: `Run budget in milliseconds (default ${DEFAULT_DISPATCH_TIMEOUT_MS}).`,
        },
      },
      required: ["nodeId"],
    },
  },
];

function resolveMissionId(workspaceRoot: string, input: Record<string, unknown>): string {
  if (typeof input.missionId === "string" && input.missionId.trim().length > 0) {
    return input.missionId.trim();
  }
  const pointerPath = join(workspaceRoot, ".oma", "graph", "session-mission-id");
  try {
    if (existsSync(pointerPath)) {
      const pointer = readFileSync(pointerPath, "utf8").trim();
      if (pointer.length > 0) return pointer;
    }
  } catch {
    // Fall through to discovery.
  }
  return findActiveMissionId(workspaceRoot) ?? "oma-session";
}

function buildInstruction(
  node: { title: string; scope?: string[] },
  missionId: string,
  role: string,
  extra: string | undefined,
): string {
  const lines = [
    `You are the '${role}' expert of OMA mission '${missionId}'.`,
    `Task: ${node.title}`,
  ];
  if (node.scope !== undefined && node.scope.length > 0) {
    lines.push(`Scope (do not go outside it): ${node.scope.join(", ")}`);
  }
  if (extra !== undefined && extra.trim().length > 0) {
    lines.push(extra.trim());
  }
  lines.push(
    "Work only from files you actually read. Do not modify anything: this dispatch is read-only.",
    'End your answer with a single JSON object of the shape {"summary":"...","evidence":["..."],"confidence":"low|medium|high"} and nothing after it.',
  );
  return lines.join("\n");
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * The expert's answer, not the transport envelope.
 *
 * agy replies with `{"conversation_id":…,"status":"SUCCESS","response":"<the model's text>"}`.
 * Taking the first balanced JSON object out of the raw stdout therefore returned the
 * envelope — measured on a real dispatch. The model's own JSON is inside `response`.
 */
function resolveAnswer(result: { parsedOutput?: unknown; rawStdout: string }): unknown {
  const parsed = result.parsedOutput;
  if (isRecord(parsed)) {
    const response = parsed.response;
    if (typeof response === "string" && ("conversation_id" in parsed || "status" in parsed)) {
      return extractJson(response) ?? response;
    }
    return parsed;
  }
  if (typeof parsed === "string") return extractJson(parsed) ?? parsed;

  const envelope = extractJson(result.rawStdout);
  if (isRecord(envelope) && typeof envelope.response === "string") {
    return extractJson(envelope.response) ?? envelope.response;
  }
  return envelope ?? null;
}

export async function executeDispatchNode(
  options: DispatchNodeOptions,
): Promise<Record<string, unknown>> {
  const input = isRecord(options.input) ? options.input : {};
  const nodeId = typeof input.nodeId === "string" ? input.nodeId.trim() : "";
  if (nodeId.length === 0) throw new Error("dispatch_node requires a non-empty nodeId.");

  const runtime = loadGraphRuntime(options.workspaceRoot);
  const node = runtime.graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    throw new Error(
      `Unknown node '${nodeId}'. Known nodes: ${runtime.graph.nodes.map((n) => n.id).join(", ")}.`,
    );
  }
  if (node.synthetic === true) {
    throw new Error(
      `Node '${nodeId}' is the engine's own seed, not work the mission asked for; there is nothing to dispatch.`,
    );
  }

  const persona = node.executor?.persona ?? node.completionAuthority;
  const capability = CapabilityResolver.resolve(persona);

  const missionId = resolveMissionId(options.workspaceRoot, input);
  // The interview gate applies to dispatch exactly as it does to converge_step: no expert
  // is woken before the user has answered and confirmed.
  assertInterviewAuthorisesExecution({ workspaceRoot: options.workspaceRoot, missionId });

  // A writer works in an isolated copy, never in the live tree. Its output is a change set for
  // the reviewed path (`propose_change` → review → gates → promote), so dispatching a writer
  // cannot bypass the two-phase commit. It used to be refused outright because there was nowhere
  // isolated for it to work; the staging container is that place.
  const container = capability.readOnly
    ? undefined
    : mkdtempSync(join(tmpdir(), "oma-dispatch-writer-"));
  const baseSnapshot = container === undefined ? undefined : snapshotWorkspace(options.workspaceRoot);
  if (container !== undefined && baseSnapshot !== undefined) {
    copyWorkspaceTree(options.workspaceRoot, container);
  }

  const eventsPath = ensureMissionStarted(options.workspaceRoot, missionId);
  const dispatchId = `dispatch-${nodeId}-${Date.now()}`;
  MissionEventsStore.appendEvent(eventsPath, missionId, {
    type: "run_started",
    runId: dispatchId,
    workItemId: nodeId,
    expertId: capability.expertId,
    model: capability.modelSlug,
    effort: capability.effort,
  });

  const driver = options.driver ?? new AgyDriver();
  const started = Date.now();
  let result;
  try {
    result = await driver.invoke({
      contractPrompt: buildInstruction(
        node,
        missionId,
        capability.expertId,
        typeof input.instruction === "string" ? input.instruction : undefined,
      ),
      persona: capability.expertId,
      worktreeDir: container ?? options.workspaceRoot,
      timeoutMs:
        typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
          ? input.timeoutMs
          : options.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS,
      modelOverride: capability.modelSlug,
      reasoningEffort: capability.effort,
      sandboxMode: capability.sandbox,
      useSandbox: false,
      bare: true,
      runId: dispatchId,
    });
  } catch (error) {
    if (container !== undefined) safeRemove(container);
    throw error;
  }
  const durationMs = Date.now() - started;

  const succeeded = result.status === "success";
  MissionEventsStore.appendEvent(eventsPath, missionId, {
    type: "run_finished",
    runId: dispatchId,
    workItemId: nodeId,
    expertId: capability.expertId,
    status: succeeded ? "succeeded" : "failed",
    durationMs,
    ...(succeeded ? {} : { error: result.error ?? `driver status ${result.status}` }),
  });

  const raw = typeof result.rawStdout === "string" ? result.rawStdout : "";
  const answer = resolveAnswer(result);
  const modelProblems = recordExploredComponents(options, answer, capability.expertId);

  // A writer produced files in the container; turn them into the operations `propose_change`
  // expects, then discard the container. The live workspace was never touched.
  let changeSet: Record<string, unknown> | undefined;
  if (container !== undefined && baseSnapshot !== undefined) {
    try {
      changeSet = collectChangeSet(baseSnapshot.state.files, container);
    } finally {
      safeRemove(container);
    }
  }

  return {
    status: "dispatched",
    nodeId,
    missionId,
    runId: dispatchId,
    expert: {
      expertId: capability.expertId,
      model: capability.modelSlug,
      effort: capability.effort,
      sandbox: capability.sandbox,
      readOnly: capability.readOnly,
    },
    driverStatus: result.status,
    durationMs,
    succeeded,
    ...(succeeded ? {} : { error: result.error ?? result.status }),
    output: resolveAnswer(result),
    receipt: result.receipt,
    ...(changeSet !== undefined ? { changeSet } : {}),
    ...(modelProblems.length > 0 ? { projectModelProblems: modelProblems } : {}),
  };
}

/**
 * Feed what the expert actually looked at into the durable project model.
 *
 * An exploratory answer names the paths it examined. Recording them is what turns "a mission
 * read some files" into "the project has these areas, and here is what exploration knows about
 * each" — knowledge that survives the mission and the process.
 *
 * A failure here is reported in the result rather than swallowed: bookkeeping that fails quietly
 * is how a project model silently stays empty.
 */
function recordExploredComponents(
  options: DispatchNodeOptions,
  answer: unknown,
  expertId: string,
): string[] {
  if (options.brain === undefined || !isRecord(answer)) return [];
  const evidence = answer.evidence;
  if (!Array.isArray(evidence)) return [];

  const summary = typeof answer.summary === "string" ? answer.summary : null;
  const problems: string[] = [];
  let project;
  try {
    project = options.brain.ensureProject({
      name: basename(options.workspaceRoot),
      rootPath: options.workspaceRoot,
    });
  } catch (error) {
    return [messageOf(error)];
  }

  for (const entry of evidence) {
    if (typeof entry !== "string" || entry.trim().length === 0) continue;
    try {
      options.brain.recordComponent({
        projectId: project.id,
        path: entry.trim(),
        kind: "file",
        source: `dispatch:${expertId}`,
        summary,
      });
    } catch (error) {
      problems.push(`${entry}: ${messageOf(error)}`);
    }
  }
  return problems;
}

/**
 * The difference between the pre-dispatch snapshot and what the expert wrote in the container.
 *
 * A binary change is reported rather than smuggled: the proposal schema carries file contents as
 * text, so a binary edit could not be reviewed as text and must be handled deliberately.
 */
function collectChangeSet(
  baseFiles: Readonly<Record<string, string>>,
  containerPath: string,
): Record<string, unknown> {
  const after = snapshotWorkspace(containerPath);
  const operations: Array<Record<string, unknown>> = [];
  const binaryPaths: string[] = [];

  for (const path of [...new Set([...Object.keys(baseFiles), ...Object.keys(after.state.files)])].sort()) {
    const before = baseFiles[path];
    const now = after.state.files[path];
    if (before === now) continue;
    if (now === undefined) {
      operations.push({ kind: "delete", path, baseHash: before });
      continue;
    }
    let buffer: Buffer;
    try {
      buffer = readFileSync(join(containerPath, ...path.split("/")));
    } catch {
      continue;
    }
    if (buffer.includes(0)) {
      binaryPaths.push(path);
      continue;
    }
    operations.push({
      kind: "write",
      path,
      baseHash: before ?? null,
      content: buffer.toString("utf8"),
    });
  }

  return {
    schemaVersion: 1,
    // `parentVersion` is deliberately absent: `propose_change` accepts `"current"`, and the
    // proposal must be validated against the workspace as it is when it is actually made.
    operations,
    changedPaths: operations.map((operation) => operation.path),
    ...(binaryPaths.length > 0 ? { binaryPaths } : {}),
    ...(after.problems.length > 0 ? { problems: after.problems } : {}),
  };
}

/** Best-effort container removal; a lock must not fail an otherwise-successful dispatch. */
function safeRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // The OS reaps the temp directory.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
