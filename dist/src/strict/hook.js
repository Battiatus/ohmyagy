import { evaluateStrictToolUse } from "./policy.js";
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
}
try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    process.stdout.write(`${JSON.stringify(evaluateStrictToolUse(input))}\n`);
}
catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({
        decision: "deny",
        reason: `OMA strict hook failed closed: ${message}`,
    })}\n`);
}
