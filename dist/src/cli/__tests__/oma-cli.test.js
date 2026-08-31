import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOmaCli } from "../oma-cli.js";
describe("OMA CLI Comprehensive Test Suite", () => {
    let testWorkspace;
    before(() => {
        testWorkspace = mkdtempSync(join(tmpdir(), "oma-cli-test-"));
    });
    after(() => {
        try {
            rmSync(testWorkspace, { recursive: true, force: true });
        }
        catch {
            // Ignore
        }
    });
    it("handles help flags gracefully", async () => {
        assert.equal(await runOmaCli([], testWorkspace), 0);
        assert.equal(await runOmaCli(["--help"], testWorkspace), 0);
        assert.equal(await runOmaCli(["-h"], testWorkspace), 0);
        assert.equal(await runOmaCli(["help"], testWorkspace), 0);
    });
    it("executes doctor command and outputs environmental diagnostics", async () => {
        const code = await runOmaCli(["doctor"], testWorkspace);
        assert.equal(code, 0);
    });
    it("installs plugin into workspace and tests --force idempotency", async () => {
        // 1. First installation should succeed
        const code1 = await runOmaCli(["plugin", "install-workspace"], testWorkspace);
        assert.equal(code1, 0);
        const pluginDir = join(testWorkspace, ".agents", "plugins", "oma");
        assert.ok(existsSync(pluginDir));
        assert.ok(existsSync(join(pluginDir, "plugin.json")));
        // 2. Second installation without --force should fail cleanly with code 1
        const code2 = await runOmaCli(["plugin", "install-workspace"], testWorkspace);
        assert.equal(code2, 1);
        // 3. Third installation with --force should succeed idempotently
        const code3 = await runOmaCli(["plugin", "install-workspace", "--force"], testWorkspace);
        assert.equal(code3, 0);
        // 4. Fourth installation with -f should also succeed
        const code4 = await runOmaCli(["plugin", "install-workspace", "-f"], testWorkspace);
        assert.equal(code4, 0);
    });
    it("returns error code 1 on status and inspect when no mission exists", async () => {
        const emptyWorkspace = mkdtempSync(join(tmpdir(), "oma-cli-empty-"));
        try {
            assert.equal(await runOmaCli(["status"], emptyWorkspace), 1);
            assert.equal(await runOmaCli(["status", "--json"], emptyWorkspace), 1);
            assert.equal(await runOmaCli(["inspect"], emptyWorkspace), 1);
            assert.equal(await runOmaCli(["inspect", "--json"], emptyWorkspace), 1);
            assert.equal(await runOmaCli(["resume"], emptyWorkspace), 1);
        }
        finally {
            rmSync(emptyWorkspace, { recursive: true, force: true });
        }
    });
    it("executes full mission lifecycle: run -> status -> inspect -> resume", async () => {
        const missionId = `cli-e2e-${Date.now()}`;
        // 1. Run mission
        const runCode = await runOmaCli(["run", missionId], testWorkspace);
        assert.equal(runCode, 0);
        // 2. Status formatted and JSON
        const statusCode1 = await runOmaCli(["status", "--mission", missionId], testWorkspace);
        assert.equal(statusCode1, 0);
        const statusCode2 = await runOmaCli(["status", "--json", "--mission", missionId], testWorkspace);
        assert.equal(statusCode2, 0);
        // 3. Inspect formatted and JSON
        const inspectCode1 = await runOmaCli(["inspect", "--mission", missionId], testWorkspace);
        assert.equal(inspectCode1, 0);
        const inspectCode2 = await runOmaCli(["inspect", "--json", "--mission", missionId], testWorkspace);
        assert.equal(inspectCode2, 0);
        // 4. Resume mission
        const resumeCode = await runOmaCli(["resume", "--mission", missionId], testWorkspace);
        assert.equal(resumeCode, 0);
    });
    it("executes benchmark via CLI and persists metrics", async () => {
        const code = await runOmaCli(["benchmark", "--trials", "1"], testWorkspace);
        assert.equal(code, 0);
        const benchDir = join(testWorkspace, ".oma", "benchmark");
        assert.ok(existsSync(benchDir));
        assert.ok(existsSync(join(benchDir, "causal_benchmark_report.md")));
    });
    it("returns error code 1 for unknown command", async () => {
        const code = await runOmaCli(["invalid-command-xyz"], testWorkspace);
        assert.equal(code, 1);
    });
});
