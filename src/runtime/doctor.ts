import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { AgyDriver } from "./agy-driver.js";

export interface DoctorReport {
  timestamp: string;
  os: string;
  architecture: string;
  agyCli: {
    available: boolean;
    path?: string;
    version?: string;
    supportedFlags: string[];
    error?: string;
    diagnostics: string[];
  };
  bunCli: {
    available: boolean;
    path?: string;
    version?: string;
  };
  gitCli: {
    available: boolean;
    path?: string;
    version?: string;
  };
  nodeCli: {
    available: boolean;
    path?: string;
    version?: string;
  };
  pluginDiscovery: {
    installed: boolean;
    pluginPath?: string;
    valid: boolean;
    agentsDetected: string[];
    skillsDetected: string[];
    declaredAgents: string[];
    declaredSkills: string[];
    diagnostics: string[];
  };
}

export class OmaDoctor {
  public static diagnoseEnvironment(workspaceRoot = process.cwd()): DoctorReport {
    const isWindows = process.platform === "win32";

    // 1. Detect Git
    let gitInfo = { available: false, path: undefined as string | undefined, version: undefined as string | undefined };
    try {
      const gitRes = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 1000 });
      if (gitRes.status === 0 && gitRes.stdout) {
        gitInfo = { available: true, path: "git", version: gitRes.stdout.trim() };
      }
    } catch {}

    // 2. Detect Bun
    let bunInfo = { available: false, path: undefined as string | undefined, version: undefined as string | undefined };
    try {
      const bunRes = spawnSync("bun", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 1000 });
      if (bunRes.status === 0 && bunRes.stdout) {
        bunInfo = { available: true, path: "bun", version: bunRes.stdout.trim() };
      }
    } catch {}

    // 3. Detect Node
    let nodeInfo = { available: false, path: undefined as string | undefined, version: undefined as string | undefined };
    try {
      nodeInfo = { available: true, path: process.execPath, version: process.version };
    } catch {}

    // 4. Detect AntiGravity (agy / agy.exe / gemini)
    let agyInfo: DoctorReport["agyCli"] = {
      available: false,
      supportedFlags: [],
      diagnostics: [],
    };

    const resolvedAgy = AgyDriver.resolveAgyBinary();
    if (resolvedAgy && existsSync(resolvedAgy) && isActualAgyExecutable(resolvedAgy)) {
      agyInfo.path = resolvedAgy;
      try {
        const verProc = spawnSync(resolvedAgy, ["--version"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5_000,
        });
        if (verProc.status === 0 && verProc.stdout.trim()) {
          agyInfo.version = verProc.stdout.trim();
        } else {
          agyInfo.diagnostics.push(`agy --version failed: ${String(verProc.stderr ?? "").trim() || `exit ${String(verProc.status)}`}`);
        }
      } catch {
        agyInfo.diagnostics.push("agy --version could not be executed");
      }

      try {
        const helpProc = spawnSync(resolvedAgy, ["--help"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5_000,
        });
        if (helpProc.status === 0) {
          const helpOut = `${helpProc.stdout ?? ""}\n${helpProc.stderr ?? ""}`;
          const flags = ["--agent", "-p", "--output-format", "--effort", "--add-dir", "--print-timeout", "--model", "--mode"];
          agyInfo.supportedFlags = flags.filter((flag) => helpOut.includes(flag));
          const missingFlags = flags.filter((flag) => !agyInfo.supportedFlags.includes(flag));
          if (missingFlags.length > 0) {
            agyInfo.diagnostics.push(`agy --help is missing required flags: ${missingFlags.join(", ")}`);
          }
        } else {
          agyInfo.diagnostics.push(`agy --help failed: ${String(helpProc.stderr ?? "").trim() || `exit ${String(helpProc.status)}`}`);
        }
      } catch {
        agyInfo.diagnostics.push("agy --help could not be executed");
      }
    } else {
      agyInfo.error = `Resolved AntiGravity executable is unavailable or not agy.exe: ${resolvedAgy}`;
    }

    agyInfo.available = Boolean(agyInfo.path && existsSync(agyInfo.path) && !agyInfo.error);

    // 5. Plugin Discovery & Live AGY Attestation
    const pluginDir = join(workspaceRoot, ".agents", "plugins", "oma");
    const pluginInstalled = existsSync(pluginDir);
    const agentsDetected: string[] = [];
    const skillsDetected: string[] = [];
    const declaredAgents: string[] = [];
    const declaredSkills: string[] = [];
    const diagnostics: string[] = [];
    const coreAgentsRequired = ["planner", "worker", "reviewer", "fixer"];

    if (pluginInstalled) {
      const pluginJsonPath = join(pluginDir, "plugin.json");
      if (!existsSync(pluginJsonPath)) {
        diagnostics.push("plugin.json missing in installed plugin directory");
      }

      const agentsDir = join(pluginDir, "agents");
      if (existsSync(agentsDir)) {
        try {
          for (const f of readdirSync(agentsDir).filter((file: string) => file.endsWith(".md"))) {
            const name = f.replace(/\.md$/, "");
            if (!declaredAgents.includes(name)) declaredAgents.push(name);
          }
        } catch {}
      }

      const skillsDir = join(pluginDir, "skills");
      if (existsSync(skillsDir)) {
        try {
          for (const s of readdirSync(skillsDir)) {
            if (!declaredSkills.includes(s)) declaredSkills.push(s);
          }
        } catch {}
      }

      for (const req of coreAgentsRequired) {
        if (!declaredAgents.includes(req)) {
          diagnostics.push(`Core agent persona '${req}' is missing from the workspace plugin`);
        }
      }

      // Attest deployed agents in workspace (.agents/agents/{agent}/agent.md) or pluginDir
      const nativeAgentsDir = join(workspaceRoot, ".agents", "agents");
      for (const req of coreAgentsRequired) {
        const nativeFolder = join(nativeAgentsDir, req, "agent.md");
        const nativeFlat = join(nativeAgentsDir, `${req}.md`);
        const pluginFile = join(pluginDir, "agents", `${req}.md`);
        if (existsSync(nativeFolder) || existsSync(nativeFlat) || existsSync(pluginFile)) {
          agentsDetected.push(req);
        } else {
          diagnostics.push(`Core agent persona '${req}' is missing from the workspace plugin`);
        }
      }

      // Attest deployed skills in workspace (.agents/skills/{skill}/SKILL.md) or pluginDir
      const nativeSkillsDir = join(workspaceRoot, ".agents", "skills");
      for (const skill of declaredSkills) {
        const nativeSkill = join(nativeSkillsDir, skill, "SKILL.md");
        const pluginSkill = join(pluginDir, "skills", skill, "SKILL.md");
        if (existsSync(nativeSkill) || existsSync(pluginSkill)) {
          skillsDetected.push(skill);
        }
      }
    } else {
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
        valid: pluginInstalled && diagnostics.length === 0 && agentsDetected.length >= coreAgentsRequired.length,
        agentsDetected: Array.from(new Set(agentsDetected)),
        skillsDetected: Array.from(new Set(skillsDetected)),
        declaredAgents: Array.from(new Set(declaredAgents)),
        declaredSkills: Array.from(new Set(declaredSkills)),
        diagnostics,
      },
    };
  }
}

function isActualAgyExecutable(filePath: string): boolean {
  if (!filePath) return false;
  const name = basename(filePath).toLocaleLowerCase("en-US");
  if (process.platform === "win32") {
    return (
      name === "agy.exe" ||
      name === "agy.cmd" ||
      name === "gemini.cmd" ||
      name === "gemini.exe" ||
      name === "agy" ||
      name === "gemini"
    );
  }
  return name === "agy" || name === "gemini";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
