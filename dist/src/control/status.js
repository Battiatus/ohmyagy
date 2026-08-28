import { existsSync, readFileSync } from "node:fs";
import { sha256 } from "./canonical.js";
import { currentCheckInputHash, evidenceLogPaths, verifyLedger, } from "./store.js";
export function deriveSnapshot(control) {
    const ledger = verifyLedger(control);
    const accepted = new Set();
    const tasks = [];
    for (const task of control.graph.tasks) {
        const dependenciesAccepted = task.dependencies.every((dependency) => accepted.has(dependency));
        const checks = task.acceptanceChecks.map((check) => {
            const relevant = ledger.events.filter((event) => event.taskId === task.id && event.checkId === check.id);
            const latest = relevant.at(-1);
            if (!latest) {
                return { id: check.id, status: "missing" };
            }
            const validEvidence = ledger.valid &&
                latest.contractHash === control.contractHash &&
                latest.graphHash === control.graphHash &&
                latest.stableInputs &&
                logsMatch(control, latest);
            if (!validEvidence) {
                return {
                    id: check.id,
                    status: "stale",
                    evidenceHash: latest.entryHash,
                };
            }
            const currentInputHash = currentCheckInputHash(control, check);
            if (latest.inputHashAfter !== currentInputHash) {
                return {
                    id: check.id,
                    status: "stale",
                    evidenceHash: latest.entryHash,
                };
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
        tasks.push({
            id: task.id,
            title: task.title,
            status,
            dependencies: task.dependencies,
            checks,
        });
    }
    return {
        contractHash: control.contractHash,
        graphHash: control.graphHash,
        ledgerValid: ledger.valid,
        ledgerErrors: ledger.errors,
        ledgerHead: ledger.headHash,
        tasks,
    };
}
function deriveTaskStatus(task, dependenciesAccepted, checks) {
    if (!dependenciesAccepted) {
        return "blocked";
    }
    if (task.acceptanceChecks.length === 0) {
        return "ready";
    }
    if (checks.every((check) => check.status === "passed")) {
        return "accepted";
    }
    if (checks.some((check) => check.status === "failed" || check.status === "stale")) {
        return "needs_work";
    }
    return "ready";
}
function logsMatch(control, event) {
    const paths = evidenceLogPaths(control, event);
    if (!existsSync(paths.stdout) || !existsSync(paths.stderr)) {
        return false;
    }
    return (sha256(readFileSync(paths.stdout)) === event.result.stdoutHash &&
        sha256(readFileSync(paths.stderr)) === event.result.stderrHash);
}
export function nextRunnableTask(snapshot) {
    return snapshot.tasks.find((task) => task.status === "ready" || task.status === "needs_work");
}
