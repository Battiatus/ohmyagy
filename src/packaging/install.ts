import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkspacePluginInstall {
  pluginDir: string;
  hookPath: string;
  mcpServerPath: string;
  gatesPath: string;
  agentsInstalled: string[];
  skillsInstalled: string[];
}

export interface InstallOptions {
  gates?: Array<{ id: string; program: string; args: string[]; timeoutMs: number }>;
  force?: boolean;
  global?: boolean;
}

export function installWorkspacePlugin(
  workspaceRoot: string,
  options: InstallOptions = {},
): WorkspacePluginInstall {
  const workspace = resolve(workspaceRoot);
  const pluginsRoot = join(workspace, ".agents", "plugins");
  const pluginDir = join(pluginsRoot, "oma");
  if (existsSync(pluginDir) && !options.force) {
    throw new Error(`OMA plugin already exists: ${pluginDir}`);
  }
  const candidatesHook = [
    fileURLToPath(new URL("../strict/hook.js", import.meta.url)),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/src/strict/hook.js"),
    fileURLToPath(new URL("../strict/hook.ts", import.meta.url)),
  ];
  const hookPath = candidatesHook.find((p) => existsSync(p)) ?? candidatesHook[0];

  const candidatesSummarizerHook = [
    fileURLToPath(new URL("../brain/summarizer-hook.js", import.meta.url)),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/src/brain/summarizer-hook.js"),
    fileURLToPath(new URL("../brain/summarizer-hook.ts", import.meta.url)),
  ];
  const summarizerHookPath =
    candidatesSummarizerHook.find((p) => existsSync(p)) ?? candidatesSummarizerHook[0];

  const candidatesMcp = [
    fileURLToPath(new URL("../mcp/broker-server.js", import.meta.url)),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/src/mcp/broker-server.js"),
    fileURLToPath(new URL("../mcp/broker-server.ts", import.meta.url)),
  ];
  const mcpServerPath = candidatesMcp.find((p) => existsSync(p)) ?? candidatesMcp[0];

  if (!existsSync(hookPath) || !existsSync(mcpServerPath)) {
    throw new Error(`Build artifacts are missing: hookPath=${hookPath}, mcpServerPath=${mcpServerPath}`);
  }
  const hookCommand = antigravityCommand([process.execPath, hookPath]);
  const summarizerHookCommand = antigravityCommand([process.execPath, summarizerHookPath]);
  const stagingDir = join(pluginsRoot, `.oma-install-${process.pid}`);
  if (existsSync(stagingDir)) {
    throw new Error(`Installer staging directory already exists: ${stagingDir}`);
  }

  mkdirSync(join(stagingDir, "rules"), { recursive: true });
  mkdirSync(join(stagingDir, "agents"), { recursive: true });
  mkdirSync(join(stagingDir, "skills"), { recursive: true });

  const gates = options.gates ?? [defaultNpmTestGate()];
  const gatesPath = join(pluginDir, "gates.json");

  const agentsInstalled: string[] = [];
  const skillsInstalled: string[] = [];

  try {
    writeJson(join(stagingDir, "plugin.json"), {
      $schema: "https://antigravity.google/schemas/v1/plugin.json",
      name: "oma",
      description: "Oh My Antigravity: Multi-agent orchestration, dynamic workflows and graph engineering.",
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
      "oma-memory-summarizer": {
        enabled: true,
        Stop: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: summarizerHookCommand,
                timeout: 30,
              },
            ],
          },
        ],
      },
    });

    writeJson(join(stagingDir, "gates.json"), { schemaVersion: 1, gates });
    const mcpCommand = mcpServerPath.endsWith(".ts")
      ? "bun"
      : process.execPath.toLowerCase().includes("bun")
      ? "bun"
      : "node";
    const mcpArgs = mcpServerPath.endsWith(".ts") ? ["run", mcpServerPath] : [mcpServerPath];

    writeJson(join(stagingDir, "mcp_config.json"), {
      mcpServers: {
        "oma-broker": {
          command: mcpCommand,
          args: mcpArgs,
          cwd: workspace,
          env: {
            OMA_WORKSPACE_ROOT: workspace,
            OMA_GATES_PATH: gatesPath,
          },
        },
      },
    });

    writeFileSync(
      join(stagingDir, "rules", "oma-strict.md"),
      [
        "# OMA Strict Workflow Rules",
        "",
        "1. All workspace mutations must occur within authorized OMA worktrees (.oma/worktrees/).",
        "2. Direct mutation of the root target repository is forbidden in strict mode.",
        "3. Graph transitions and approvals belong strictly to named authorities and objective gates.",
        "4. WorkItem acceptance is determined by independent adversarial review and objective evidence.",
        "5. Self-certification and unverified completion claims are rejected.",
        "",
      ].join("\n"),
      "utf8",
    );

    // Deploy Core MoE Personas
    deployCoreAgents(stagingDir);

    // Deploy Core Skills
    deployCoreSkills(stagingDir);

    // Copy any assets from plugin-assets if available
    const candidatesAssets = [
      fileURLToPath(new URL("../plugin-assets", import.meta.url)),
      resolve(dirname(fileURLToPath(import.meta.url)), "../../src/plugin-assets"),
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/plugin-assets"),
    ];
    const assetsDir = candidatesAssets.find((p) => existsSync(p));
    if (assetsDir && existsSync(assetsDir)) {
      const sourceAgents = join(assetsDir, "agents");
      if (existsSync(sourceAgents)) {
        for (const file of readdirSync(sourceAgents)) {
          if (file.endsWith(".md")) {
            cpSync(join(sourceAgents, file), join(stagingDir, "agents", file));
          }
        }
      }
      const sourceSkills = join(assetsDir, "skills");
      if (existsSync(sourceSkills)) {
        cpSync(sourceSkills, join(stagingDir, "skills"), { recursive: true });
      }
      const sourceCommands = join(assetsDir, "commands");
      if (existsSync(sourceCommands)) {
        cpSync(sourceCommands, join(stagingDir, "commands"), { recursive: true });
      }
    }

    if (existsSync(pluginDir)) {
      rmSync(pluginDir, { recursive: true, force: true });
    }
    mkdirSync(pluginDir, { recursive: true });
    cpSync(stagingDir, pluginDir, { recursive: true, force: true });

    // Deploy directly to .agents/agents and .agents/skills for native AntiGravity CLI discovery
    const nativeAgentsDir = join(workspace, ".agents", "agents");
    mkdirSync(nativeAgentsDir, { recursive: true });

    // Clean up any legacy flat files (.agents/agents/*.md) to avoid directory/file collisions
    for (const item of readdirSync(nativeAgentsDir)) {
      if (item.endsWith(".md")) {
        try {
          rmSync(join(nativeAgentsDir, item), { force: true });
        } catch {}
      }
    }

    // Clean up legacy archived agent directories
    const LEGACY_ARCHIVED_AGENTS = [
      "atlas",
      "benchmark",
      "fixer",
      "forensic",
      "metis",
      "prometheus",
      "repairer",
      "sisyphus",
      "themis",
    ];
    for (const legacy of LEGACY_ARCHIVED_AGENTS) {
      const legacyFolder = join(nativeAgentsDir, legacy);
      if (existsSync(legacyFolder)) {
        try {
          rmSync(legacyFolder, { recursive: true, force: true });
        } catch {}
      }
      const legacyFlat = join(nativeAgentsDir, `${legacy}.md`);
      if (existsSync(legacyFlat)) {
        try {
          rmSync(legacyFlat, { force: true });
        } catch {}
      }
    }

    const agentsDir = join(stagingDir, "agents");
    if (existsSync(agentsDir)) {
      for (const file of readdirSync(agentsDir)) {
        if (file.endsWith(".md")) {
          const agentName = file.replace(/\.md$/, "");
          // Folder: .agents/agents/{agent_name}/agent.md
          const agentFolder = join(nativeAgentsDir, agentName);
          mkdirSync(agentFolder, { recursive: true });
          cpSync(join(agentsDir, file), join(agentFolder, "agent.md"), { force: true });
          agentsInstalled.push(agentName);
        }
      }
    }

    const nativeSkillsDir = join(workspace, ".agents", "skills");
    mkdirSync(nativeSkillsDir, { recursive: true });
    const skillsDir = join(stagingDir, "skills");
    if (existsSync(skillsDir)) {
      for (const s of readdirSync(skillsDir)) {
        const sourceSkill = join(skillsDir, s);
        const targetSkill = join(nativeSkillsDir, s);
        mkdirSync(targetSkill, { recursive: true });
        cpSync(sourceSkill, targetSkill, { recursive: true, force: true });
        skillsInstalled.push(s);
      }
    }

    // Optional global installation into ~/.gemini/config/agents and ~/.gemini/config/plugins/oma
    if (options.global) {
      const home = process.env.USERPROFILE || process.env.HOME;
      if (home) {
        const globalAgentsDir = join(home, ".gemini", "config", "agents");
        mkdirSync(globalAgentsDir, { recursive: true });
        for (const legacy of LEGACY_ARCHIVED_AGENTS) {
          const legacyFolder = join(globalAgentsDir, legacy);
          if (existsSync(legacyFolder)) {
            try {
              rmSync(legacyFolder, { recursive: true, force: true });
            } catch {}
          }
          const legacyFlat = join(globalAgentsDir, `${legacy}.md`);
          if (existsSync(legacyFlat)) {
            try {
              rmSync(legacyFlat, { force: true });
            } catch {}
          }
        }
        if (existsSync(agentsDir)) {
          for (const file of readdirSync(agentsDir)) {
            if (file.endsWith(".md")) {
              const agentName = file.replace(/\.md$/, "");
              const globalAgentFolder = join(globalAgentsDir, agentName);
              mkdirSync(globalAgentFolder, { recursive: true });
              cpSync(join(agentsDir, file), join(globalAgentFolder, "agent.md"), { force: true });
            }
          }
        }

        const globalPluginDir = join(home, ".gemini", "config", "plugins", "oma");
        if (existsSync(globalPluginDir)) {
          try {
            rmSync(globalPluginDir, { recursive: true, force: true });
          } catch {}
        }
        mkdirSync(globalPluginDir, { recursive: true });
        cpSync(stagingDir, globalPluginDir, { recursive: true, force: true });
      }
    }

    rmSync(stagingDir, { recursive: true, force: true });
  } catch (error) {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
    throw error;
  }

  return { pluginDir, hookPath, mcpServerPath, gatesPath, agentsInstalled, skillsInstalled };
}

