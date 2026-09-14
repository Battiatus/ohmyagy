import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
}

export const DISPATCH_TOOL_NAMES = new Set(["dispatch_node"]);

/** Measured 31-85 s for a one-line answer, because agy loads a large global context. */
const DEFAULT_DISPATCH_TIMEOUT_MS = 180_000;

export const DISPATCH_TOOL_DEFINITIONS = [
  {
    name: "dispatch_node",
    description:
      "Dispatch a ready graph node to the expert it is assigned to, as a real AntiGravity run with that expert's model class, effort and sandbox. Read-only experts only; mutations go through propose_change. Records run_started/run_finished under the expert that actually ran.",
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
  if (!capability.readOnly) {
    throw new Error(
      `Node '${nodeId}' is assigned to '${capability.expertId}', which may write. dispatch_node only runs read-only experts: a writer in the live tree would bypass the reviewed two-phase commit. Use propose_change for mutations.`,
    );
  }

  const missionId = resolveMissionId(options.workspaceRoot, input);
  // The interview gate applies to dispatch exactly as it does to converge_step: no expert
  // is woken before the user has answered and confirmed.
  assertInterviewAuthorisesExecution({ workspaceRoot: options.workspaceRoot, missionId });

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
  const result = await driver.invoke({
    contractPrompt: buildInstruction(
      node,
      missionId,
      capability.expertId,
      typeof input.instruction === "string" ? input.instruction : undefined,
    ),
    persona: capability.expertId,
    worktreeDir: options.workspaceRoot,
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
  };
}
