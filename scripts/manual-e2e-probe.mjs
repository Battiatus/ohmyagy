// Manual real mission probe: same shape as real-mission.e2e.test.ts but keeps
// artifacts on disk so a human can inspect the receipts afterwards. The scratch
// workspace MUST live in the system temp dir: anywhere inside a git repo would
// be picked up as the parent repo by git commands (as demonstrated when this
// script staged a commit into the parent repo from a nested folder).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { installWorkspacePlugin } from "../dist/src/packaging/install.js";
import { RealMissionExecutor } from "../dist/src/orchestration/real-mission.js";

const root = mkdtempSync(join(tmpdir(), "oma-manual-e2e-"));
console.log(`scratch workspace: ${root}`);
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src", "value.txt"), "before\n", "utf8");
const git = (args) => {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr ?? `git exit ${r.status}`);
  return r.stdout.trim();
};
if (!root.startsWith(join(tmpdir()))) {
  throw new Error(`scratch dir ${root} is not under the system temp dir; refusing to run inside a project`);
}
git(["init"]); git(["config", "user.email", "oma-test@local.invalid"]); git(["config", "user.name", "OMA Test"]);
git(["add", "."]); git(["commit", "-m", "initial"]);
mkdirSync(join(root, ".omc", "state"), { recursive: true });
mkdirSync(join(root, ".omo", "run-continuation"), { recursive: true });
writeFileSync(join(root, ".omc", "state", "session.json"), "{}\n", "utf8");
writeFileSync(join(root, ".omo", "run-continuation", "session.json"), "{}\n", "utf8");
const passGate = { id: "always-pass", program: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 30_000 };
installWorkspacePlugin(root, { gates: [passGate] });
git(["add", "-A"]); git(["commit", "-m", "install oma plugin", "--allow-empty"]);

const report = await RealMissionExecutor.execute({
  workspaceRoot: root,
  missionId: "manual-e2e-probe",
  goal: 'Edit src/value.txt so its only contents become the single line "after".',
  gates: [passGate],
  timeoutMs: 300_000,
  maxConcurrency: 1,
  maxWaves: 2,
  verbose: true,
});

console.log("REPORT", JSON.stringify({ status: report.status, commits: report.commitShas, waves: report.wavesCompleted }, null, 2));
console.log("value.txt:", JSON.stringify(readFileSync(join(root, "src", "value.txt"), "utf8")));
