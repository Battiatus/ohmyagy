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
}

export interface InstallOptions {
  gates?: Array<{ id: string; program: string; args: string[]; timeoutMs: number }>;
  force?: boolean;
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
  const stagingDir = join(pluginsRoot, `.oma-install-${process.pid}`);
  if (existsSync(stagingDir)) {
    throw new Error(`Installer staging directory already exists: ${stagingDir}`);
  }

  mkdirSync(join(stagingDir, "rules"), { recursive: true });
  mkdirSync(join(stagingDir, "agents"), { recursive: true });
  mkdirSync(join(stagingDir, "skills"), { recursive: true });

  const gates = options.gates ?? [defaultNpmTestGate()];
  const gatesPath = join(pluginDir, "gates.json");

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
    const assetsDir = fileURLToPath(new URL("../plugin-assets", import.meta.url));
    if (existsSync(assetsDir)) {
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
    }

    if (existsSync(pluginDir)) {
      rmSync(pluginDir, { recursive: true, force: true });
    }
    mkdirSync(dirname(pluginDir), { recursive: true });
    renameSync(stagingDir, pluginDir);
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }

  return { pluginDir, hookPath, mcpServerPath, gatesPath };
}

function deployCoreAgents(stagingDir: string): void {
  const agents = [
    {
      name: "planner",
      content: [
        "---",
        "name: planner",
        "role: Planner & Task Discovery Specialist",
        "model: frontier",
        "effort: high",
        "readOnly: true",
        "tools: [view_file, grep_search, find_by_name, list_dir]",
        "---",
        "# OMA Planner",
        "Discovers and decomposes work items from goals, repository topology and objective judge diagnostics.",
        "Read-only proposer. Never mutates workspace files directly.",
      ].join("\n"),
    },
    {
      name: "worker",
      content: [
        "---",
        "name: worker",
        "role: Implementation & Targeted Execution Specialist",
        "model: balanced",
        "effort: medium",
        "readOnly: false",
        "tools: [view_file, grep_search, find_by_name, list_dir, write_to_file, replace_file_content, run_command]",
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
        "role: Adversarial Reviewer & Quality Auditor",
        "model: frontier",
        "effort: high",
        "readOnly: true",
        "tools: [view_file, grep_search, find_by_name, list_dir]",
        "---",
        "# OMA Reviewer",
        "Performs independent adversarial audits on staged diffs and evidence.",
        "Evaluates correctness, edge cases and security. Read-only.",
      ].join("\n"),
    },
    {
      name: "fixer",
      content: [
        "---",
        "name: fixer",
        "role: Targeted Defect Resolution Specialist",
        "model: balanced",
        "effort: medium",
        "readOnly: false",
        "tools: [view_file, grep_search, find_by_name, list_dir, write_to_file, replace_file_content, run_command]",
        "---",
        "# OMA Fixer",
        "Implements targeted fixes and surgical repairs derived from quality oracle diagnostics.",
        "Produces clean diffs and tests before review handoff.",
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
