import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  MISSION_HEARTBEAT_STALE_MS,
  isMissionLiveFor,
  missionLiveMarkerPath,
  startMissionLiveness,
  type MissionLivenessHandle,
  type MissionLiveMarker,
} from "../mission-liveness.js";
import { evaluateStrictToolUse } from "../policy.js";

let strictContainer = "";
let strictWorkspace = "";
let strictReadTarget = "";
let strictMission: MissionLivenessHandle | undefined;

function ensureStrictEnvironment(): void {
  if (!strictContainer) {
    strictContainer = mkdtempSync(join(tmpdir(), "oma-strict-live-"));
    strictWorkspace = join(strictContainer, "workspace");
    strictReadTarget = join(strictWorkspace, "read-target.txt");
    mkdirSync(strictWorkspace, { recursive: true });
    writeFileSync(strictReadTarget, "readable", "utf8");
    strictMission = startMissionLiveness({
      missionId: "strict-test-mission",
      epoch: "strict-test-epoch",
      ownerPid: process.pid,
      workspaceRoot: strictWorkspace,
    });
    process.on("exit", () => {
      try {
        strictMission?.stop();
        if (strictContainer) rmSync(strictContainer, { recursive: true, force: true });
      } catch {}
    });
  }
}

function payload(name: string, args: Record<string, unknown> = {}): unknown {
  ensureStrictEnvironment();
  return { toolCall: { name, args }, workspacePaths: [strictWorkspace] };
}

test("denies every direct file mutation tool", () => {
  for (const tool of [
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
  ]) {
    assert.equal(evaluateStrictToolUse(payload(tool)).decision, "deny", tool);
  }
});

test("denies shell execution even when the command looks harmless", () => {
  const decision = evaluateStrictToolUse(
    payload("run_command", { CommandLine: "echo harmless" }),
  );
  assert.equal(decision.decision, "deny");
});

test("allows only the OMA broker through the generic MCP wrapper", () => {
  assert.equal(
    evaluateStrictToolUse(
      payload("call_mcp_tool", {
        ServerName: "oma-broker",
        ToolName: "propose_change",
      }),
    ).decision,
    "allow",
  );
  assert.equal(
    evaluateStrictToolUse(
      payload("call_mcp_tool", {
        ServerName: "untrusted-server",
        ToolName: "propose_change",
      }),
    ).decision,
    "deny",
  );
  assert.equal(
    evaluateStrictToolUse(
      payload("call_mcp_tool", { ToolName: "oma-broker/propose_change" }),
    ).decision,
    "allow",
  );
  assert.equal(
    evaluateStrictToolUse(
      payload("call_mcp_tool", { ToolName: "filesystem/write_file" }),
    ).decision,
    "deny",
  );
  for (const directName of [
    "mcp__oma-broker__propose_change",
    "mcp__oma_broker__propose_change",
    "mcp_oma-broker_propose_change",
  ]) {
    assert.equal(evaluateStrictToolUse(payload(directName)).decision, "allow", directName);
  }
});

test("allows known read tools and denies unknown tools", () => {
  assert.equal(
    evaluateStrictToolUse(
      payload("view_file", { AbsolutePath: strictReadTarget }),
    ).decision,
    "allow",
  );
  assert.equal(evaluateStrictToolUse(payload("mystery_tool")).decision, "deny");
});

test("denies filesystem reads outside mounted workspaces", () => {
  const input = {
    toolCall: { name: "view_file", args: { AbsolutePath: process.execPath } },
    workspacePaths: [strictWorkspace],
  };
  assert.equal(evaluateStrictToolUse(input).decision, "deny");
});

test("fails closed on malformed hook input", () => {
  assert.equal(evaluateStrictToolUse({}).decision, "deny");
  assert.equal(evaluateStrictToolUse(null).decision, "deny");
});

test("gates the official Antigravity PreToolUse payload over stdin/stdout", () => {
  const common = {
    stepIdx: 1,
    conversationId: "strict-integration-test",
    workspacePaths: [strictWorkspace],
    transcriptPath: "transcript.jsonl",
    artifactDirectoryPath: "artifacts",
    modelName: "test-model",
  };

  assert.equal(
    invokeHook(strictWorkspace, {
      ...common,
      toolCall: { name: "write_to_file", args: { TargetFile: "x.ts" } },
    }),
    "deny",
  );
  assert.equal(
    invokeHook(strictWorkspace, {
      ...common,
      toolCall: {
        name: "view_file",
        args: { AbsolutePath: strictReadTarget },
      },
    }),
    "allow",
  );
});

