// Arms the OMA strict write gate the way production code never does.
//
// `startMissionLiveness` is referenced only by its own unit test, so no shipped
// path ever writes `.oma/v2/missions/<id>/live.json`. `isMissionLiveFor()` then
// always returns false and `strict/hook.ts` always answers "allow". This script
// holds a live marker open so the hook's enforcing branch can actually be
// observed. It is a probe artifact, not a fix.
import { isMissionLiveFor, startMissionLiveness } from "../../dist/src/strict/mission-liveness.js";

const workspaceRoot = process.argv[2];
const missionId = process.argv[3] ?? "probe-gate";

if (!workspaceRoot) {
  console.error("usage: node arm-liveness.mjs <workspaceRoot> [missionId]");
  process.exit(2);
}

const handle = startMissionLiveness({
  missionId,
  epoch: "probe-epoch-1",
  ownerPid: process.pid,
  workspaceRoot,
});

console.log(`ARMED ownerPid=${process.pid} missionId=${missionId} workspaceRoot=${workspaceRoot}`);
console.log(`isMissionLiveFor([workspaceRoot]) = ${isMissionLiveFor([workspaceRoot])}`);

const shutdown = () => {
  handle.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => {}, 1000);
