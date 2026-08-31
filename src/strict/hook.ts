import { evaluateStrictToolUse } from "./policy.js";
import { isMissionLiveFor } from "./mission-liveness.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Liveness is intentionally decided from scheduler-written disk state before stdin
// is read. Outside a mission the hook fails open; inside one it fails closed. Agent
// payload data can therefore never grant or revoke the hook's authority.
if (!isMissionLiveFor([process.cwd()])) {
  process.stdout.write(
    `${JSON.stringify({
      decision: "allow",
      reason: "No live OMA mission governs this workspace; strict mode is inactive.",
    })}\n`,
  );
} else {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw) as unknown;
    process.stdout.write(`${JSON.stringify(evaluateStrictToolUse(input))}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify({
        decision: "deny",
        reason: `OMA strict hook failed closed: ${message}`,
      })}\n`,
    );
  }
}
