export interface ExpertSpec {
  id: string;
  role: "planner" | "explorer" | "worker" | "reviewer" | "fixer" | "verifier";
  taskKinds: string[];
  modelClass: "fast" | "balanced" | "frontier";
  effort: "low" | "medium" | "high";
  tools: string[];
  readOnly: boolean;
}

export interface ResolvedCapability {
  expertId: string;
  agentName: string;
  modelSlug: string;
  effort: "low" | "medium" | "high";
  sandbox: "workspace-write" | "read-only";
  allowedTools: string[];
  readOnly: boolean;
}

export class CapabilityResolver {
  public static readonly DEFAULT_MODELS: Record<"fast" | "balanced" | "frontier", string> = {
    fast: "gemini-2.5-flash",
    balanced: "gemini-3.7-flash",
    frontier: "gemini-3.7-pro",
  };

  public static readonly CORE_EXPERTS: Record<string, ExpertSpec> = {
    planner: {
      id: "planner",
      role: "planner",
      taskKinds: ["discovery", "decomposition", "planning"],
      modelClass: "frontier",
      effort: "high",
      tools: ["view_file", "grep_search", "find_by_name", "list_dir"],
      readOnly: true,
    },
    worker: {
      id: "worker",
      role: "worker",
      taskKinds: ["implementation", "refactoring", "bugfix"],
      modelClass: "balanced",
      effort: "medium",
      tools: [
        "view_file",
        "grep_search",
        "find_by_name",
        "list_dir",
        "write_to_file",
        "replace_file_content",
        "run_command",
      ],
      readOnly: false,
    },
    reviewer: {
      id: "reviewer",
      role: "reviewer",
      taskKinds: ["adversarial-review", "security-audit", "diff-review"],
      modelClass: "frontier",
      effort: "high",
      tools: ["view_file", "grep_search", "find_by_name", "list_dir"],
      readOnly: true,
    },
    fixer: {
      id: "fixer",
      role: "fixer",
      taskKinds: ["targeted-fix", "diagnostic-resolution"],
      modelClass: "balanced",
      effort: "medium",
      tools: [
        "view_file",
        "grep_search",
        "find_by_name",
        "list_dir",
        "write_to_file",
        "replace_file_content",
        "run_command",
      ],
      readOnly: false,
    },
  };

  public static resolve(
    spec: ExpertSpec | string,
    overrides: { modelOverride?: string; effortOverride?: "low" | "medium" | "high" } = {},
  ): ResolvedCapability {
    const expert: ExpertSpec =
      typeof spec === "string"
        ? this.CORE_EXPERTS[spec] ?? {
            id: spec,
            role: "worker",
            taskKinds: ["general"],
            modelClass: "balanced",
            effort: "medium",
            tools: ["view_file", "grep_search", "write_to_file", "replace_file_content"],
            readOnly: false,
          }
        : spec;

    const modelSlug = overrides.modelOverride ?? this.DEFAULT_MODELS[expert.modelClass];
    const effort = overrides.effortOverride ?? expert.effort;
    const sandbox = expert.readOnly ? "read-only" : "workspace-write";

    return {
      expertId: expert.id,
      agentName: expert.id,
      modelSlug,
      effort,
      sandbox,
      allowedTools: [...expert.tools],
      readOnly: expert.readOnly,
    };
  }
}
