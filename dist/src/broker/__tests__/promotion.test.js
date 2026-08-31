import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateStagedTransaction } from "../../oracle/executor.js";
import { PromotionError, promoteApprovedTransaction } from "../promotion.js";
import { snapshotCleanGitWorkspace, stageProposal } from "../staging.js";
import { contentHash } from "../transaction.js";
test("promotes an approved transaction as one fast-forward commit and cleans staging", () => {
    const repo = createRepository();
    try {
        const source = snapshotCleanGitWorkspace(repo.root);
        const staged = stageUpdate(repo.root, source.version);
        const evaluation = evaluateStagedTransaction(staged, [passingGate()]);
        assert.equal(evaluation.status, "approved");
        if (evaluation.status !== "approved") {
            assert.fail("Expected approved evaluation");
        }
        const result = promoteApprovedTransaction(evaluation.approval);
        assert.equal(result.parentVersion, source.version);
        assert.equal(result.transactionId, staged.transaction.transactionId);
        assert.equal(git(repo.root, ["rev-parse", "HEAD"]), result.promotedVersion);
        assert.equal(git(repo.root, ["rev-parse", "HEAD^"]), source.version);
        assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "new");
        assert.equal(git(repo.root, ["status", "--porcelain=v1"]), "");
        assert.equal(existsSync(staged.containerPath), false);
        const message = git(repo.root, ["log", "-1", "--format=%B"]);
        assert.match(message, new RegExp(staged.transaction.transactionId));
        assert.match(message, new RegExp(evaluation.approval.verdictHash));
        assert.throws(() => promoteApprovedTransaction(evaluation.approval), (error) => error instanceof PromotionError && error.code === "not_approved");
        assert.equal(git(repo.root, ["rev-parse", "HEAD"]), result.promotedVersion);
    }
    finally {
        rmSync(repo.container, { recursive: true, force: true });
    }
});
test("rejects a forged approval without touching a repository", () => {
    assert.throws(() => promoteApprovedTransaction({
        transactionId: "forged",
        verdictHash: "0".repeat(64),
    }), (error) => error instanceof PromotionError && error.code === "not_approved");
});
test("rejects stale source HEAD after approval and consumes the approval", () => {
    const repo = createRepository();
    try {
        const source = snapshotCleanGitWorkspace(repo.root);
        const staged = stageUpdate(repo.root, source.version);
        const evaluation = evaluateStagedTransaction(staged, [passingGate()]);
        assert.equal(evaluation.status, "approved");
        if (evaluation.status !== "approved") {
            assert.fail("Expected approved evaluation");
        }
        writeFileSync(join(repo.root, "concurrent.txt"), "other-change", "utf8");
        git(repo.root, ["add", "."]);
        git(repo.root, ["commit", "-m", "concurrent"]);
        const concurrentHead = git(repo.root, ["rev-parse", "HEAD"]);
        assert.throws(() => promoteApprovedTransaction(evaluation.approval), (error) => error instanceof PromotionError && error.code === "stale_parent");
        assert.equal(git(repo.root, ["rev-parse", "HEAD"]), concurrentHead);
        assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "old");
        assert.equal(readFileSync(join(repo.root, "concurrent.txt"), "utf8"), "other-change");
        assert.equal(existsSync(staged.containerPath), false);
        assert.throws(() => promoteApprovedTransaction(evaluation.approval), (error) => error instanceof PromotionError && error.code === "not_approved");
    }
    finally {
        rmSync(repo.container, { recursive: true, force: true });
    }
});
function stageUpdate(root, parentVersion) {
    return stageProposal(root, {
        schemaVersion: 1,
        parentVersion,
        operations: [
            { kind: "write", path: "a.txt", baseHash: contentHash("old"), content: "new" },
        ],
    });
}
function passingGate() {
    return {
        id: "pass",
        program: process.execPath,
        args: ["-e", "1"],
        timeoutMs: 10_000,
    };
}
function createRepository() {
    const container = mkdtempSync(join(tmpdir(), "oma-promotion-test-"));
    const root = join(container, "repo");
    mkdirSync(root);
    git(root, ["init"]);
    git(root, ["config", "user.email", "oma-test@example.invalid"]);
    git(root, ["config", "user.name", "OMA Test"]);
    writeFileSync(join(root, "a.txt"), "old", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fixture"]);
    return { container, root };
}
function git(root, args) {
    const result = spawnSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr ?? result.error?.message);
    return (result.stdout ?? "").trim();
}
