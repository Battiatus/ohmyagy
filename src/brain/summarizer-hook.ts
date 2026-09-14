import { appendStagedRecord, parseAgyHookPayload, toStagedRecord } from "./agy-capture.js";
import { bindConversation } from "./workspace-registry.js";

/**
 * OMA memory capture hook, wired to `PostToolUse`.
 *
 * Why this shape — measured on AGY 1.2.1, see
 * `docs/audits/2026-09-11-oma-host-contract/REPORT.md`:
 *
 *  * `Stop` is rejected outright and `SessionEnd` never fired, so the historical
 *    event choice could not work; `PostToolUse` is accepted and does fire.
 *  * A hook result is decoded with protojson against the firing event's own
 *    result message, and an unknown field is a hard failure that AGY reports to
 *    the agent as a tool-execution error. `{}` decodes into any message.
 *  * A hook's `cwd` is its **plugin** directory and `workspacePaths` is empty, so
 *    the hook cannot know its project. It therefore does not try: it appends a
 *    cheap, project-agnostic record keyed by `conversationId`, and the
 *    workspace-aware side folds it into the project Brain later
 *    (`staging-drain.ts`).
 *
 * Deliberately it opens no database and runs no model: capture must never be
 * able to slow down, block or corrupt the session it observes.
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function emitNeutral(): void {
  process.stdout.write("{}\n");
}

async function main(): Promise<void> {
  try {
    const payload = parseAgyHookPayload(await readStdin());
    if (payload) {
      const record = toStagedRecord(payload);
      if (record) {
        appendStagedRecord(record);
        // When the host states a workspace, bind the conversation to it exactly. A
        // stated workspace is evidence, not an inference, and it is the only project
        // signal this hook can be given. A conflict is reported, never overwritten.
        const declared = [...new Set(record.workspacePaths)];
        if (declared.length === 1) {
          try {
            bindConversation({
              conversationId: record.conversationId,
              workspaceRoot: declared[0],
              source: "host-workspacePaths",
            });
          } catch {
            // An existing, different binding wins over a later statement.
          }
        }
      }
    }
  } catch {
    // Fail open: capture is best effort, the session is sacred.
  }
  emitNeutral();
}

void main();
