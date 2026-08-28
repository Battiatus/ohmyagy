import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../control/model.js";
import { startAuthorityServer } from "../../ledger/client.js";
import { reconstructAuthorityHandoff } from "../reconstruct.js";
test("a fresh CLI process ignores a forged local ledger and narrative", async () => {
    const fixture = createFixture();
    try {
        const client = await startAuthorityServer(fixture);
        await client.runCheck("TASK-001", "first");
        const second = await client.runCheck("TASK-002", "second");
        const pin = {
            authorityId: client.authorityId,
            entries: second.sequence,
            headHash: second.entryHash,
        };
        await client.shutdown();
        writeFileSync(fixture.pinPath, `${JSON.stringify(pin, null, 2)}\n`, "utf8");
        writeFileSync(join(fixture.workspaceRoot, ".oma", "control", "ledger.jsonl"), "agent says done\n", "utf8");
        writeFileSync(fixture.missionPath, `${JSON.stringify({ fake: "narrative" })}\n`, "utf8");
        const run = runAuthorityHandoff(fixture);
        assert.equal(run.status, 0, run.stderr);
        const handoff = JSON.parse(run.stdout);
        assert.ok(isRecord(handoff));
        assert.equal(handoff.ledgerValid, true);
        assert.ok(Array.isArray(handoff.tasks));
        assert.deepEqual(handoff.tasks.map((task) => (isRecord(task) ? [task.id, task.status] : null)), [
            ["TASK-001", "accepted"],
            ["TASK-002", "accepted"],
        ]);
        assert.ok(isRecord(handoff.bootstrapTrust));
        assert.equal(handoff.bootstrapTrust.mode, "signed-authority");
    }
    finally {
        rmSync(fixture.container, { recursive: true, force: true });
    }
});
test("changing a tracked input makes evidence stale and blocks dependants", async () => {
    const fixture = createFixture();
    try {
        const client = await startAuthorityServer(fixture);
        await client.runCheck("TASK-001", "first");
        const second = await client.runCheck("TASK-002", "second");
        const pin = {
            authorityId: client.authorityId,
            entries: second.sequence,
            headHash: second.entryHash,
        };
        await client.shutdown();
        writeFileSync(join(fixture.workspaceRoot, "tracked.txt"), "changed", "utf8");
        const handoff = reconstructAuthorityHandoff(fixture.workspaceRoot, fixture.stateDir, pin);
        assert.equal(handoff.tasks[0]?.status, "needs_work");
        assert.equal(handoff.tasks[0]?.checks[0]?.status, "stale");
        assert.equal(handoff.tasks[1]?.status, "blocked");
        assert.equal(handoff.nextTask?.id, "TASK-001");
    }
    finally {
        rmSync(fixture.container, { recursive: true, force: true });
    }
});
test("corrupt authority state makes handoff fail closed", async () => {
    const fixture = createFixture();
    try {
        const client = await startAuthorityServer(fixture);
        const event = await client.runCheck("TASK-001", "first");
        const pin = {
            authorityId: client.authorityId,
            entries: event.sequence,
            headHash: event.entryHash,
        };
        await client.shutdown();
        writeFileSync(fixture.pinPath, `${JSON.stringify(pin, null, 2)}\n`, "utf8");
        writeFileSync(join(fixture.stateDir, "ledger.jsonl"), "{}\n", "utf8");
        const run = runAuthorityHandoff(fixture);
        assert.equal(run.status, 1);
        const handoff = JSON.parse(run.stdout);
        assert.ok(isRecord(handoff));
        assert.equal(handoff.ledgerValid, false);
    }
    finally {
        rmSync(fixture.container, { recursive: true, force: true });
    }
});
function createFixture() {
    const container = mkdtempSync(join(tmpdir(), "oma-resume-test-"));
    const workspaceRoot = join(container, "workspace");
    const stateDir = join(container, "authority-state");
    const pinDir = join(container, "trusted-pin");
    mkdirSync(join(workspaceRoot, ".oma", "control"), { recursive: true });
    mkdirSync(pinDir);
    writeFileSync(join(workspaceRoot, "tracked.txt"), "stable", "utf8");
    const missionPath = join(workspaceRoot, ".oma", "control", "mission.json");
    const graphPath = join(workspaceRoot, ".oma", "control", "task-graph.json");
    const pinPath = join(pinDir, "authority-pin.json");
    const mission = {
        schemaVersion: 1,
        missionId: "resume-fixture",
        status: "ready",
        executionGate: "allowed",
        problem: "Narrative state is not authority.",
        goal: "Reconstruct from signed evidence only.",
        scope: ["resume"],
        nonGoals: ["installation"],
        acceptanceCriteria: [{ id: "AC-1", description: "Fresh process reconstructs status." }],
        dependencies: [],
        targetEnvironment: "test",
        maxIterationRounds: 2,
        authorizedBy: "test-fixture",
    };
    const check = (id) => ({
        id,
        program: process.execPath,
        args: ["-e", `process.stdout.write('${id}')`],
        cwd: ".",
        trackedPaths: ["tracked.txt"],
    });
    const graph = {
        schemaVersion: 1,
        missionId: "resume-fixture",
        tasks: [
            {
                id: "TASK-001",
                title: "First",
                dependencies: [],
                scope: ["tracked.txt"],
                acceptanceChecks: [check("first")],
            },
            {
                id: "TASK-002",
                title: "Second",
                dependencies: ["TASK-001"],
                scope: ["tracked.txt"],
                acceptanceChecks: [check("second")],
            },
        ],
    };
    writeFileSync(missionPath, `${JSON.stringify(mission, null, 2)}\n`, "utf8");
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    return { container, workspaceRoot, stateDir, missionPath, graphPath, pinPath };
}
function runAuthorityHandoff(fixture) {
    const processPath = fileURLToPath(new URL("../handoff-process.js", import.meta.url));
    return spawnSync(process.execPath, [processPath], {
        cwd: fixture.workspaceRoot,
        encoding: "utf8",
        windowsHide: true,
        env: {
            ...process.env,
            OMA_AUTHORITY_STATE_DIR: fixture.stateDir,
            OMA_AUTHORITY_PIN_PATH: fixture.pinPath,
        },
    });
}
