import { authorityHandoffFromEnvironment } from "./reconstruct.js";
try {
    const handoff = authorityHandoffFromEnvironment(process.cwd());
    process.stdout.write(`${JSON.stringify(handoff)}\n`);
    process.exitCode = handoff.ledgerValid ? 0 : 1;
}
catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