function deployCoreAgents(stagingDir: string): void {
  const agents = [
    {
      name: "orchestrator",
      content: [
        "---",
        "name: orchestrator",
        "description: OMA Orchestrator for mission lifecycle coordination, dynamic convergence, and interview mediation",
        "---",
        "# OMA Orchestrator",
        "Guides the multi-agent mission lifecycle, coordinates dynamic convergence steps, and mediates user interview gates.",
      ].join("\n"),
    },
    {
      name: "planner",
      content: [
        "---",
        "name: planner",
        "description: OMA Planner and task discovery specialist",
        "---",
        "# OMA Planner",
        "Discovers and decomposes work items from goals, repository topology and objective judge diagnostics.",
        "Read-only proposer. Never mutates workspace files directly.",
      ].join("\n"),
    },
    {
      name: "explorer",
      content: [
        "---",
        "name: explorer",
        "description: OMA Explorer for codebase mapping, dependency tracing, and context discovery",
        "---",
        "# OMA Explorer",
        "Inspects repositories, traces dependency graphs, and locates code symbols without mutating files.",
        "Read-only factual analyst.",
      ].join("\n"),
    },
    {
      name: "executor",
      content: [
        "---",
        "name: executor",
        "description: OMA Executor for implementation and targeted code modifications",
        "---",
        "# OMA Executor",
        "Implements scoped code modifications within isolated worktrees.",
        "Produces clean diffs and tests before review handoff.",
      ].join("\n"),
    },
    {
      name: "worker",
      content: [
        "---",
        "name: worker",
        "description: OMA Worker for implementation and targeted execution (alias for executor)",
        "---",
        "# OMA Worker",
        "Implements scoped code modifications within isolated worktrees.",
        "Produces clean diffs and tests before review handoff.",
      ].join("\n"),
    },
    {
      name: "reviewer",
      content: [
        "---",
        "name: reviewer",
        "description: OMA Adversarial Reviewer for independent quality audits",
        "---",
        "# OMA Reviewer",
        "Performs independent adversarial audits on staged diffs and evidence.",
        "Evaluates correctness, edge cases and security. Read-only.",
      ].join("\n"),
    },
    {
      name: "verifier",
      content: [
        "---",
        "name: verifier",
        "description: OMA Verifier for automated gate execution and test verification",
        "---",
        "# OMA Verifier",
        "Executes deterministic verification gates on staged worktrees and generates test proofs. Read-only.",
      ].join("\n"),
    },
    {
      name: "summarizer",
      content: [
        "---",
        "name: summarizer",
        "description: OMA memory mini-agent — compresses each interaction into context+actions for the Neural Brain (Gemini Flash, read-only)",
        "---",
        "# OMA Memory Summarizer",
        "Compresses each interaction round into dense, factual context and actions records for the Neural Brain.",
      ].join("\n"),
    },
  ];

  for (const agent of agents) {
    writeFileSync(join(stagingDir, "agents", `${agent.name}.md`), `${agent.content}\n`, "utf8");
  }
}

