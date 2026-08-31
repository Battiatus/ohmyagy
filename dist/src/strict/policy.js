import { isAbsolute, relative, resolve } from "node:path";
import { isRecord } from "../ledger/canonical.js";
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
const fileMutationTools = new Map([
    ["write_to_file", "TargetFile"],
    ["replace_file_content", "TargetFile"],
    ["multi_replace_file_content", "TargetFile"],
]);
const protectedPrefixes = [
    ".agents/plugins/oma",
    ".oma/graph",
    ".oma/ledger",
    ".oma/control",
    ".git",
];
export function evaluateStrictToolUse(input) {
    if (!isRecord(input) || !isRecord(input.toolCall)) {
        return deny("Malformed PreToolUse payload; strict mode fails closed.");
    }
    const name = input.toolCall.name;
    const args = input.toolCall.args;
    if (typeof name !== "string" || name.length === 0) {
        return deny("Missing tool name; strict mode fails closed.");
    }
    // 1. File Mutation Tools
    const targetFileArg = fileMutationTools.get(name);
    if (targetFileArg && isRecord(args)) {
        const targetPath = args[targetFileArg];
        if (typeof targetPath !== "string") {
            return deny(`Mutation tool ${name} is missing a valid target path.`);
        }
        return evaluateFileMutation(name, targetPath, input.workspacePaths);
    }
    // 2. Command Execution Tool
    if (name === "run_command" && isRecord(args)) {
        const cwd = typeof args.Cwd === "string" ? args.Cwd : undefined;
        return evaluateCommandExecution(cwd, input.workspacePaths);
    }
    // 3. MCP Calls
    if (name === "propose_change" ||
        name.startsWith("mcp__oma-broker") ||
        name.startsWith("mcp__oma_broker") ||
        name.startsWith("mcp_oma-broker") ||
        name.startsWith("mcp_oma_broker")) {
        return allow(`OMA broker tool ${name} is authorized.`);
    }
    if (name === "call_mcp_tool") {
        return evaluateGenericMcpCall(args);
    }
    // 4. Read Tools
    const pathArgument = workspaceReadTools.get(name);
    if (pathArgument) {
        return evaluateWorkspaceRead(name, pathArgument, args, input.workspacePaths);
    }
    if (allowedReadTools.has(name)) {
        return allow(`Read-only or coordination tool ${name} is allowed.`);
    }
    return deny(`Unknown or unhandled tool ${name} is denied by strict policy.`);
}
function evaluateFileMutation(name, targetPath, workspacePaths) {
    const normalized = targetPath.replaceAll("\\", "/");
    // Deny protected paths
    for (const prefix of protectedPrefixes) {
        if (normalized.includes(prefix)) {
            return deny(`Direct mutation of protected path '${prefix}' is forbidden in strict mode.`);
        }
    }
    // Allow mutations inside an authorized OMA worktree
    const isOmaWorktree = normalized.includes("/.oma/worktrees/") ||
        normalized.includes("\\.oma\\worktrees\\") ||
        Boolean(process.env.OMA_AUTHORIZED_WORKTREE && normalized.startsWith(process.env.OMA_AUTHORIZED_WORKTREE.replaceAll("\\", "/")));
    if (isOmaWorktree) {
        return allow(`Mutation tool ${name} is permitted inside authorized OMA worktree.`);
    }
    // If outside authorized worktree, deny direct mutation of main workspace
    return deny(`Direct mutation tool ${name} outside an authorized OMA worktree is disabled in strict mode.`);
}
function evaluateCommandExecution(cwd, workspacePaths) {
    if (!cwd) {
        return deny("Command execution without explicit Cwd is denied in strict mode.");
    }
    const normalizedCwd = cwd.replaceAll("\\", "/");
    const isOmaWorktree = normalizedCwd.includes("/.oma/worktrees/") ||
        normalizedCwd.includes("\\.oma\\worktrees\\") ||
        Boolean(process.env.OMA_AUTHORIZED_WORKTREE && normalizedCwd.startsWith(process.env.OMA_AUTHORIZED_WORKTREE.replaceAll("\\", "/")));
    if (isOmaWorktree) {
        return allow("Command execution within authorized OMA worktree is allowed.");
    }
    return deny("Command execution outside an authorized OMA worktree is disabled in strict mode.");
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
    if (serverName === "oma-broker" ||
        serverName === "oma_broker" ||
        toolName.startsWith("oma-broker/") ||
        toolName.startsWith("oma_broker/")) {
        return allow(`OMA broker tool ${toolName} is authorized.`);
    }
    return deny(`MCP tool ${toolName} on server ${serverName} is not authorized in strict mode.`);
}
function allow(reason) {
    return { decision: "allow", reason };
}
function deny(reason) {
    return { decision: "deny", reason };
}
