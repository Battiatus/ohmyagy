import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { canonicalJson, sha256 } from "../../control/canonical.js";
import { isRecord } from "../../control/model.js";
import { startAuthorityServer } from "../client.js";
import { parseSignedEvidence, signedEventHashInput, verifySignedLedger, } from "../verify.js";
test("keeps the signing key in a separate process and writes authority state outside workspace", async () => {
    const fixture = createFixture();
    try {
        const client = await startAuthorityServer(fixture);
        const event = await client.runCheck("TASK-001", "pass");
        const pinned = pin(client.authorityId, event.sequence, event.entryHash);
        const verification = verifySignedLedger(fixture.stateDir, client.authorityId, pinned);
        assert.equal(event.result.exitCode, 0);
        assert.equal(verification.valid, true, verification.errors.join("; "));
        assert.equal(verification.events.length, 1);
        assert.equal(isOutside(fixture.workspaceRoot, fixture.stateDir), true);
        const files = listFiles(fixture.stateDir);
        assert.equal(files.some((path) => /private|secret|\.key$/iu.test(path)), false);
        const combined = files
            .map((path) => readFileSync(join(fixture.stateDir, path), "utf8"))
            .join("\n");
        assert.equal(combined.includes("PRIVATE KEY"), false);
        await client.shutdown();
    }
    finally {
        rmSync(fixture.container, { recursive: true, force: true });
    }
});
test("rejects arbitrary append methods and unregistered checks without appending", async () => {
    const fixture = createFixture();
    try {
        const client = await startAuthorityServer(fixture);
        await assert.rejects(client.request("append", { verdict: "agent-says-pass" }), /Unsupported authority method/u);
        await assert.rejects(client.runCheck("TASK-001", "not-registered"), /not registered in frozen graph/u);
        const verification = verifySignedLedger(fixture.stateDir, client.authorityId);
        assert.equal(verification.valid, true, verification.errors.join("; "));
        assert.equal(verification.events.length, 0);
        await client.shutdown();
    }
    finally {
        rmSync(fixture.container, { recursive: true, force: true });
    }
});
test("detects a recomputed event hash when the attacker cannot forge the signature", async () => {
    const fixture = createFixture();
    try {
        const client = await startAuthorityServer(fixture);
        await client.runCheck("TASK-001", "pass");
        const authorityId = client.authorityId;
        await client.shutdown();
        const ledgerPath = join(fixture.stateDir, "ledger.jsonl");
        const event = parseSignedEvidence(JSON.parse(readFileSync(ledgerPath, "utf8")));
        const { entryHash: oldHash, signature, ...unsigned } = event;
        void oldHash;
        const forgedUnsigned = {
            ...unsigned,
            result: { ...unsigned.result, exitCode: 91 },
        };
        const forgedHash = sha256(signedEventHashInput(forgedUnsigned));
        writeFileSync(ledgerPath, `${canonicalJson({ ...forgedUnsigned, entryHash: forgedHash, signature })}\n`, "utf8");
        writeFileSync(join(fixture.stateDir, "head.json"), `${JSON.stringify({ entries: 1, headHash: forgedHash }, null, 2)}\n`, "utf8");
        const verification = verifySignedLedger(fixture.stateDir, authorityId);
        assert.equal(verification.valid, false);
        assert.match(verification.errors.join("; "), /Invalid signature/u);
    }
    finally {
        rmSync(fixture.container, { recursive: true, force: true });
    }
});
test("detects ledger truncation against an externally pinned head", async () => {
    const fixture = createFixture();
    try {
        const client = await startAuthorityServer(fixture);
        const first = await client.runCheck("TASK-001", "pass");
        const second = await client.runCheck("TASK-001", "pass");
        const authorityId = client.authorityId;
        const pinned = pin(authorityId, second.sequence, second.entryHash);
        await client.shutdown();
        const ledgerPath = join(fixture.stateDir, "ledger.jsonl");
        const firstLine = readFileSync(ledgerPath, "utf8").split(/\r?\n/u)[0];
        assert.ok(firstLine);
        writeFileSync(ledgerPath, `${firstLine}\n`, "utf8");
        writeFileSync(join(fixture.stateDir, "head.json"), `${JSON.stringify({ entries: 1, headHash: first.entryHash }, null, 2)}\n`, "utf8");
        const verification = verifySignedLedger(fixture.stateDir, authorityId, pinned);
        assert.equal(verification.valid, false);
        assert.match(verification.errors.join("; "), /rollback detected/u);
    }
    finally {
        rmSync(fixture.container, { recursive: true, force: true });
    }
});
test("rejects unsigned hidden fields instead of silently ignoring them", async () => {
    const fixture = createFixture();
    try {
        const client = await startAuthorityServer(fixture);
        await client.runCheck("TASK-001", "pass");
        const authorityId = client.authorityId;
        await client.shutdown();
        const ledgerPath = join(fixture.stateDir, "ledger.jsonl");
        const raw = JSON.parse(readFileSync(ledgerPath, "utf8"));
        assert.ok(isRecord(raw));
        const injected = { ...raw, agentVerdict: "pass" };
        writeFileSync(ledgerPath, `${JSON.stringify(injected)}\n`, "utf8");
        const verification = verifySignedLedger(fixture.stateDir, authorityId);
        assert.equal(verification.valid, false);
        assert.match(verification.errors.join("; "), /unexpected=\[agentVerdict\]/u);
    }
    finally {
        rmSync(fixture.container, { recursive: true, force: true });
    }
});
function createFixture() {
    const container = mkdtempSync(join(tmpdir(), "oma-authority-test-"));
    const workspaceRoot = join(container, "workspace");
    const stateDir = join(container, "authority-state");
    mkdirSync(join(workspaceRoot, ".oma", "control"), { recursive: true });
    writeFileSync(join(workspaceRoot, "tracked.txt"), "stable", "utf8");
    const missionPath = join(workspaceRoot, ".oma", "control", "mission.json");
    const graphPath = join(workspaceRoot, ".oma", "control", "task-graph.json");
    const mission = {
        schemaVersion: 1,
        missionId: "authority-fixture",
        status: "ready",
        executionGate: "allowed",
        problem: "Agent-authored claims are not authority.",
        goal: "Run frozen checks in a separate signing process.",
        scope: ["signed evidence"],
        nonGoals: ["production service installation"],
        acceptanceCriteria: [{ id: "AC-1", description: "A registered check is signed." }],
        dependencies: [],
        targetEnvironment: "test",
        maxIterationRounds: 2,
        authorizedBy: "test-fixture",
    };
    const graph = {
        schemaVersion: 1,
        missionId: "authority-fixture",
        tasks: [
            {
                id: "TASK-001",
                title: "Signed check",
                dependencies: [],
                scope: ["tracked.txt"],
                acceptanceChecks: [
                    {
                        id: "pass",
                        program: process.execPath,
                        args: ["-e", "process.stdout.write('authority-ok')"],
                        cwd: ".",
                        trackedPaths: ["tracked.txt"],
                    },
                ],
            },
        ],
    };
    writeFileSync(missionPath, `${JSON.stringify(mission, null, 2)}\n`, "utf8");
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    return { container, workspaceRoot, stateDir, missionPath, graphPath };
}
function pin(authorityId, entries, headHash) {
    return { authorityId, entries, headHash };
}
function isOutside(workspaceRoot, stateDir) {
    const fromWorkspace = relative(workspaceRoot, stateDir);
    return fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace);
}
function listFiles(root, prefix = "") {
    const files = [];
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
        const relativePath = join(prefix, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFiles(root, relativePath));
        }
        else {
            files.push(relativePath);
        }
    }
    return files;
}
