// Capture probe: records what AGY actually passes to a JSON command hook.
//
// Two things are unknown and both are load-bearing:
//   * the working directory AGY spawns the hook in — `strict/hook.ts` decides
//     mission liveness from `process.cwd()`, so if this is not the workspace the
//     strict gate can never arm;
//   * the payload shape on stdin — `brain/summarizer-hook.ts` extracts the
//     exchange from it, so an unexpected shape means silent empty capture.
//
// Writes one JSON line per invocation. Fail-open and exit 0 so the probe never
// breaks the session it is measuring.
const fs = require("node:fs");

let raw = "";
try {
  raw = fs.readFileSync(0, "utf8");
} catch {}

const event = process.argv[2] ?? "?";
const target = process.argv[3] ?? "dump.jsonl";

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  payload = { __unparsed: raw.slice(0, 400) };
}

const record = {
  at: new Date().toISOString(),
  event,
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : null,
  payload,
};

try {
  fs.appendFileSync(target, `${JSON.stringify(record)}\n`);
} catch {}

process.stdout.write(`${JSON.stringify({ decision: "allow", reason: "probe passthrough" })}\n`);
process.exit(0);
