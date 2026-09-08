import { isRecord } from "../ledger/canonical.js";
import {
  type ModeConfig,
  type MissionMode,
  configForMode,
  normalizeMode,
  rolesForMode,
} from "../runtime/mode-router.js";
import type { VisionRole } from "../runtime/capability-resolver.js";
import type { OracleGate } from "../oracle/executor.js";

/**
 * MCP tool surface for mission mode routing.
 *
 * Exposes the plan_route tool to allow active sessions or skills to determine
 * the required subset of the 6 canonical roles and configuration overlays
 * for a specific mission mode.
 */

export const ROUTING_TOOL_NAMES = new Set(["plan_route"]);

export const ROUTING_SUCCESS_STATUSES = new Set(["routed"]);

export const ROUTING_TOOL_DEFINITIONS = [
  {
    name: "plan_route",
    description:
      "Select the canonical subset of roles and configuration overlay (prompt overlay, sandbox, extra gates) appropriate for a requested mission mode (canonical: bugfix, feature, diagnostic, infra, pm; also accepts debug, refactor, review, project-management, exploration).",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description:
            "Mission mode (canonical: bugfix, feature, diagnostic, infra, pm; also accepts aliases debug, refactor, review, project-management, exploration).",
        },
        extraGates: {
          type: "array",
          description: "Optional custom quality gates to append to the mode configuration.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              program: { type: "string" },
              args: { type: "array", items: { type: "string" } },
              timeoutMs: { type: "number" },
            },
            required: ["id", "program"],
          },
        },
        promptOverlay: {
          type: "string",
          description: "Optional custom prompt overlay override.",
        },
      },
      required: ["mode"],
    },
  },
];

export interface PlanRouteOutput {
  [key: string]: unknown;
  status: "routed";
  mode: MissionMode;
  requestedMode: string;
  roles: VisionRole[];
  modeConfig: ModeConfig;
}

export function executeRoutingTool(
  toolName: string,
  input: unknown,
): Record<string, unknown> {
  if (toolName !== "plan_route") {
    throw new Error(`Unknown routing tool: ${toolName}`);
  }
  return executePlanRoute(input);
}

export function executePlanRoute(input: unknown): PlanRouteOutput {
  if (!isRecord(input) || typeof input.mode !== "string" || !input.mode.trim()) {
    throw new Error("plan_route requires a non-empty 'mode' string.");
  }

  const requestedMode = input.mode.trim();
  const canonicalMode = normalizeMode(requestedMode);
  const roles = rolesForMode(requestedMode);

  let overrides: Partial<ModeConfig> | undefined;
  if (typeof input.promptOverlay === "string" || Array.isArray(input.extraGates)) {
    overrides = {
      ...(typeof input.promptOverlay === "string" ? { promptOverlay: input.promptOverlay } : {}),
      ...(Array.isArray(input.extraGates) ? { extraGates: input.extraGates as OracleGate[] } : {}),
    };
  }

  const modeConfig = configForMode(requestedMode, overrides);

  return {
    status: "routed",
    mode: canonicalMode,
    requestedMode,
    roles,
    modeConfig,
  };
}
