import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BrainStore } from "./brain-store.js";
import { captureInteraction, extractInteractionText } from "./summarizer.js";
import { createFlashReformulator } from "./flash-summarizer.js";

/**
 * OMA memory summarizer hook (Stop / PostToolUse).
 *
 * Wired into `hooks.json`, this runs after an exchange, reformulates it through
 * the Gemini Flash mini-agent and persists the result into the project-scoped
 * Neural Brain. It is deliberately **fail-open**: whatever happens, it emits a
 * passthrough decision and exits 0 so it can never block or corrupt the user's
 * session. Memory capture is best-effort; the session is sacred.
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Map the host session id to a durable Brain session id, persisting the mapping
 * under `.oma/brain-session.json`. A brand-new host session starts a fresh Brain
 * session but stays scoped to the same project, so project memory still carries
 * across sessions.
 */
function resolveSessionId(
  brain: BrainStore,
  workspaceRoot: string,
  projectId: string,
  hostSessionId: string,
): string {
  const linkPath = join(workspaceRoot, ".oma", "brain-session.json");
  let link: Record<string, string> = {};
  if (existsSync(linkPath)) {
    try {
      const parsed = JSON.parse(readFileSync(linkPath, "utf8"));
      if (parsed && typeof parsed === "object") {
        link = parsed as Record<string, string>;
      }
    } catch {
      link = {};
    }
  }

  const key = hostSessionId || "default";
  const existing = link[key];
  if (existing && brain.getSession(existing)) {
    return existing;
  }

  const session = brain.startSession({ projectId });
  link[key] = session.id;
  try {
    mkdirSync(join(workspaceRoot, ".oma"), { recursive: true });
    writeFileSync(linkPath, `${JSON.stringify(link, null, 2)}\n`, "utf8");
  } catch {
    // A missing mapping only costs a new session next time; never fatal.
  }
  return session.id;
}

function passthrough(): void {
  // Emit an empty object, NOT a Claude-style `{"continue":true}`.
  //
  // AGY unmarshals a hook's stdout with protojson against the result message of
  // the event that fired, and an unknown field is a hard failure. Measured on
  // AGY 1.2.1: a PostToolUse hook printing `{"decision":"allow",...}` surfaced to
  // the agent as `Encountered error in tool execution: failed to unmarshal result
  // from hook ... unknown field "decision"`. `{}` decodes into any message, so a
  // best-effort memory hook can never damage the session it is observing.
  process.stdout.write("{}\n");
}

async function main(): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    passthrough();
    return;
  }

  let brain: BrainStore | undefined;
  try {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const workspaceRoot =
      (typeof p.cwd === "string" && p.cwd) ||
      process.env.OMA_WORKSPACE_ROOT ||
      process.cwd();
    // AGY names the host session `conversationId`; `session_id`/`sessionId` are
    // the Claude and Gemini spellings. Reading only the latter meant the lookup
    // never matched and every host session collapsed onto the single "default"
    // Brain session, defeating the per-session scoping the vision asks for.
    const hostSessionId =
      (typeof p.conversationId === "string" && p.conversationId) ||
      (typeof p.session_id === "string" && p.session_id) ||
      (typeof p.sessionId === "string" && p.sessionId) ||
      "";

    const text = extractInteractionText(payload);
    if (text.trim().length === 0) {
      passthrough();
      return;
    }

    const brainPath =
      process.env.OMA_BRAIN_PATH ?? join(workspaceRoot, ".oma", "brain.sqlite");
    brain = new BrainStore(brainPath);
    const project = brain.ensureProject({
      name: basename(workspaceRoot) || "workspace",
      rootPath: workspaceRoot,
    });
    const sessionId = resolveSessionId(brain, workspaceRoot, project.id, hostSessionId);

    await captureInteraction({
      brain,
      projectId: project.id,
      sessionId,
      projectName: project.name,
      text,
      reformulate: createFlashReformulator({ worktreeDir: workspaceRoot }),
    });
  } catch {
    // Fail open — never surface an error to the session.
  } finally {
    if (brain) {
      try {
        brain.close();
      } catch {
        // ignore
      }
    }
  }
  passthrough();
}

void main();
