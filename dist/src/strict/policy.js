import { isAbsolute, relative, resolve } from "node:path";
import { isRecord } from "../control/model.js";
const workspaceReadTools = new Map([
    ["view_file", "AbsolutePath"],
    ["list_dir", "DirectoryPath"],
    ["find_by_name", "SearchDirectory"],
    ["grep_search", "SearchPath"],
]);
const allowedReadTools = new Set([
    "search_web",
    "read_url_content",
    "list_permissions",
    "invoke_subagent",
    "send_message",
    "manage_subagents",
    "ask_question",
]);
const directMutationTools = new Set([
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
    "run_command",
    "ask_permission",
    "generate_image",
]);
const allowedBrokerToolNames = new Set([
    "oma-broker/propose_change",
    "oma_broker/propose_change",
    "oma_broker__propose_change",
    "mcp__oma-broker__propose_change",
    "mcp__oma_broker__propose_change",
    "mcp_oma-broker_propose_change",
]);
export function evaluateStrictToolUse(input) {
    if (!isRecord(input) || !isRecord(input.toolCall)) {
        return deny("Malformed PreToolUse payload; strict mode fails closed.");
    }
    const name = input.toolCall.name;
    const args = input.toolCall.args;
    if (typeof name !== "string" || name.length === 0) {
        return deny("Missing tool name; strict mode fails closed.");
    }
    if (directMutationTools.has(name)) {
        return deny(`Direct mutation tool ${name} is disabled in OMA strict mode.`);
    }
    if (name === "call_mcp_tool") {
        return evaluateGenericMcpCall(args);
    }
    const pathArgument = workspaceReadTools.get(name);
    if (pathArgument) {
        return evaluateWorkspaceRead(name, pathArgument, args, input.workspacePaths);
    }
    if (name.startsWith("mcp_")) {
        return allowedBrokerToolNames.has(name)
            ? allow(`OMA broker tool ${name} is the authorized proposal channel.`)
            : deny(`MCP mutation channel ${name} is not authorized in strict mode.`);
    }
    if (allowedReadTools.has(name)) {
        return allow(`Read-only or coordination tool ${name} is allowed.`);
    }
    return deny(`Unknown tool ${name} is denied by the strict allowlist.`);
}
function evaluateWorkspaceRead(name, pathArgument, args, workspacePaths) {
    if (!isRecord(args) ||
        typeof args[pathArgument] !== "string" ||
        !isAbsolute(args[pathArgument]) ||
        !Array.isArray(workspacePaths) ||
        workspacePaths.some((path) => typeof path !== "string")) {
        return deny(`Filesystem read ${name} is missing an absolute workspace-scoped path.`);
    }
    const target = resolve(args[pathArgument]);
    const insideWorkspace = workspacePaths.some((workspace) => {
        const fromWorkspace = relative(resolve(workspace), target);
        return fromWorkspace.length === 0 || (!fromWorkspace.startsWith("..") && !isAbsolute(fromWorkspace));
    });
    return insideWorkspace
        ? allow(`Workspace-scoped read tool ${name} is allowed.`)
        : deny(`Filesystem read ${name} targets a path outside mounted workspaces.`);
}
function evaluateGenericMcpCall(args) {
    if (!isRecord(args)) {
        return deny("Generic MCP call is missing structured arguments.");
    }
    const toolName = args.ToolName ?? args.toolName ?? args.name;
    const serverName = args.ServerName ?? args.serverName;
    if (typeof toolName !== "string") {
        return deny("Generic MCP call does not identify its target tool.");
    }
    if (serverName === "oma-broker" && toolName === "propose_change") {
        return allow("OMA broker propose_change is the authorized proposal channel.");
    }
    return allowedBrokerToolNames.has(toolName)
        ? allow(`OMA broker tool ${toolName} is the authorized proposal channel.`)
        : deny(`MCP tool ${toolName} is not authorized in strict mode.`);
}
function allow(reason) {
    return { decision: "allow", reason };
}
function deny(reason) {
    return { decision: "deny", reason };
}
