import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function installWorkspacePlugin(workspaceRoot, options = {}) {
    const workspace = resolve(workspaceRoot);
    const pluginsRoot = join(workspace, ".agents", "plugins");
    const pluginDir = join(pluginsRoot, "oma");
    if (existsSync(pluginDir)) {
        throw new Error(`OMA plugin already exists: ${pluginDir}`);
    }
    const hookPath = fileURLToPath(new URL("../strict/hook.js", import.meta.url));
    const mcpServerPath = fileURLToPath(new URL("../mcp/broker-server.js", import.meta.url));
    if (!existsSync(hookPath) || !existsSync(mcpServerPath)) {
        throw new Error("Build artifacts are missing; run npm run build before installation");
    }
    const hookCommand = antigravityCommand([process.execPath, hookPath]);
    const stagingDir = join(pluginsRoot, `.oma-install-${process.pid}`);
    if (existsSync(stagingDir)) {
        throw new Error(`Installer staging directory already exists: ${stagingDir}`);
    }
    mkdirSync(join(stagingDir, "rules"), { recursive: true });
    const gates = options.gates ?? [defaultNpmTestGate()];
    const gatesPath = join(pluginDir, "gates.json");
    try {
        writeJson(join(stagingDir, "plugin.json"), {
            $schema: "https://antigravity.google/schemas/v1/plugin.json",
            name: "oma",
            description: "Strict brokered code transactions for Antigravity CLI.",
        });
        writeJson(join(stagingDir, "hooks.json"), {
            "oma-strict-write-gate": {
                enabled: true,
                PreToolUse: [
                    {
                        matcher: "*",
                        hooks: [
                            {
                                type: "command",
                                command: hookCommand,
                                timeout: 10,
                            },
                        ],
                    },
                ],
            },
        });
        writeJson(join(stagingDir, "gates.json"), { schemaVersion: 1, gates });
        writeJson(join(stagingDir, "mcp_config.json"), {
            mcpServers: {
                "oma-broker": {
                    command: process.execPath,
                    args: [mcpServerPath],
                    cwd: workspace,
                    env: {
                        OMA_WORKSPACE_ROOT: workspace,
                        OMA_GATES_PATH: gatesPath,
                    },
                },
            },
        });
        writeFileSync(join(stagingDir, "rules", "oma-strict.md"), [
            "# OMA Strict",
            "",
            "The agent is a read-only proposer. Never claim that a file was changed directly.",
            "All mutations must use the oma-broker propose_change MCP tool.",
            "The agent must never mutate .oma/graph; graph transitions belong to named authorities.",
            "Each graph node is a bounded invocation. Autonomous completion loops are forbidden.",
            "Only broker receipts and signed handoff evidence determine success.",
            "",
        ].join("\n"), "utf8");
        mkdirSync(dirname(pluginDir), { recursive: true });
        renameSync(stagingDir, pluginDir);
    }
    catch (error) {
        rmSync(stagingDir, { recursive: true, force: true });
        throw error;
    }
    return { pluginDir, hookPath, mcpServerPath, gatesPath };
}
function antigravityCommand(parts) {
    for (const part of parts) {
        if (/\s/u.test(part)) {
            throw new Error(`Antigravity CLI cannot safely parse quoted hook paths containing whitespace: ${part}`);
        }
    }
    return parts.map((part) => part.replaceAll("\\", "/")).join(" ");
}
function defaultNpmTestGate() {
    const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(npmCli)) {
        throw new Error(`Unable to resolve npm CLI entrypoint at ${npmCli}`);
    }
    return {
        id: "npm-test",
        program: process.execPath,
        args: [npmCli, "test"],
        timeoutMs: 300_000,
    };
}
function writeJson(path, value) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
