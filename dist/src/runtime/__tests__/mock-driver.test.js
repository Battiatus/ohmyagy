import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockAgyDriver } from "../mock-driver.js";
describe("WP-3 MockAgyDriver Hermetic Test Bench Suite", () => {
    it("provides default success response when no scenario matches", async () => {
        const mock = new MockAgyDriver();
        const result = await mock.invoke({
            contractPrompt: "Generate initial plan",
            persona: "oma-planner",
            worktreeDir: "/tmp/worktree",
            timeoutMs: 5000,
        });
        assert.equal(result.status, "success");
        assert.equal(result.exitCode, 0);
        assert.equal(mock.getInvocationCount(), 1);
        assert.equal(mock.lastInvocation()?.options.persona, "oma-planner");
    });
    it("matches scenario by exact persona and contract substring", async () => {
        const mock = new MockAgyDriver();
        mock.registerSuccess("oma-reviewer", { verdict: "approved", comments: "LGTM" }, "Review diff for task_01");
        const result = await mock.invoke({
            contractPrompt: "Review diff for task_01 against acceptance criteria",
            persona: "oma-reviewer",
            worktreeDir: "/tmp/worktree",
            timeoutMs: 5000,
        });
        assert.equal(result.status, "success");
        assert.deepEqual(result.parsedOutput, { verdict: "approved", comments: "LGTM" });
    });
    it("matches scenario with RegExp persona and contract pattern", async () => {
        const mock = new MockAgyDriver();
        mock.registerScenario({
            matcher: {
                persona: /^oma-(?:executor|worker)$/,
                contractPattern: /refactor\s+module\s+\w+/i,
            },
            response: {
                exitCode: 0,
                status: "success",
                payload: { status: "success", refactored: true },
            },
        });
        const result = await mock.invoke({
            contractPrompt: "Please refactor module authentication carefully",
            persona: "oma-executor",
            worktreeDir: "/tmp/worktree",
            timeoutMs: 5000,
        });
        assert.equal(result.status, "success");
        assert.deepEqual(result.parsedOutput, { status: "success", refactored: true });
    });
    it("simulates failed execution with specific exit code and stderr", async () => {
        const mock = new MockAgyDriver();
        mock.registerFailure("oma-executor", "Compilation failed with 3 errors", 1, "Compile module");
        const result = await mock.invoke({
            contractPrompt: "Compile module core.ts",
            persona: "oma-executor",
            worktreeDir: "/tmp/worktree",
            timeoutMs: 5000,
        });
        assert.equal(result.status, "failed");
        assert.equal(result.exitCode, 1);
        assert.match(result.rawStderr, /Compilation failed with 3 errors/);
    });
    it("simulates watchdog timeout and exit code 124", async () => {
        const mock = new MockAgyDriver({ instantTimeout: true });
        mock.registerTimeout("oma-forensic");
        const result = await mock.invoke({
            contractPrompt: "Analyze crash dump",
            persona: "oma-forensic",
            worktreeDir: "/tmp/worktree",
            timeoutMs: 2000,
        });
        assert.equal(result.status, "timed_out");
        assert.equal(result.exitCode, 124);
        assert.equal(result.timedOut, true);
    });
    it("simulates simulated OOM and fatal crash scenarios", async () => {
        const mock = new MockAgyDriver();
        mock.registerScenario({
            matcher: { persona: "oom-tester" },
            response: { simulateOom: true },
        });
        mock.registerScenario({
            matcher: { persona: "crash-tester" },
            response: { simulateCrash: true, rawStderr: "Segmentation fault core dump" },
        });
        const oomResult = await mock.invoke({
            contractPrompt: "Stress test memory",
            persona: "oom-tester",
            worktreeDir: "/tmp/worktree",
            timeoutMs: 5000,
        });
        assert.equal(oomResult.status, "oom_killed");
        assert.equal(oomResult.exitCode, 137);
        const crashResult = await mock.invoke({
            contractPrompt: "Run native binary",
            persona: "crash-tester",
            worktreeDir: "/tmp/worktree",
            timeoutMs: 5000,
        });
        assert.equal(crashResult.status, "fatal_crash");
        assert.equal(crashResult.exitCode, 255);
        assert.match(crashResult.rawStderr, /Segmentation fault/);
    });
    it("simulates malformed JSON payload resulting in status failed", async () => {
        const mock = new MockAgyDriver();
        mock.registerScenario({
            matcher: { persona: "oma-verifier" },
            response: {
                exitCode: 0,
                payload: "Invalid { json non-terminated",
            },
        });
        const result = await mock.invoke({
            contractPrompt: "Verify gates",
            persona: "oma-verifier",
            worktreeDir: "/tmp/worktree",
            timeoutMs: 5000,
        });
        assert.equal(result.status, "failed");
        assert.equal(result.exitCode, 0);
        assert.equal(result.parsedOutput, undefined);
    });
    it("records invocation history and allows querying by persona", async () => {
        const mock = new MockAgyDriver();
        await mock.invoke({
            contractPrompt: "Task 1",
            persona: "oma-planner",
            worktreeDir: "/tmp/wt1",
            timeoutMs: 1000,
        });
        await mock.invoke({
            contractPrompt: "Task 2",
            persona: "oma-executor",
            worktreeDir: "/tmp/wt2",
            timeoutMs: 1000,
        });
        await mock.invoke({
            contractPrompt: "Task 3",
            persona: "oma-planner",
            worktreeDir: "/tmp/wt3",
            timeoutMs: 1000,
        });
        assert.equal(mock.getInvocationCount(), 3);
        const plannerInvocations = mock.getInvocationsForPersona("oma-planner");
        assert.equal(plannerInvocations.length, 2);
        assert.equal(plannerInvocations[0].options.contractPrompt, "Task 1");
        assert.equal(plannerInvocations[1].options.contractPrompt, "Task 3");
    });
    it("supports consumeOnce scenarios and reset()", async () => {
        const mock = new MockAgyDriver();
        mock.registerScenario({
            matcher: { persona: "one-shot" },
            response: { exitCode: 0, status: "success", payload: { once: true } },
            consumeOnce: true,
        });
        const first = await mock.invoke({
            contractPrompt: "First call",
            persona: "one-shot",
            worktreeDir: "/tmp/wt",
            timeoutMs: 1000,
        });
        assert.deepEqual(first.parsedOutput, { once: true });
        const second = await mock.invoke({
            contractPrompt: "Second call",
            persona: "one-shot",
            worktreeDir: "/tmp/wt",
            timeoutMs: 1000,
        });
        // Falls back to default payload
        assert.notDeepEqual(second.parsedOutput, { once: true });
        mock.reset();
        assert.equal(mock.getInvocationCount(), 0);
    });
});
