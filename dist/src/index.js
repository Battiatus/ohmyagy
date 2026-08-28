import { runGraphCli } from "./graph/cli.js";
import { installWorkspacePlugin } from "./packaging/install.js";
export async function init(args = process.argv.slice(2)) {
    if (args[0] === "graph") {
        return runGraphCli(args.slice(1));
    }
    if (args[0] === "plugin" && args[1] === "install-workspace") {
        const result = installWorkspacePlugin(process.cwd());
        console.log(JSON.stringify(result, null, 2));
        return 0;
    }
    if (args[0] === "mcp" && args[1] === "serve") {
        await import("./mcp/broker-server.js");
        return 0;
    }
    console.log(`Oh My Antigravity

Usage:
  oma graph status
  oma graph ready
  oma graph dispatch <node-id> <dispatch-id> <scheduler-id>
  oma graph complete <node-id> <dispatch-id> <success|failure> <authority> <authority-id> <evidence-hash>
  oma plugin install-workspace
  oma mcp serve`);
    return 0;
}