function deployCoreSkills(stagingDir: string): void {
  const skills = [
    {
      name: "dynamic-workflow",
      doc: [
        "---",
        "name: dynamic-workflow",
        "description: OMA dynamic workflow protocol for adaptive multi-wave convergence",
        "---",
        "# Dynamic Workflow",
        "Guides adaptive execution through discover, parallel workers, adversarial reviews and gate verification.",
      ].join("\n"),
    },
    {
      name: "quality-oracle",
      doc: [
        "---",
        "name: quality-oracle",
        "description: Objective judge and gate evaluation protocol",
        "---",
        "# Quality Oracle",
        "Evaluates visible and hidden tests, progress vectors and acceptance verification.",
      ].join("\n"),
    },
    {
      name: "graph-recovery",
      doc: [
        "---",
        "name: graph-recovery",
        "description: Crash recovery and deterministic state reconstruction protocol for Oh My Antigravity (OMA)",
        "---",
        "# Graph Recovery",
        "Reconstructs execution graph state and re-verifies invariant gates upon resumption.",
      ].join("\n"),
    },
    {
      name: "staged-review",
      doc: [
        "---",
        "name: staged-review",
        "description: 2-Phase Commit staged code review and promotion protocol for Oh My Antigravity (OMA)",
        "---",
        "# Staged Review",
        "Enforces dual adversarial peer review and objective gate proof before promotion.",
      ].join("\n"),
    },
  ];

  for (const skill of skills) {
    const sDir = join(stagingDir, "skills", skill.name);
    mkdirSync(sDir, { recursive: true });
    writeFileSync(join(sDir, "SKILL.md"), `${skill.doc}\n`, "utf8");
  }
}

function antigravityCommand(parts: string[]): string {
  return parts
    .map((part) => {
      const normalized = part.replaceAll("\\", "/");
      return /\s/u.test(normalized) && !normalized.startsWith("\"")
        ? `"${normalized}"`
        : normalized;
    })
    .join(" ");
}

function defaultNpmTestGate() {
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) {
    return {
      id: "npm-test",
      program: process.execPath,
      args: ["--test"],
      timeoutMs: 300_000,
    };
  }
  return {
    id: "npm-test",
    program: process.execPath,
    args: [npmCli, "test"],
    timeoutMs: 300_000,
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
