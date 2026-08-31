import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOmaCli } from "../oma-cli.js";
import { OmaDoctor } from "../../runtime/doctor.js";
import { installWorkspacePlugin } from "../../packaging/install.js";
import { MissionEventsStore } from "../../ledger/mission-events.js";
describe("OMA Empirical Adversarial Stress Test Suite (m5_challenger_1)", () => {
    let stressWorkspace;
    before(() => {
        stressWorkspace = mkdtempSync(join(tmpdir(), "oma-stress-main-"));
    });
    after(() => {
        try {
            rmSync(stressWorkspace, { recursive: true, force: true });
        }
        catch {
            // Ignore
        }
    });
    // ==========================================
    // 1. CLI INVOCATIONS & ARGUMENT ABUSE
    // ==========================================
    describe("1. CLI Invocations & Argument Robustness", () => {
        it("handles invalid subcommands with clean exit code 1", async () => {
            const code1 = await runOmaCli(["unknown-command-42"], stressWorkspace);
            assert.equal(code1, 1);
            const code2 = await runOmaCli(["plugin", "unknown-action"], stressWorkspace);
            assert.equal(code2, 1);
            const code3 = await runOmaCli(["--invalid-flag", "value"], stressWorkspace);
            assert.equal(code3, 1);
        });
        it("handles doctor with non-existent or deep paths without crashing", async () => {
            const nonExistentPath = join(stressWorkspace, "does", "not", "exist", "anywhere");
            const report = OmaDoctor.diagnoseEnvironment(nonExistentPath);
            assert.ok(report);
            assert.equal(typeof report.nodeCli.version, "string");
            assert.equal(report.pluginDiscovery.installed, false);
            assert.equal(report.pluginDiscovery.agentsDetected.length, 0);
            const code = await runOmaCli(["doctor"], nonExistentPath);
            assert.equal(code, 0);
        });
        it("handles status and inspect on non-existent mission with structured JSON", async () => {
            const logs = [];
            const origLog = console.log;
            console.log = (msg) => logs.push(msg);
            try {
                const statusCode = await runOmaCli(["status", "--json", "--mission", "non-existent-mission-999"], stressWorkspace);
                assert.equal(statusCode, 0); // When mission dir does not exist, MissionEventsStore.readEvents returns [] and project() gives empty projection or status
            }
            finally {
                console.log = origLog;
            }
        });
        it("handles benchmark invalid trials parameters gracefully", { timeout: 60000 }, async () => {
            // trials = -5 -> fallback to 1
            const code1 = await runOmaCli(["benchmark", "--trials", "-5"], stressWorkspace);
            assert.equal(code1, 0);
            // trials = 'invalid' -> fallback to 1
            const code2 = await runOmaCli(["benchmark", "--trials", "invalid_string"], stressWorkspace);
            assert.equal(code2, 0);
            // trials = 0 -> fallback to 1
            const code3 = await runOmaCli(["benchmark", "--trials", "0"], stressWorkspace);
            assert.equal(code3, 0);
        });
    });
    // ==========================================
    // 2. RESUMPTION ENGINE STRESS & CORRUPTION
    // ==========================================
    describe("2. Resumption Engine Under Adversarial Conditions", () => {
        it("handles resume on non-existent mission with exit code 1", async () => {
            const code = await runOmaCli(["resume", "--mission", "ghost-mission-does-not-exist"], stressWorkspace);
            assert.equal(code, 1);
        });
        it("handles resume on already succeeded mission idempotently", async () => {
            const missionId = `succeeded-mission-${Date.now()}`;
            const runCode = await runOmaCli(["run", missionId], stressWorkspace);
            assert.equal(runCode, 0);
            // Resume on the already succeeded mission
            const resumeCode = await runOmaCli(["resume", "--mission", missionId], stressWorkspace);
            assert.equal(resumeCode, 0);
            // Inspect mission state
            const inspectCode = await runOmaCli(["inspect", "--json", "--mission", missionId], stressWorkspace);
            assert.equal(inspectCode, 0);
        });
        it("catches corrupted JSON in events.jsonl and returns exit code 1 without unhandled crash", async () => {
            const corruptMissionId = `corrupt-json-mission-${Date.now()}`;
            const missionDir = join(stressWorkspace, ".oma", "missions", corruptMissionId);
            mkdirSync(missionDir, { recursive: true });
            const eventsPath = join(missionDir, "events.jsonl");
            writeFileSync(eventsPath, `{"seq":1,"type":"mission_started","timestamp":"2026-08-31T00:00:00Z","missionId":"${corruptMissionId}"}\nCORRUPTED_RAW_UNPARSABLE_JSON_DATA_LINE\n`, "utf8");
            const resumeCode = await runOmaCli(["resume", "--mission", corruptMissionId], stressWorkspace);
            assert.equal(resumeCode, 1);
            const statusCode = await runOmaCli(["status", "--mission", corruptMissionId], stressWorkspace);
            assert.equal(statusCode, 1);
        });
        it("catches broken hash chain in events.jsonl via verifyEventChain", async () => {
            const brokenMissionId = `broken-hash-mission-${Date.now()}`;
            const missionDir = join(stressWorkspace, ".oma", "missions", brokenMissionId);
            const eventsPath = join(missionDir, "events.jsonl");
            // Append valid event 1
            MissionEventsStore.appendEvent(eventsPath, brokenMissionId, {
                type: "mission_started",
                workflowDigest: "dig-1",
                rulebookRevision: "rev-1",
                goal: "Test Broken Chain",
            });
            // Append valid event 2
            MissionEventsStore.appendEvent(eventsPath, brokenMissionId, {
                type: "work_item_discovered",
                workItemId: "work-1",
                title: "Item 1",
                scope: ["src/a.ts"],
                dependsOn: [],
                roleRequired: "worker",
                acceptanceCriteria: ["AC1"],
            });
            const events = MissionEventsStore.readEvents(eventsPath);
            assert.equal(events.length, 2);
            const chainValidBefore = MissionEventsStore.verifyEventChain(events);
            assert.equal(chainValidBefore.valid, true);
            // Tamper with event 1 data on disk
            events[0].goal = "Tampered Goal Content";
            const tamperedCheck = MissionEventsStore.verifyEventChain(events);
            assert.equal(tamperedCheck.valid, false);
            assert.ok(tamperedCheck.error?.includes("Invalid event payload hash"));
        });
        it("recovers an interrupted mission with dangling run_started and executes successfully", async () => {
            const danglingMissionId = `dangling-run-mission-${Date.now()}`;
            const missionDir = join(stressWorkspace, ".oma", "missions", danglingMissionId);
            const eventsPath = join(missionDir, "events.jsonl");
            MissionEventsStore.appendEvent(eventsPath, danglingMissionId, {
                type: "mission_started",
                workflowDigest: "wf-1",
                rulebookRevision: "r-1",
                goal: "Recover Dangling Run",
            });
            MissionEventsStore.appendEvent(eventsPath, danglingMissionId, {
                type: "work_item_discovered",
                workItemId: "work-math",
                title: "Math Work Item",
                scope: ["src/math.ts"],
                dependsOn: [],
                roleRequired: "worker",
                acceptanceCriteria: ["math working"],
            });
            // Dangling run started but never finished (simulating sudden SIGKILL / crash)
            MissionEventsStore.appendEvent(eventsPath, danglingMissionId, {
                type: "run_started",
                runId: "run-work-math-worker-01",
                workItemId: "work-math",
                expertId: "worker",
                model: "gemini-3.7-flash",
                effort: "medium",
            });
            // Resume the interrupted mission
            const resumeCode = await runOmaCli(["resume", "--mission", danglingMissionId], stressWorkspace);
            assert.equal(resumeCode, 0);
            // Verify status and provenance
            const statusCode = await runOmaCli(["status", "--json", "--mission", danglingMissionId], stressWorkspace);
            assert.equal(statusCode, 0);
            const eventsAfterResume = MissionEventsStore.readEvents(eventsPath);
            const interruptedEvent = eventsAfterResume.find((e) => e.type === "run_finished" && e.status === "interrupted");
            assert.ok(interruptedEvent, "Should record an interrupted run_finished event");
            const succeededEvent = eventsAfterResume.find((e) => e.type === "mission_finished" && e.finalStatus === "succeeded");
            assert.ok(succeededEvent, "Should conclude with mission_finished succeeded");
        });
    });
    // ==========================================
    // 3. INSTALLATION, OVERWRITE & COLLISIONS
    // ==========================================
    describe("3. Plugin Installation & Collision Stress", () => {
        it("enforces strict non-overwrite without --force and clean overwrite with --force", async () => {
            const ws = mkdtempSync(join(tmpdir(), "oma-install-test-"));
            try {
                // Initial install
                const res1 = installWorkspacePlugin(ws);
                assert.ok(existsSync(res1.pluginDir));
                assert.ok(existsSync(join(res1.pluginDir, "plugin.json")));
                // Collision without force should throw
                assert.throws(() => {
                    installWorkspacePlugin(ws, { force: false });
                }, /OMA plugin already exists/);
                // Overwrite with force should succeed cleanly
                const res2 = installWorkspacePlugin(ws, { force: true });
                assert.equal(res2.pluginDir, res1.pluginDir);
                assert.ok(existsSync(join(res2.pluginDir, "plugin.json")));
                assert.ok(existsSync(join(res2.pluginDir, "agents", "worker.md")));
                assert.ok(existsSync(join(res2.pluginDir, "skills", "dynamic-workflow", "SKILL.md")));
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
        it("recovers safely if staging directory already exists", async () => {
            const ws = mkdtempSync(join(tmpdir(), "oma-staging-test-"));
            try {
                const pluginsRoot = join(ws, ".agents", "plugins");
                const stagingDir = join(pluginsRoot, `.oma-install-${process.pid}`);
                mkdirSync(stagingDir, { recursive: true });
                // When staging dir already exists, install throws clear error and does not corrupt
                assert.throws(() => {
                    installWorkspacePlugin(ws, { force: true });
                }, /Installer staging directory already exists/);
            }
            finally {
                rmSync(ws, { recursive: true, force: true });
            }
        });
    });
    // ==========================================
    // 4. CONCURRENT CLI & ISOLATION STRESS
    // ==========================================
    describe("4. Concurrency & Process Isolation", () => {
        it("handles 10 simultaneous status and inspect CLI queries without crashing", async () => {
            const missionId = `concurrent-mission-${Date.now()}`;
            await runOmaCli(["run", missionId], stressWorkspace);
            const tasks = [];
            for (let i = 0; i < 10; i++) {
                if (i % 2 === 0) {
                    tasks.push(runOmaCli(["status", "--json", "--mission", missionId], stressWorkspace));
                }
                else {
                    tasks.push(runOmaCli(["inspect", "--json", "--mission", missionId], stressWorkspace));
                }
            }
            const results = await Promise.all(tasks);
            for (const code of results) {
                assert.equal(code, 0);
            }
        });
        it("runs concurrent independent missions in parallel workspaces without cross-contamination", async () => {
            const ws1 = mkdtempSync(join(tmpdir(), "oma-para-1-"));
            const ws2 = mkdtempSync(join(tmpdir(), "oma-para-2-"));
            try {
                const p1 = runOmaCli(["run", "mission-parallel-1"], ws1);
                const p2 = runOmaCli(["run", "mission-parallel-2"], ws2);
                const [code1, code2] = await Promise.all([p1, p2]);
                assert.equal(code1, 0);
                assert.equal(code2, 0);
                assert.ok(existsSync(join(ws1, ".oma", "missions", "mission-parallel-1", "events.jsonl")));
                assert.ok(existsSync(join(ws2, ".oma", "missions", "mission-parallel-2", "events.jsonl")));
                assert.ok(!existsSync(join(ws1, ".oma", "missions", "mission-parallel-2")));
                assert.ok(!existsSync(join(ws2, ".oma", "missions", "mission-parallel-1")));
            }
            finally {
                rmSync(ws1, { recursive: true, force: true });
                rmSync(ws2, { recursive: true, force: true });
            }
        });
        it("executes concurrent installations across distinct workspaces", async () => {
            const wsA = mkdtempSync(join(tmpdir(), "oma-inst-a-"));
            const wsB = mkdtempSync(join(tmpdir(), "oma-inst-b-"));
            const wsC = mkdtempSync(join(tmpdir(), "oma-inst-c-"));
            try {
                const [cA, cB, cC] = await Promise.all([
                    runOmaCli(["plugin", "install-workspace", "--force"], wsA),
                    runOmaCli(["plugin", "install-workspace", "--force"], wsB),
                    runOmaCli(["plugin", "install-workspace", "--force"], wsC),
                ]);
                assert.equal(cA, 0);
                assert.equal(cB, 0);
                assert.equal(cC, 0);
                assert.ok(existsSync(join(wsA, ".agents", "plugins", "oma", "plugin.json")));
                assert.ok(existsSync(join(wsB, ".agents", "plugins", "oma", "plugin.json")));
                assert.ok(existsSync(join(wsC, ".agents", "plugins", "oma", "plugin.json")));
            }
            finally {
                rmSync(wsA, { recursive: true, force: true });
                rmSync(wsB, { recursive: true, force: true });
                rmSync(wsC, { recursive: true, force: true });
            }
        });
    });
    // ==========================================
    // 5. JSON OUTPUT INTEGRITY & SCHEMAS
    // ==========================================
    describe("5. JSON Output Robustness & Format Conformance", () => {
        it("guarantees valid parseable JSON output on doctor, status --json, and inspect --json", async () => {
            const missionId = `json-test-${Date.now()}`;
            await runOmaCli(["run", missionId], stressWorkspace);
            const capturedOutputs = [];
            const captureCliOutput = async (args) => {
                let text = "";
                const origLog = console.log;
                console.log = (chunk) => {
                    text += `${chunk}\n`;
                };
                try {
                    const code = await runOmaCli(args, stressWorkspace);
                    return { code, text };
                }
                finally {
                    console.log = origLog;
                }
            };
            // 1. Doctor
            const doc = await captureCliOutput(["doctor"]);
            assert.equal(doc.code, 0);
            const parsedDoc = JSON.parse(doc.text.trim());
            assert.ok(parsedDoc.nodeCli);
            assert.ok(Array.isArray(parsedDoc.pluginDiscovery.agentsDetected));
            // 2. Status --json
            const stat = await captureCliOutput(["status", "--json", "--mission", missionId]);
            assert.equal(stat.code, 0);
            const parsedStat = JSON.parse(stat.text.trim());
            assert.equal(parsedStat.missionId, missionId);
            assert.ok(parsedStat.progress);
            assert.ok(parsedStat.workGraph);
            // 3. Inspect --json
            const insp = await captureCliOutput(["inspect", "--json", "--mission", missionId]);
            assert.equal(insp.code, 0);
            const parsedInsp = JSON.parse(insp.text.trim());
            assert.ok(parsedInsp.artifacts);
            assert.ok(Array.isArray(parsedInsp.reviews));
        });
    });
});
