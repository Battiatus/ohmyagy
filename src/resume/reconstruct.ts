import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { hashTrackedPaths } from "../control/canonical.js";
import {
  type ControlSnapshot,
  type DerivedTaskStatus,
  type MissionTask,
  isRecord,
  parseMissionContract,
  parseTaskGraph,
} from "../control/model.js";
import { nextRunnableTask } from "../control/status.js";
import type { PinnedAuthorityHead } from "../ledger/model.js";
import { verifySignedLedger } from "../ledger/verify.js";

export interface AuthorityHandoff {
  mission: { id: string; status: string; executionGate: string; goal: string };
  authorityId: string;
  contractHash: string;
  graphHash: string;
  ledgerValid: boolean;
  ledgerErrors: string[];
  ledgerHead: string;
  pinnedHead: PinnedAuthorityHead;
  tasks: DerivedTaskStatus[];
  nextTask: DerivedTaskStatus | null;
  bootstrapTrust: {
    mode: "signed-authority";
    limitation: string;
  };
}

export function reconstructAuthorityHandoff(
  workspaceRoot: string,
  stateDir: string,
  pin: PinnedAuthorityHead,
): AuthorityHandoff {
  const workspace = resolve(workspaceRoot);
  const authorityState = resolve(stateDir);
  assertOutsideWorkspace(workspace, authorityState, "authority state");
  const mission = parseMissionContract(readJson(resolve(authorityState, "mission.json")));
  const graph = parseTaskGraph(readJson(resolve(authorityState, "task-graph.json")));
  if (mission.missionId !== graph.missionId) {
    throw new Error("Frozen mission and task graph do not match");
  }
  const verification = verifySignedLedger(authorityState, pin.authorityId, pin);
  const metadata = verification.metadata;
  if (!metadata) {
    throw new Error(`Authority metadata unavailable: ${verification.errors.join("; ")}`);
  }
  const snapshot = deriveAuthoritySnapshot(
    workspace,
    graph.tasks,
    metadata.contractHash,
    metadata.graphHash,
    verification,
  );
  return {
    mission: {
      id: mission.missionId,
      status: mission.status,
      executionGate: mission.executionGate,
      goal: mission.goal,
    },
    authorityId: metadata.authorityId,
    contractHash: snapshot.contractHash,
    graphHash: snapshot.graphHash,
    ledgerValid: snapshot.ledgerValid,
    ledgerErrors: snapshot.ledgerErrors,
    ledgerHead: snapshot.ledgerHead,
    pinnedHead: pin,
    tasks: snapshot.tasks,
    nextTask: nextRunnableTask(snapshot) ?? null,
    bootstrapTrust: {
      mode: "signed-authority",
      limitation:
        "Trust requires the launcher-protected authority pin and the separate broker process identity.",
    },
  };
}

export function authorityHandoffFromEnvironment(
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): AuthorityHandoff {
  const stateDir = environment.OMA_AUTHORITY_STATE_DIR;
  const pinPath = environment.OMA_AUTHORITY_PIN_PATH;
  if (!stateDir || !pinPath) {
    throw new Error(
      "OMA_AUTHORITY_STATE_DIR and OMA_AUTHORITY_PIN_PATH are required for signed handoff.",
    );
  }
  const workspace = resolve(workspaceRoot);
  const resolvedState = resolve(stateDir);
  const resolvedPin = resolve(pinPath);
  assertOutsideWorkspace(workspace, resolvedState, "authority state");
  assertOutsideWorkspace(workspace, resolvedPin, "authority pin");
  const fromState = relative(resolvedState, resolvedPin);
  if (fromState.length === 0 || (!fromState.startsWith("..") && !isAbsolute(fromState))) {
    throw new Error("Authority pin must be stored outside the mutable authority state directory.");
  }
  return reconstructAuthorityHandoff(workspace, resolvedState, parsePin(readJson(resolvedPin)));
}

function deriveAuthoritySnapshot(
  workspaceRoot: string,
  tasks: MissionTask[],
  contractHash: string,
  graphHash: string,
  verification: ReturnType<typeof verifySignedLedger>,
): ControlSnapshot {
  const accepted = new Set<string>();
  const derived: DerivedTaskStatus[] = [];
  for (const task of tasks) {
    const dependenciesAccepted = task.dependencies.every((id) => accepted.has(id));
    const checks: DerivedTaskStatus["checks"] = task.acceptanceChecks.map((check) => {
      const latest = verification.events
        .filter((event) => event.taskId === task.id && event.checkId === check.id)
        .at(-1);
      if (!latest) {
        return { id: check.id, status: "missing" };
      }
      const fresh =
        verification.valid &&
        latest.contractHash === contractHash &&
        latest.graphHash === graphHash &&
        latest.stableInputs &&
        latest.inputHashAfter === hashTrackedPaths(workspaceRoot, check.trackedPaths);
      if (!fresh) {
        return { id: check.id, status: "stale", evidenceHash: latest.entryHash };
      }
      return {
        id: check.id,
        status: latest.result.exitCode === 0 ? "passed" : "failed",
        evidenceHash: latest.entryHash,
      };
    });
    const status = deriveTaskStatus(task, dependenciesAccepted, checks);
    if (status === "accepted") {
      accepted.add(task.id);
    }
    derived.push({
      id: task.id,
      title: task.title,
      status,
      dependencies: task.dependencies,
      checks,
    });
  }
  return {
    contractHash,
    graphHash,
    ledgerValid: verification.valid,
    ledgerErrors: verification.errors,
    ledgerHead: verification.head.headHash,
    tasks: derived,
  };
}

function deriveTaskStatus(
  task: MissionTask,
  dependenciesAccepted: boolean,
  checks: DerivedTaskStatus["checks"],
): DerivedTaskStatus["status"] {
  if (!dependenciesAccepted) return "blocked";
  if (task.acceptanceChecks.length === 0) return "ready";
  if (checks.every((check) => check.status === "passed")) return "accepted";
  if (checks.some((check) => check.status === "failed" || check.status === "stale")) {
    return "needs_work";
  }
  return "ready";
}

function parsePin(input: unknown): PinnedAuthorityHead {
  if (
    !isRecord(input) ||
    typeof input.authorityId !== "string" ||
    !Number.isInteger(input.entries) ||
    typeof input.headHash !== "string"
  ) {
    throw new Error("Malformed authority pin");
  }
  const expected = new Set(["authorityId", "entries", "headHash"]);
  if (Object.keys(input).some((key) => !expected.has(key))) {
    throw new Error("Authority pin contains unexpected fields");
  }
  return {
    authorityId: input.authorityId,
    entries: Number(input.entries),
    headHash: input.headHash,
  };
}

function assertOutsideWorkspace(workspace: string, target: string, label: string): void {
  const fromWorkspace = relative(workspace, target);
  if (fromWorkspace.length === 0 || (!fromWorkspace.startsWith("..") && !isAbsolute(fromWorkspace))) {
    throw new Error(`${label} must be outside the agent workspace`);
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
