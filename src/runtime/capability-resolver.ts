import { resolveModelForClass } from "./model-catalog.js";

export type VisionRole =
  | "orchestrator"
  | "planner"
  | "explorer"
  | "executor"
  | "reviewer"
  | "verifier";

export const ROLE_ALIASES: Record<string, string> = {
  worker: "executor",
  executor: "executor",
  orchestrator: "session",
  session: "orchestrator",
};

export interface ExpertSpec {
  id: string;
  role: VisionRole | "worker" | "fixer";
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
  /**
   * Model class -> slug, resolved against the **installed** build.
   *
   * These were hardcoded (`gemini-2.5-flash`, `gemini-3.7-flash`, `gemini-3.7-pro`) and
   * none of them exists in AntiGravity 1.2.1, so every role dispatch failed while the
   * process runner reported success. See `model-catalog.ts`.
   */
  public static readonly DEFAULT_MODELS: Record<"fast" | "balanced" | "frontier", string> = {
    get fast() {
      return resolveModelForClass("fast");
    },
    get balanced() {
      return resolveModelForClass("balanced");
    },
    get frontier() {
      return resolveModelForClass("frontier");
    },
  };

  public static readonly CORE_EXPERTS: Record<string, ExpertSpec> = {
    orchestrator: {
      id: "orchestrator",
      role: "orchestrator",
      taskKinds: ["orchestration", "coordination", "interview-mediation"],
      modelClass: "frontier",
      effort: "high",
      tools: ["view_file", "grep_search", "find_by_name", "list_dir"],
      readOnly: true,
    },
    planner: {
      id: "planner",
      role: "planner",
      taskKinds: ["discovery", "decomposition", "planning"],
      modelClass: "frontier",
      effort: "high",
      tools: ["view_file", "grep_search", "find_by_name", "list_dir"],
      readOnly: true,
    },
    explorer: {
      id: "explorer",
      role: "explorer",
      taskKinds: ["exploration", "topology-mapping", "context-gathering"],
      modelClass: "balanced",
      effort: "medium",
      tools: ["view_file", "grep_search", "find_by_name", "list_dir"],
      readOnly: true,
    },
    executor: {
      id: "executor",
      role: "executor",
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
    get worker() {
      return this.executor;
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
    verifier: {
      id: "verifier",
      role: "verifier",
      taskKinds: ["test-verification", "gate-evaluation", "acceptance-testing"],
      modelClass: "frontier",
      effort: "high",
      tools: ["view_file", "grep_search", "find_by_name", "list_dir", "run_command"],
      readOnly: true,
    },
  };

  public static resolve(
    spec: ExpertSpec | VisionRole | string,
    overrides: { modelOverride?: string; effortOverride?: "low" | "medium" | "high" } = {},
  ): ResolvedCapability {
    let expert: ExpertSpec;
    if (typeof spec === "string") {
      let role = spec;
      if (role === "worker") {
        role = "executor";
      }
      const aliasTarget = ROLE_ALIASES[role] ?? ROLE_ALIASES[spec];
      expert =
        this.CORE_EXPERTS[role] ??
        this.CORE_EXPERTS[spec] ??
        (aliasTarget ? this.CORE_EXPERTS[aliasTarget] : undefined) ?? {
          id: role,
          role: "executor",
          taskKinds: ["general"],
          modelClass: "balanced",
          effort: "medium",
          tools: ["view_file", "grep_search", "write_to_file", "replace_file_content"],
          readOnly: false,
        };
    } else {
      expert = spec.role === "worker" ? { ...spec, role: "executor" } : spec;
    }

    const modelSlug = overrides.modelOverride ?? this.DEFAULT_MODELS[expert.modelClass];
    const effort = overrides.effortOverride ?? expert.effort;
    const sandbox = expert.readOnly ? "read-only" : "workspace-write";
    const agentName = typeof spec === "string" && spec === "worker" ? "worker" : expert.id;

    return {
      expertId: expert.id,
      agentName,
      modelSlug,
      effort,
      sandbox,
      allowedTools: [...expert.tools],
      readOnly: expert.readOnly,
    };
  }
}
