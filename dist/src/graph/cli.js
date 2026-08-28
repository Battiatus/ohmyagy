import { projectGraph } from "./kernel.js";
import { appendGraphTransition, initializeGraphStore, loadGraphRuntime, verifyGraphStore, } from "./store.js";
export function runGraphCli(args, root = process.cwd()) {
    try {
        const command = args[0] ?? "status";
        if (command === "init") {
            const runtime = initializeGraphStore(root);
            console.log(JSON.stringify({ graphId: runtime.graph.graphId, graphHash: runtime.graphHash }, null, 2));
            return 0;
        }
        const runtime = loadGraphRuntime(root);
        const verification = verifyGraphStore(runtime);
        if (!verification.valid) {
            console.error(JSON.stringify({ valid: false, errors: verification.errors }, null, 2));
            return 1;
        }
        if (command === "status" || command === "ready") {
            const projection = projectGraph(runtime.graph, verification.events);
            console.log(JSON.stringify(command === "ready"
                ? { graphId: projection.graphId, revision: projection.revision, readySet: projection.readySet }
                : {
                    valid: true,
                    graphHash: runtime.graphHash,
                    eventHead: verification.headHash,
                    ...projection,
                }, null, 2));
            return 0;
        }
        if (command === "dispatch") {
            const [nodeId, dispatchId, authorityId] = args.slice(1);
            if (!nodeId || !dispatchId || !authorityId) {
                throw new Error("Usage: oma graph dispatch <node-id> <dispatch-id> <scheduler-id>");
            }
            const event = appendGraphTransition(runtime, {
                eventType: "node_dispatched",
                nodeId,
                dispatchId,
                authorityId,
            });
            console.log(JSON.stringify(event, null, 2));
            return 0;
        }
        if (command === "complete") {
            const [nodeId, dispatchId, outcomeRaw, authorityRaw, authorityId, evidenceHash] = args.slice(1);
            if (!nodeId ||
                !dispatchId ||
                !isOutcome(outcomeRaw) ||
                !isAuthority(authorityRaw) ||
                !authorityId ||
                !evidenceHash) {
                throw new Error("Usage: oma graph complete <node-id> <dispatch-id> <success|failure> <broker|oracle|scheduler|human> <authority-id> <evidence-hash>");
            }
            const event = appendGraphTransition(runtime, {
                eventType: "node_completed",
                nodeId,
                dispatchId,
                outcome: outcomeRaw,
                authority: authorityRaw,
                authorityId,
                evidenceHash,
            });
            console.log(JSON.stringify(event, null, 2));
            return 0;
        }
        printHelp();
        return 1;
    }
    catch (error) {
        console.error(`OMA graph error: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
}
function isOutcome(value) {
    return value === "success" || value === "failure";
}
function isAuthority(value) {
    return value === "broker" || value === "oracle" || value === "scheduler" || value === "human";
}
function printHelp() {
    console.log(`OMA graph commands:
  oma graph init
  oma graph status
  oma graph ready
  oma graph dispatch <node-id> <dispatch-id> <scheduler-id>
  oma graph complete <node-id> <dispatch-id> <success|failure> <authority> <authority-id> <evidence-hash>`);
}
