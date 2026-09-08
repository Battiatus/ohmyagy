import type { VisionRole } from "./capability-resolver.js";
import type { OracleGate } from "../oracle/executor.js";

/**
 * Canonical mission modes representing distinct engineering workflows.
 * In Oh My Antigravity, modes are configurations (prompt overlays, quality gates, sandboxes)
 * applied to subsets of the 6 canonical roles, never separate hardcoded agents.
 */
export const CANONICAL_MODES = [
  "bugfix",
  "feature",
  "diagnostic",
  "infra",
  "pm",
] as const;

export type CanonicalMissionMode = (typeof CANONICAL_MODES)[number];

/**
 * Extended mission modes including aliases and historical/alternative designations.
 */
export type ExtendedMissionMode =
  | CanonicalMissionMode
  | "debug"
  | "refactor"
  | "review"
  | "post-mortem"
  | "project-management"
  | "exploration";

export type MissionMode = ExtendedMissionMode;

/**
 * Normalization alias dictionary mapping alternative or historical mode names
 * to their authoritative canonical counterpart.
 */
export const MODE_ALIASES: Readonly<Record<string, CanonicalMissionMode>> = {
  debug: "bugfix",
  fix: "bugfix",
  "bug-fix": "bugfix",
  bug_fix: "bugfix",
  refactor: "feature",
  review: "diagnostic",
  "post-mortem": "diagnostic",
  postmortem: "diagnostic",
  post_mortem: "diagnostic",
  "project-management": "pm",
  project_management: "pm",
  projectmanagement: "pm",
};

/**
 * Canonical subset of VisionRoles required for each canonical mission mode.
 *
 * Seed topology from Plan v2:
 * - bugfix / debug (fast patch): [planner, executor, verifier]
 * - feature / refactor: [planner, explorer, executor, reviewer, verifier]
 * - diagnostic / review / post-mortem: [explorer, reviewer] (read-only, root-cause)
 * - infra: [planner, executor, verifier]
 * - pm / project-management: [planner, orchestrator]
 */
export const CANONICAL_ROLE_TOPOLOGIES: Readonly<Record<CanonicalMissionMode, readonly VisionRole[]>> = {
  bugfix: ["planner", "executor", "verifier"],
  feature: ["planner", "explorer", "executor", "reviewer", "verifier"],
  diagnostic: ["explorer", "reviewer"],
  infra: ["planner", "executor", "verifier"],
  pm: ["planner", "orchestrator"],
};

/**
 * Extended topology for non-canonical modes (e.g. exploration).
 */
export const EXTENDED_ROLE_TOPOLOGIES: Readonly<Record<string, readonly VisionRole[]>> = {
  exploration: ["planner", "explorer"],
};

/**
 * Configuration structure applied to the canonical roles during mission routing and dispatch.
 */
export interface ModeConfig {
  [key: string]: unknown;
  /** Authoritative mode identity */
  mode: MissionMode;
  /** Filesystem and tool sandbox model */
  sandbox: "workspace-write" | "read-only";
  /** Human-readable intent and operational summary */
  description: string;
  /** Global prompt overlay injected into all dispatched agents */
  promptOverlay: string;
  /** Role-specific prompt instructions augmenting base agent personas */
  rolePromptOverlays?: Partial<Record<VisionRole, string>>;
  /** Custom external quality gates enforced for this mode */
  extraGates?: OracleGate[];
}

/**
 * Default configurations and prompt overlays per canonical mode.
 */
export const CANONICAL_MODE_CONFIGS: Readonly<Record<CanonicalMissionMode, ModeConfig>> = {
  bugfix: {
    mode: "bugfix",
    sandbox: "workspace-write",
    description: "Fast targeted patch. Reproduce with minimal test, fix root cause, avoid unnecessary refactoring.",
    promptOverlay:
      "Mode: BUGFIX. Prioritize reproducing the issue with a minimal reproduction or test. Implement a targeted fix addressing the root cause with minimal code churn. Do not refactor unrelated code.",
    rolePromptOverlays: {
      planner:
        "Formulate a minimal DAG: (1) localize defect and write reproduction test, (2) apply surgical fix, (3) execute verification gate. Avoid broad scope.",
      executor:
        "Implement surgical bug fixes. Maintain existing interfaces, patterns, and conventions. Do not perform unrequested refactoring.",
      verifier:
        "Strictly verify that the defect reproduction test passes and no existing test suites regress.",
    },
    extraGates: [],
  },
  feature: {
    mode: "feature",
    sandbox: "workspace-write",
    description: "Full feature development. Inspect conventions, plan modular DAG, comprehensive implementation and 2PC review.",
    promptOverlay:
      "Mode: FEATURE. Implement complete, modular functionality adhering to existing codebase architecture, coding standards, and rigorous testing.",
    rolePromptOverlays: {
      planner:
        "Decompose the feature into independent, acyclic work items with explicit quality gates and review checkpoints.",
      explorer:
        "Inspect existing architectural patterns, dependencies, and reusable utilities before implementation.",
      executor:
        "Write clean, idiomatic, well-tested code following repository patterns and conventions.",
      reviewer:
        "Adversarially evaluate proposed changes for design soundness, security invariants, error handling, and test adequacy.",
      verifier:
        "Run full test suite, build verification, and quality oracle requirements.",
    },
    extraGates: [],
  },
  diagnostic: {
    mode: "diagnostic",
    sandbox: "read-only",
    description: "Root-cause investigation and post-mortem analysis. Read-only exploration and review without file mutations.",
    promptOverlay:
      "Mode: DIAGNOSTIC. Strictly read-only investigation. Analyze failure symptoms, trace execution paths, inspect ledger events, and identify root causes without workspace changes.",
    rolePromptOverlays: {
      explorer:
        "Inspect repository files, logs, and git history to identify defect origins and contributing factors read-only.",
      reviewer:
        "Synthesize diagnostic findings into an actionable root-cause diagnosis and recommend concrete remediation steps.",
    },
    extraGates: [],
  },
  infra: {
    mode: "infra",
    sandbox: "workspace-write",
    description: "Infrastructure, CI/CD, build system, and tooling maintenance with strict verification.",
    promptOverlay:
      "Mode: INFRASTRUCTURE. Maintain and update build configuration, CI pipelines, tooling, or environment settings. Verify system stability conservatively.",
    rolePromptOverlays: {
      planner:
        "Structure infrastructure tasks with intermediate validation gates to verify environment health and tool availability.",
      executor:
        "Apply conservative configuration and tooling changes adhering to platform standards.",
      verifier:
        "Execute builds, linters, tool validations, and environment diagnostics to ensure stability.",
    },
    extraGates: [],
  },
  pm: {
    mode: "pm",
    sandbox: "read-only",
    description: "Project management, requirements mediation, milestone roadmapping, and alignment interviews.",
    promptOverlay:
      "Mode: PROJECT MANAGEMENT. Coordinate high-level objectives, mediate user alignment interviews, evaluate progress vectors, and structure milestones without altering code.",
    rolePromptOverlays: {
      planner:
        "Formulate high-level milestones, dependency graphs, and resource estimates.",
      orchestrator:
        "Mediate alignment interviews, synthesize stakeholder intent, and track wave progression across session milestones.",
    },
    extraGates: [],
  },
};

