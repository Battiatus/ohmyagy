import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";
export class MissionEventsStore {
    static appendEvent(eventsFilePath, missionId, payload) {
        const dir = dirname(eventsFilePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        const existing = this.readEvents(eventsFilePath);
        const seq = existing.length + 1;
        const previousEventHash = existing.length > 0
            ? existing[existing.length - 1].eventHash
            : "0".repeat(64);
        const timestamp = new Date().toISOString();
        const eventWithoutHash = {
            seq,
            timestamp,
            missionId,
            previousEventHash,
            ...payload,
        };
        const eventHash = sha256(canonicalJson(eventWithoutHash));
        const fullEvent = {
            ...eventWithoutHash,
            eventHash,
        };
        appendFileSync(eventsFilePath, `${JSON.stringify(fullEvent)}\n`, "utf8");
        return fullEvent;
    }
    static readEvents(eventsFilePath) {
        if (!existsSync(eventsFilePath))
            return [];
        const content = readFileSync(eventsFilePath, "utf8");
        const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
        return lines.map((l) => JSON.parse(l));
    }
    static verifyEventChain(events) {
        let prevHash = "0".repeat(64);
        for (let i = 0; i < events.length; i++) {
            const event = events[i];
            if (event.seq !== i + 1) {
                return { valid: false, error: `Sequence discontinuity at index ${i}: expected seq ${i + 1}, got ${event.seq}` };
            }
            if (event.previousEventHash !== prevHash) {
                return { valid: false, error: `Hash chain mismatch at seq ${event.seq}` };
            }
            const { eventHash, ...data } = event;
            const computedHash = sha256(canonicalJson(data));
            if (computedHash !== eventHash) {
                return { valid: false, error: `Invalid event payload hash at seq ${event.seq}` };
            }
            prevHash = eventHash;
        }
        return { valid: true };
    }
    static projectMission(events) {
        const workItems = new Map();
        const runs = new Map();
        let missionId = "unknown";
        let status = "in_progress";
        let currentWave = 1;
        let progress = {
            hiddenTestsFailing: 0,
            hiddenTestsPassed: 0,
            visibleTestsFailing: 0,
            visibleTestsPassed: 0,
            gateFailures: 0,
            openDiagnosticsCount: 0,
            acceptedWorkItems: 0,
            totalWorkItems: 0,
        };
        let lastEventHash = "0".repeat(64);
        for (const e of events) {
            lastEventHash = e.eventHash;
            missionId = e.missionId;
            switch (e.type) {
                case "mission_started":
                    status = "in_progress";
                    break;
                case "work_item_discovered":
                    workItems.set(e.workItemId, {
                        id: e.workItemId,
                        title: e.title,
                        scope: e.scope,
                        dependsOn: e.dependsOn,
                        state: "pending",
                        runs: [],
                        reviews: [],
                    });
                    progress.totalWorkItems = workItems.size;
                    break;
                case "run_started":
                    runs.set(e.runId, { id: e.runId, workItemId: e.workItemId, expertId: e.expertId, status: "running" });
                    const item = workItems.get(e.workItemId);
                    if (item) {
                        item.state = "running";
                        item.activeRunId = e.runId;
                        item.runs.push(e.runId);
                    }
                    break;
                case "artifact_created":
                    if (e.artifactKind === "diff") {
                        const wi = workItems.get(e.workItemId);
                        if (wi)
                            wi.diffDigest = e.artifactHash;
                    }
                    break;
                case "run_finished":
                    const run = runs.get(e.runId);
                    if (run)
                        run.status = e.status;
                    const targetWi = workItems.get(e.workItemId);
                    if (targetWi && targetWi.activeRunId === e.runId) {
                        if (e.status === "succeeded") {
                            targetWi.state = "reviewed"; // Pending review attestation
                        }
                        else {
                            targetWi.state = "failed";
                        }
                    }
                    break;
                case "review_attested":
                    const reviewedWi = workItems.get(e.workItemId);
                    if (reviewedWi) {
                        reviewedWi.reviews.push({ reviewer: e.reviewerExpertId, verdict: e.verdict });
                        if (e.verdict === "approved" && reviewedWi.reviews.filter((r) => r.verdict === "approved").length >= 2) {
                            reviewedWi.state = "accepted";
                        }
                    }
                    break;
                case "gate_evaluated":
                    progress = e.progressVector;
                    break;
                case "wave_transitioned":
                    currentWave = e.toWave;
                    break;
                case "integration_attempted":
                    if (e.status === "integrated") {
                        progress.acceptedWorkItems = e.workItemsIntegrated.length;
                    }
                    else if (e.status === "conflict_blocked") {
                        status = "blocked";
                    }
                    break;
                case "mission_finished":
                    status = e.finalStatus === "succeeded" ? "succeeded" : "failed";
                    progress = e.finalProgress;
                    break;
            }
        }
        return {
            missionId,
            status,
            currentWave,
            workItems,
            runs,
            progress,
            eventCount: events.length,
            lastEventHash,
        };
    }
}
/**
 * Deterministic ID Generators
 */
export function generateDeterministicRunId(workItemId, expertId, seq) {
    return `run-${workItemId}-${expertId}-${String(seq).padStart(2, "0")}`;
}
export function generateDeterministicWorkItemId(scopeId) {
    return `work-${scopeId.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()}`;
}
