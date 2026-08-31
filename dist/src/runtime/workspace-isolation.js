import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
export class WorkspaceIsolationEngine {
    static setupMissionIsolation(workspaceRoot, missionId) {
        const missionDir = join(workspaceRoot, ".oma", "missions", missionId);
        const eventsPath = join(missionDir, "events.jsonl");
        const artifactsDir = join(missionDir, "artifacts");
        const checkpointsDir = join(missionDir, "checkpoints");
        const worktreesDir = join(workspaceRoot, ".oma", "worktrees", missionId);
        mkdirSync(missionDir, { recursive: true });
        mkdirSync(artifactsDir, { recursive: true });
        mkdirSync(checkpointsDir, { recursive: true });
        mkdirSync(worktreesDir, { recursive: true });
        return {
            missionDir,
            eventsPath,
            artifactsDir,
            checkpointsDir,
            worktreesDir,
        };
    }
    static cleanupMissionWorktrees(worktreesDir) {
        if (!existsSync(worktreesDir))
            return { cleanedCount: 0 };
        const entries = readdirSync(worktreesDir);
        let cleanedCount = 0;
        for (const entry of entries) {
            const fullPath = join(worktreesDir, entry);
            try {
                rmSync(fullPath, { recursive: true, force: true });
                cleanedCount++;
            }
            catch {
                // Safe skip
            }
        }
        return { cleanedCount };
    }
}
