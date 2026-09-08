import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MissionEventsStore } from "../ledger/mission-events.js";
import { MissionProjectionEngine } from "../graph/mission-projections.js";

export type MissionProjection = ReturnType<typeof MissionProjectionEngine.project>;
type MissionRun = MissionProjection["workGraph"]["runs"][string];

export interface MissionListEntry {
  missionId: string;
  status: MissionProjection["status"];
  currentWave: number;
  modifiedAt: number;
}

export interface MissionStatusSummary {
  missionId: string;
  missionStatus: MissionProjection["status"];
  phase: string;
  currentWave: number;
  activeRuns: string[];
  ready: string[];
  running: string[];
  accepted: string[];
  progress: MissionProjection["progress"];
  terminalVerdict: MissionProjection["provenance"]["terminalVerdict"] | null;
}

export function missionsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".oma", "missions");
}

export function eventsPathFor(workspaceRoot: string, missionId: string): string {
  return join(missionsDir(workspaceRoot), missionId, "events.jsonl");
}

export function ensureMissionStarted(workspaceRoot: string, missionId: string, goal?: string): string {
  const eventsPath = eventsPathFor(workspaceRoot, missionId);
  let hasStarted = false;
  if (existsSync(eventsPath)) {
    try {
      const existing = MissionEventsStore.readEvents(eventsPath);
      hasStarted = existing.some((e) => e.type === "mission_started");
    } catch {}
  }
  if (!hasStarted) {
    MissionEventsStore.appendEvent(eventsPath, missionId, {
      type: "mission_started",
      workflowDigest: "session-native-graph-workflow-v2",
      rulebookRevision: "session-native-v2",
      goal: goal ?? `Session-native mission ${missionId}`,
      totalBudgets: { maxRounds: 5, maxTimeMs: 300_000 },
    });
  }
  return eventsPath;
}

/** Project a single mission from its durable journal. Throws when the mission is unknown. */
export function loadMissionProjection(workspaceRoot: string, missionId: string): MissionProjection {
  const eventsPath = eventsPathFor(workspaceRoot, missionId);
  if (!existsSync(eventsPath)) {
    throw new Error(`Mission '${missionId}' was not found.`);
  }
  return MissionProjectionEngine.project(MissionEventsStore.readEvents(eventsPath));
}

/** List every mission with a readable journal, most recently modified first. */
export function listMissions(workspaceRoot: string): MissionListEntry[] {
  const dir = missionsDir(workspaceRoot);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).flatMap((missionId): MissionListEntry[] => {
    const eventsPath = eventsPathFor(workspaceRoot, missionId);
    if (!existsSync(eventsPath)) return [];
    try {
      const projection = MissionProjectionEngine.project(MissionEventsStore.readEvents(eventsPath));
      return [
        {
          missionId,
          status: projection.status,
          currentWave: projection.currentWave,
          modifiedAt: statSync(eventsPath).mtimeMs,
        },
      ];
    } catch {
      return [];
    }
  });
  entries.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return entries;
}

/** The most recently touched in-progress mission, if any. */
export function findActiveMissionId(workspaceRoot: string): string | undefined {
  // 1. Session-native run actively recorded in .oma/graph/ takes precedence
  try {
    const sessionMissionIdFile = join(workspaceRoot, ".oma", "graph", "session-mission-id");
    let sessionMissionId: string | undefined;
    if (existsSync(sessionMissionIdFile)) {
      const content = readFileSync(sessionMissionIdFile, "utf8").trim();
      if (content.length > 0) {
        sessionMissionId = content;
      }
    }
    if (!sessionMissionId) {
      const graphDefPath = join(workspaceRoot, ".oma", "graph", "execution-graph.json");
      if (existsSync(graphDefPath)) {
        const raw = JSON.parse(readFileSync(graphDefPath, "utf8")) as { graphId?: string };
        if (typeof raw?.graphId === "string" && raw.graphId.startsWith("graph-")) {
          sessionMissionId = raw.graphId.slice(6);
        }
      }
    }

    if (sessionMissionId) {
      const eventsPath = eventsPathFor(workspaceRoot, sessionMissionId);
      if (existsSync(eventsPath)) {
        const projection = MissionProjectionEngine.project(MissionEventsStore.readEvents(eventsPath));
        if (projection.status === "in_progress") {
          return sessionMissionId;
        }
      }
    }
  } catch {
    // Fail-open on filesystem or parse errors
  }

  // 2. Discover most recently modified in-progress mission from .oma/missions/
  return listMissions(workspaceRoot).find((entry) => entry.status === "in_progress")?.missionId;
}

/** A compact, JSON-friendly status summary shared by the CLI and the MCP broker. */
export function summarizeMission(missionId: string, projection: MissionProjection): MissionStatusSummary {
  const activeRuns = Object.values(projection.workGraph.runs).filter((run) => run.status === "running");
  return {
    missionId,
    missionStatus: projection.status,
    phase: missionPhase(projection, activeRuns),
    currentWave: projection.currentWave,
    activeRuns: activeRuns.map((run) => `${run.workItemId}:${run.expertId}`),
    ready: projection.workGraph.readySet,
    running: projection.workGraph.runningSet,
    accepted: projection.workGraph.acceptedSet,
    progress: projection.progress,
    terminalVerdict: projection.provenance.terminalVerdict ?? null,
  };
}

export function missionPhase(projection: MissionProjection, activeRuns: MissionRun[]): string {
  if (projection.status !== "in_progress") return "TERMINAL";
  if (activeRuns.some((run) => run.workItemId === "planner")) return "PLANNING";
  if (projection.progress.totalWorkItems === 0) return "INITIALIZING";
  if (activeRuns.length > 0) return "EXECUTING";
  if (projection.workGraph.readySet.length > 0) return "READY";
  return "VERIFYING";
}
