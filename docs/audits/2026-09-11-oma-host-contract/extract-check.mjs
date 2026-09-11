// Does the memory hook actually extract anything from a REAL AGY payload?
//
// `summarizer-hook.ts` calls `extractInteractionText(payload)` and bails to
// passthrough when the result is empty. The AGY payload captured on
// 2026-09-11 carries `toolCall`, `conversationId` and `transcriptPath` — not the
// Claude-style `messages` array the extractor was written for. This runs the
// shipped extractor against the captured payload to settle it.
import { readFileSync } from "node:fs";
import { extractInteractionText } from "../../dist/src/brain/summarizer.js";

const dumpPath = process.argv[2];
const lines = readFileSync(dumpPath, "utf8")
  .split(/\r?\n/u)
  .filter((line) => line.trim().length > 0);

for (const [index, line] of lines.entries()) {
  const record = JSON.parse(line);
  const payload = record.payload;
  let extracted = "";
  let error;
  try {
    extracted = extractInteractionText(payload);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  console.log(
    JSON.stringify({
      index,
      event: record.event,
      payloadKeys: record.payloadKeys,
      extractedLength: extracted.length,
      extractedPreview: extracted.slice(0, 200),
      error,
      hookWouldCapture: extracted.trim().length > 0,
      summarizerLooksForSessionId:
        typeof payload.session_id === "string" || typeof payload.sessionId === "string",
      agyActuallyProvidesConversationId: typeof payload.conversationId === "string",
    }),
  );
}
