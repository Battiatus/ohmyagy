import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
export class OmaDoctor {
    static diagnoseEnvironment(workspaceRoot = process.cwd()) {
        const isWindows = process.platform === "win32";
        // 1. Detect Git
        let gitInfo = { available: false, path: undefined, version: undefined };
        try {
            const gitPath = isWindows
                ? execSync("where.exe git", { encoding: "utf8" }).trim().split(/\r?\n/)[0]
                : execSync("which git", { encoding: "utf8" }).trim();
            const gitVer = execSync("git --version", { encoding: "utf8" }).trim();
            gitInfo = { available: true, path: gitPath, version: gitVer };
        }
        catch {
            // Git unavailable
        }
        // 2. Detect Bun
        let bunInfo = { available: false, path: undefined, version: undefined };
        try {
            const bunPath = isWindows
                ? execSync("where.exe bun", { encoding: "utf8" }).trim().split(/\r?\n/)[0]
                : execSync("which bun", { encoding: "utf8" }).trim();
            const bunVer = execSync("bun --version", { encoding: "utf8" }).trim();
            bunInfo = { available: true, path: bunPath, version: bunVer };
        }
        catch {
            // Bun unavailable
        }
        // 3. Detect Node
        let nodeInfo = { available: false, path: undefined, version: undefined };
        try {
            nodeInfo = { available: true, path: process.execPath, version: process.version };
        }
        catch {
            // Node unavailable
        }
        // 4. Detect AntiGravity (agy / agy.exe / gemini)
        let agyInfo = {
            available: false,
            supportedFlags: [],
        };
        const agyBinCandidates = [
            process.env.OMA_AGY_BIN,
            "agy.exe",
            "agy",
            "agy.cmd",
            "gemini.exe",
            "gemini.cmd",
            "gemini",
        ].filter(Boolean);
        for (const candidate of agyBinCandidates) {
            try {
                const checkCmd = isWindows ? `where.exe "${candidate}"` : `which "${candidate}"`;
                const resolvedPath = execSync(checkCmd, { encoding: "utf8" }).trim().split(/\r?\n/)[0];
                if (resolvedPath && existsSync(resolvedPath)) {
                    agyInfo.path = resolvedPath;
                    agyInfo.available = true;
                    // Attempt --version
                    try {
                        const verOut = execSync(`"${resolvedPath}" --version`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
                        agyInfo.version = verOut;
                    }
                    catch {
                        agyInfo.version = "unknown";
                    }
                    // Attempt --help to detect flags
                    try {
                        const helpOut = execSync(`"${resolvedPath}" --help`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
                        const flags = ["--agent", "-p", "--output-format", "--effort", "--sandbox", "--json-schema", "--model"];
                        agyInfo.supportedFlags = flags.filter((f) => helpOut.includes(f));
                    }
                    catch {
                        agyInfo.supportedFlags = ["-p", "--agent", "--output-format", "--effort", "--sandbox", "--model"];
                    }
                    break;
                }
            }
            catch {
                // Try next candidate
            }
        }
        if (!agyInfo.available) {
            agyInfo.error = "AntiGravity CLI executable not found in PATH. Provide OMA_AGY_BIN or ensure agy is installed.";
            agyInfo.supportedFlags = ["-p", "--agent", "--output-format", "--effort", "--sandbox", "--model"];
        }
        // 5. Plugin Discovery & Live AGY Attestation
        const pluginDir = join(workspaceRoot, ".agents", "plugins", "oma");
        const pluginInstalled = existsSync(pluginDir);
        const agentsDetected = [];
        const skillsDetected = [];
        const diagnostics = [];
        // Query AGY CLI live for agents and plugins
        if (pluginInstalled) {
            if (agyInfo.available && agyInfo.path) {
                try {
                    const agentsOutput = execSync(`"${agyInfo.path}" agents`, {
                        encoding: "utf8",
                        stdio: ["ignore", "pipe", "ignore"],
                    });
                    for (const line of agentsOutput.split(/\r?\n/)) {
                        const match = line.match(/^\s*-\s*([a-zA-Z0-9_-]+)/);
                        if (match && match[1]) {
                            agentsDetected.push(match[1]);
                        }
                    }
                }
                catch (e) {
                    diagnostics.push(`Failed to query live agents from AGY CLI: ${e instanceof Error ? e.message : String(e)}`);
                }
                try {
                    const pluginOutput = execSync(`"${agyInfo.path}" plugin list`, {
                        encoding: "utf8",
                        stdio: ["ignore", "pipe", "ignore"],
                    });
                    if (!pluginOutput.includes("oma")) {
                        diagnostics.push("OMA plugin is not listed in live `agy plugin list` output");
                    }
                    if (pluginOutput.includes("dynamic-workflow"))
                        skillsDetected.push("dynamic-workflow");
                    if (pluginOutput.includes("quality-oracle"))
                        skillsDetected.push("quality-oracle");
                }
                catch (e) {
                    diagnostics.push(`Failed to query live plugins from AGY CLI: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            const pluginJsonPath = join(pluginDir, "plugin.json");
            if (!existsSync(pluginJsonPath)) {
                diagnostics.push("plugin.json missing in installed plugin directory");
            }
            const agentsDir = join(pluginDir, "agents");
            if (existsSync(agentsDir)) {
                try {
                    for (const f of readdirSync(agentsDir).filter((file) => file.endsWith(".md"))) {
                        const name = f.replace(/\.md$/, "");
                        if (!agentsDetected.includes(name))
                            agentsDetected.push(name);
                    }
                }
                catch { }
            }
            const skillsDir = join(pluginDir, "skills");
            if (existsSync(skillsDir)) {
                try {
                    for (const s of readdirSync(skillsDir)) {
                        if (!skillsDetected.includes(s))
                            skillsDetected.push(s);
                    }
                }
                catch { }
            }
            const coreAgentsRequired = ["planner", "worker", "reviewer", "fixer"];
            for (const req of coreAgentsRequired) {
                if (!agentsDetected.includes(req)) {
                    diagnostics.push(`Core agent persona '${req}' missing from detected agents`);
                }
            }
        }
        else {
            diagnostics.push("OMA plugin is not installed in workspace (.agents/plugins/oma)");
        }
        return {
            timestamp: new Date().toISOString(),
            os: `${process.platform} ${process.arch}`,
            architecture: process.arch,
            agyCli: agyInfo,
            bunCli: bunInfo,
            gitCli: gitInfo,
            nodeCli: nodeInfo,
            pluginDiscovery: {
                installed: pluginInstalled,
                pluginPath: pluginInstalled ? pluginDir : undefined,
                valid: pluginInstalled && diagnostics.length === 0,
                agentsDetected: Array.from(new Set(agentsDetected)),
                skillsDetected: Array.from(new Set(skillsDetected)),
                diagnostics,
            },
        };
    }
}