test("allows direct mutation when no mission is live", () => {
  const fixture = createWorkspace("oma-strict-no-mission-");
  try {
    assert.equal(
      invokeHook(fixture.workspaceRoot, {
        toolCall: { name: "write_to_file", args: { TargetFile: "x.ts" } },
        workspacePaths: [fixture.workspaceRoot],
      }),
      "allow",
    );
  } finally {
    fixture.cleanup();
  }
});

test("allows malformed payload when no mission is live", () => {
  const fixture = createWorkspace("oma-strict-no-mission-malformed-");
  try {
    assert.equal(invokeHook(fixture.workspaceRoot, "not-json"), "allow");
  } finally {
    fixture.cleanup();
  }
});

test("keeps strict denial and malformed fail-closed behavior for a live mission in scope", () => {
  assert.equal(
    invokeHook(strictWorkspace, {
      toolCall: { name: "write_to_file", args: { TargetFile: "x.ts" } },
      workspacePaths: [strictWorkspace],
    }),
    "deny",
  );
  assert.equal(invokeHook(strictWorkspace, "not-json"), "deny");
});

test("allows tool use when the live mission belongs to a different workspace", () => {
  const missionFixture = createWorkspace("oma-strict-other-live-");
  const currentFixture = createWorkspace("oma-strict-other-current-");
  const mission = startMissionLiveness({
    missionId: "different-workspace",
    epoch: "different-workspace-epoch",
    ownerPid: process.pid,
    workspaceRoot: missionFixture.workspaceRoot,
  });
  try {
    assert.equal(isMissionLiveFor([missionFixture.workspaceRoot]), true);
    assert.equal(isMissionLiveFor([currentFixture.workspaceRoot]), false);
    assert.equal(
      invokeHook(currentFixture.workspaceRoot, {
        toolCall: { name: "write_to_file", args: {} },
        workspacePaths: [currentFixture.workspaceRoot],
      }),
      "allow",
    );
  } finally {
    mission.stop();
    missionFixture.cleanup();
    currentFixture.cleanup();
  }
});

test("allows tool use when the mission owner process is dead", () => {
  const fixture = createWorkspace("oma-strict-dead-owner-");
  try {
    writeMarker(fixture.workspaceRoot, {
      missionId: "dead-owner",
      epoch: "dead-owner-epoch",
      ownerPid: 2_147_483_647,
      workspaceRoot: fixture.workspaceRoot,
      heartbeatAt: new Date().toISOString(),
    });
    assert.equal(isMissionLiveFor([fixture.workspaceRoot]), false);
    assert.equal(
      invokeHook(fixture.workspaceRoot, {
        toolCall: { name: "write_to_file", args: {} },
        workspacePaths: [fixture.workspaceRoot],
      }),
      "allow",
    );
  } finally {
    fixture.cleanup();
  }
});

test("allows tool use when the mission heartbeat is stale", () => {
  const fixture = createWorkspace("oma-strict-stale-heartbeat-");
  try {
    writeMarker(fixture.workspaceRoot, {
      missionId: "stale-heartbeat",
      epoch: "stale-heartbeat-epoch",
      ownerPid: process.pid,
      workspaceRoot: fixture.workspaceRoot,
      heartbeatAt: new Date(Date.now() - MISSION_HEARTBEAT_STALE_MS - 1_000).toISOString(),
    });
    assert.equal(isMissionLiveFor([fixture.workspaceRoot]), false);
    assert.equal(
      invokeHook(fixture.workspaceRoot, {
        toolCall: { name: "write_to_file", args: {} },
        workspacePaths: [fixture.workspaceRoot],
      }),
      "allow",
    );
  } finally {
    fixture.cleanup();
  }
});

function invokeHook(cwd: string, input: unknown): "allow" | "deny" {
  const hookPath = fileURLToPath(new URL("../hook.js", import.meta.url));
  const result = spawnSync(process.execPath, [hookPath], {
    cwd,
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as unknown;
  assert.ok(isRecord(output));
  assert.ok(output.decision === "allow" || output.decision === "deny");
  return output.decision;
}

function createWorkspace(prefix: string): {
  workspaceRoot: string;
  cleanup(): void;
} {
  const container = mkdtempSync(join(tmpdir(), prefix));
  const workspaceRoot = join(container, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  return {
    workspaceRoot,
    cleanup(): void {
      rmSync(container, { recursive: true, force: true });
    },
  };
}

function writeMarker(workspaceRoot: string, marker: MissionLiveMarker): void {
  const path = missionLiveMarkerPath(workspaceRoot, marker.missionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