/**
 * Extended mode configs for non-canonical modes.
 */
export const EXTENDED_MODE_CONFIGS: Readonly<Record<string, ModeConfig>> = {
  exploration: {
    mode: "exploration",
    sandbox: "read-only",
    description: "Read-only codebase exploration, architecture discovery, and topology mapping.",
    promptOverlay:
      "Mode: EXPLORATION. Explore and document repository structure, component boundaries, and technology stack without modifying files.",
    rolePromptOverlays: {
      planner:
        "Define targeted exploration paths across repository subsystems and public seams.",
      explorer:
        "Trace module dependencies, map public APIs, and summarize architectural patterns read-only.",
    },
    extraGates: [],
  },
};

/**
 * Normalize any mode string into its authoritative canonical mode identity.
 * Falls back to "feature" if unknown or invalid.
 */
export function normalizeMode(mode: string): MissionMode {
  if (typeof mode !== "string" || !mode.trim()) {
    return "feature";
  }
  const clean = mode.trim().toLowerCase();
  if (Object.hasOwn(MODE_ALIASES, clean)) {
    return MODE_ALIASES[clean];
  }
  if ((CANONICAL_MODES as readonly string[]).includes(clean)) {
    return clean as CanonicalMissionMode;
  }
  if (Object.hasOwn(EXTENDED_ROLE_TOPOLOGIES, clean)) {
    return clean as ExtendedMissionMode;
  }
  return "feature";
}

/**
 * Return the canonical subset of VisionRoles required for a given mission mode.
 * Table-driven, deterministic, and returns a safe fallback for unknown inputs.
 */
export function rolesForMode(mode: MissionMode | string): VisionRole[] {
  if (typeof mode !== "string" || !mode.trim()) {
    return [...CANONICAL_ROLE_TOPOLOGIES.feature];
  }
  const clean = mode.trim().toLowerCase();
  if (Object.hasOwn(EXTENDED_ROLE_TOPOLOGIES, clean)) {
    return [...EXTENDED_ROLE_TOPOLOGIES[clean]];
  }
  const targetMode = Object.hasOwn(MODE_ALIASES, clean)
    ? MODE_ALIASES[clean]
    : clean;
  if (Object.hasOwn(EXTENDED_ROLE_TOPOLOGIES, targetMode)) {
    return [...EXTENDED_ROLE_TOPOLOGIES[targetMode]];
  }
  if (Object.hasOwn(CANONICAL_ROLE_TOPOLOGIES, targetMode)) {
    return [...CANONICAL_ROLE_TOPOLOGIES[targetMode as CanonicalMissionMode]];
  }
  // Safe default: full feature pipeline
  return [...CANONICAL_ROLE_TOPOLOGIES.feature];
}

/**
 * Return the deterministic ModeConfig for a given mission mode,
 * optionally merging custom prompt overlays, extra gates, or sandbox settings.
 */
export function configForMode(
  mode: MissionMode | string,
  overrides?: Partial<ModeConfig>,
): ModeConfig {
  const normalized = normalizeMode(mode);
  const base = Object.hasOwn(EXTENDED_MODE_CONFIGS, normalized)
    ? EXTENDED_MODE_CONFIGS[normalized]
    : Object.hasOwn(CANONICAL_MODE_CONFIGS, normalized)
      ? CANONICAL_MODE_CONFIGS[normalized as CanonicalMissionMode]
      : CANONICAL_MODE_CONFIGS.feature;

  const combinedGates = new Map<string, OracleGate>();
  for (const gate of base.extraGates ?? []) {
    combinedGates.set(gate.id, gate);
  }
  if (Array.isArray(overrides?.extraGates)) {
    for (const gate of overrides.extraGates) {
      combinedGates.set(gate.id, gate);
    }
  }

  return {
    mode: normalized,
    sandbox: overrides?.sandbox ?? base.sandbox,
    description: overrides?.description ?? base.description,
    promptOverlay: overrides?.promptOverlay ?? base.promptOverlay,
    rolePromptOverlays: {
      ...base.rolePromptOverlays,
      ...overrides?.rolePromptOverlays,
    },
    extraGates: Array.from(combinedGates.values()),
  };
}
