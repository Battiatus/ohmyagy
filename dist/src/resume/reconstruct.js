import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { hashTrackedPaths } from "../control/canonical.js";
import { isRecord, parseMissionContract, parseTaskGraph, } from "../control/model.js";
import { nextRunnableTask } from "../control/status.js";
import { verifySignedLedger } from "../ledger/verify.js";
export function reconstructAuthorityHandoff(workspaceRoot, stateDir, pin) {
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
    const snapshot = deriveAuthoritySnapshot(workspace, graph.tasks, metadata.contractHash, metadata.graphHash, verification);
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
            limitation: "Trust requires the launcher-protected authority pin and the separate broker process identity.",
        },
    };
}
export function authorityHandoffFromEnvironment(workspaceRoot, environment = process.env) {
    const stateDir = environment.OMA_AUTHORITY_STATE_DIR;
    const pinPath = environment.OMA_AUTHORITY_PIN_PATH;
    if (!stateDir || !pinPath) {
        throw new Error("OMA_AUTHORITY_STATE_DIR and OMA_AUTHORITY_PIN_PATH are required for signed handoff.");
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
function deriveAuthoritySnapshot(workspaceRoot, tasks, contractHash, graphHash, verification) {
    const accepted = new Set();
    const derived = [];
    for (const task of tasks) {
        const dependenciesAccepted = task.dependencies.every((id) => accepted.has(id));
        const checks = task.acceptanceChecks.map((check) => {
            const latest = verification.events
                .filter((event) => event.taskId === task.id && event.checkId === check.id)
                .at(-1);
            if (!latest) {
                return { id: check.id, status: "missing" };
            }
            const fresh = verification.valid &&
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
function deriveTaskStatus(task, dependenciesAccepted, checks) {
    if (!dependenciesAccepted)
        return "blocked";
    if (task.acceptanceChecks.length === 0)
        return "ready";
    if (checks.every((check) => check.status === "passed"))
        return "accepted";
    if (checks.some((check) => check.status === "failed" || check.status === "stale")) {
        return "needs_work";
    }
    return "ready";
}
function parsePin(input) {
    if (!isRecord(input) ||
        typeof input.authorityId !== "string" ||
        !Number.isInteger(input.entries) ||
        typeof input.headHash !== "string") {
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
function assertOutsideWorkspace(workspace, target, label) {
    const fromWorkspace = relative(workspace, target);
    if (fromWorkspace.length === 0 || (!fromWorkspace.startsWith("..") && !isAbsolute(fromWorkspace))) {
        throw new Error(`${label} must be outside the agent workspace`);
    }
}
function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}
