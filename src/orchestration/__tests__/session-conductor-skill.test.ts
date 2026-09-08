import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { installWorkspacePlugin } from "../../packaging/install.js";

describe("Phase 4: Session-Native Conductor Skill & Invariants (T4.1 - T4.4)", () => {
  const repoRoot = resolve(process.cwd());
  const skillPaths = [
    join(repoRoot, "src", "plugin-assets", "skills", "oma-start", "SKILL.md"),
    join(repoRoot, ".agents", "skills", "oma-start", "SKILL.md"),
    join(repoRoot, ".agents", "plugins", "oma", "skills", "oma-start", "SKILL.md"),
  ];

  function md5(content: string): string {
    return createHash("md5").update(content, "utf8").digest("hex");
  }

  it("T4.1: all 3 copies of oma-start/SKILL.md exist and have strictly identical MD5 checksums", () => {
    assert.equal(skillPaths.length, 3);
    const hashes: string[] = [];

    for (const filePath of skillPaths) {
      assert.ok(existsSync(filePath), `Skill file must exist at ${filePath}`);
      const content = readFileSync(filePath, "utf8");
      hashes.push(md5(content));
    }

    assert.equal(hashes[0], hashes[1], "Source and .agents/skills copies must have identical checksum");
    assert.equal(hashes[0], hashes[2], "Source and .agents/plugins/oma copies must have identical checksum");
  });

  it("T4.1: skill specifies the 3-level Late-Init context ingestion cascade with graceful fallback", () => {
    const content = readFileSync(skillPaths[0], "utf8");

    // Level 1: Active session working memory
    assert.match(content, /Level 1/i);
    assert.match(content, /Active Session Working Memory/i);

    // Level 2: Cross-session SQLite facts & graph state
    assert.match(content, /Level 2/i);
    assert.match(content, /brain_query/i);
    assert.match(content, /converge_status/i);

    // Level 3: Optional transcript with graceful fallback
    assert.match(content, /Level 3/i);
    assert.match(content, /transcript/i);
    assert.match(content, /graceful/i);
  });

  it("T4.2: skill enforces mandatory blocking surgical interview gate before any run", () => {
    const content = readFileSync(skillPaths[0], "utf8");

    // Sequence 1: 2-3 sentence summary
    assert.match(content, /2(\s*(-|to)\s*|\s+)3 sentences/i);

    // Sequence 2: 2-3 targeted questions on frictions
    assert.match(content, /2(\s*(-|to)\s*|\s+)3 targeted questions/i);
    assert.match(content, /measurable/i);
    assert.match(content, /constraints/i);
    assert.match(content, /mode/i);

    // Sequence 3: Zero run/execution before explicit user confirmation
    assert.match(content, /zero run/i);
    assert.match(content, /blocked/i);
  });

  it("T4.3: skill specifies mode selection calling plan_route {mode} to obtain canonical roles & ModeConfig", () => {
    const content = readFileSync(skillPaths[0], "utf8");

    assert.match(content, /plan_route/i);
    assert.match(content, /modeConfig/i);
    assert.match(content, /planner/);
    assert.match(content, /explorer/);
    assert.match(content, /executor/);
    assert.match(content, /reviewer/);
    assert.match(content, /verifier/);
  });

  it("T4.4: skill specifies session-native loop driven by converge_step and graph_replan", () => {
    const content = readFileSync(skillPaths[0], "utf8");

    assert.match(content, /converge_step/i);
    assert.match(content, /no_progress_blocked/i);
    assert.match(content, /graph_mark_node/i);
    assert.match(content, /propose_change/i);
    assert.match(content, /attest_review/i);
    assert.match(content, /promote_change/i);
    assert.match(content, /graph_replan/i);
  });

  it("packaging: installWorkspacePlugin preserves skill synchronization in deployed workspaces", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "oma-skill-test-"));
    try {
      const sourceContent = readFileSync(skillPaths[0], "utf8");
      const sourceHash = md5(sourceContent);

      installWorkspacePlugin(tempDir, { force: true });

      const installedSkillPath = join(
        tempDir,
        ".agents",
        "plugins",
        "oma",
        "skills",
        "oma-start",
        "SKILL.md",
      );
      assert.ok(existsSync(installedSkillPath), "Deployed workspace must contain oma-start/SKILL.md");
      const installedContent = readFileSync(installedSkillPath, "utf8");
      const installedHash = md5(installedContent);

      assert.equal(installedHash, sourceHash, "Installed skill MD5 must match source skill MD5");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
