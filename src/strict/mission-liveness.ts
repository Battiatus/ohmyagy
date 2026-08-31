import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MISSION_HEARTBEAT_REFRESH_MS = 5_000;

// Twenty seconds tolerates three missed five-second refreshes during brief scheduler
// pauses while still releasing strict mode promptly after an unclean mission halt.
export const MISSION_HEARTBEAT_STALE_MS = 20_000;

export interface MissionLiveMarker {
  missionId: string;
  epoch: string;
  ownerPid: number;
  workspaceRoot: string;
  heartbeatAt: string;
}

export interface MissionLivenessHandle {
  refresh(): void;
  stop(): void;
}

export interface StartMissionLivenessOptions {
  missionId: string;
  epoch: string;
  ownerPid: number;
  workspaceRoot: string;
}

export function isMissionLiveFor(workspacePaths: readonly string[]): boolean {
  const resolvedWorkspacePaths = workspacePaths
    .filter((path): path is string => typeof path === "string" && path.length > 0)
    .map((path) => resolve(path));
  if (resolvedWorkspacePaths.length === 0) {
    return false;
  }

  const checkedRoots = new Set<string>();
  for (const workspacePath of resolvedWorkspacePaths) {
    for (const candidateRoot of ancestorPaths(workspacePath)) {
      const key = pathKey(candidateRoot);
      if (checkedRoots.has(key)) {
        continue;
      }
      checkedRoots.add(key);
      if (hasLiveMarker(candidateRoot, resolvedWorkspacePaths)) {
        return true;
      }
    }
  }
  return false;
}

export function startMissionLiveness(
  options: StartMissionLivenessOptions,
): MissionLivenessHandle {
  const markerPath = missionLiveMarkerPath(options.workspaceRoot, options.missionId);
  const markerIdentity = {
    missionId: options.missionId,
    epoch: requireNonEmpty(options.epoch, "epoch"),
    ownerPid: requirePid(options.ownerPid),
    workspaceRoot: resolve(options.workspaceRoot),
  };
  let stopped = false;

  const refresh = (): void => {
    if (stopped) {
      return;
    }
    mkdirSync(dirname(markerPath), { recursive: true });
    const marker: MissionLiveMarker = {
      ...markerIdentity,
      heartbeatAt: new Date().toISOString(),
    };
    const temporaryPath = `${markerPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
      renameSync(temporaryPath, markerPath);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  };

  const timer = setInterval(refresh, MISSION_HEARTBEAT_REFRESH_MS);
  timer.unref();
  refresh();

  return {
    refresh,
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      const marker = readMarker(markerPath, options.missionId);
      if (
        marker?.epoch === markerIdentity.epoch &&
        marker.ownerPid === markerIdentity.ownerPid
      ) {
        rmSync(markerPath, { force: true });
      }
    },
  };
}

export function missionLiveMarkerPath(workspaceRoot: string, missionId: string): string {
  if (
    missionId.length === 0 ||
    basename(missionId) !== missionId ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(missionId)
  ) {
    throw new Error(`Mission id is not a safe path segment: ${missionId}`);
  }
  return join(resolve(workspaceRoot), ".oma", "v2", "missions", missionId, "live.json");
}

function hasLiveMarker(candidateRoot: string, workspacePaths: readonly string[]): boolean {
  const missionsRoot = join(candidateRoot, ".oma", "v2", "missions");
  let missionDirectories: Dirent[];
  try {
    missionDirectories = readdirSync(missionsRoot, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of missionDirectories) {
    if (!entry.isDirectory()) {
      continue;
    }
    const marker = readMarker(join(missionsRoot, entry.name, "live.json"), entry.name);
    if (
      marker &&
      samePath(marker.workspaceRoot, candidateRoot) &&
      workspacePaths.some((path) => containsPath(marker.workspaceRoot, path)) &&
      isProcessLive(marker.ownerPid) &&
      isFreshHeartbeat(marker.heartbeatAt)
    ) {
      return true;
    }
  }
  return false;
}

function readMarker(path: string, expectedMissionId: string): MissionLiveMarker | undefined {
  try {
    const input = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(input)) {
      return undefined;
    }
    if (
      input.missionId !== expectedMissionId ||
      typeof input.epoch !== "string" ||
      input.epoch.length === 0 ||
      !Number.isInteger(input.ownerPid) ||
      Number(input.ownerPid) <= 0 ||
      typeof input.workspaceRoot !== "string" ||
      !isAbsolute(input.workspaceRoot) ||
      typeof input.heartbeatAt !== "string" ||
      !Number.isFinite(Date.parse(input.heartbeatAt))
    ) {
      return undefined;
    }
    return {
      missionId: input.missionId,
      epoch: input.epoch,
      ownerPid: Number(input.ownerPid),
      workspaceRoot: resolve(input.workspaceRoot),
      heartbeatAt: input.heartbeatAt,
    };
  } catch {
    return undefined;
  }
}

function ancestorPaths(path: string): string[] {
  const ancestors: string[] = [];
  let current = resolve(path);
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) {
      return ancestors;
    }
    current = parent;
  }
}

function containsPath(root: string, target: string): boolean {
  const fromRoot = relative(resolve(root), resolve(target));
  return (
    fromRoot.length === 0 ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function pathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isProcessLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function isFreshHeartbeat(heartbeatAt: string): boolean {
  const age = Date.now() - Date.parse(heartbeatAt);
  return age >= 0 && age <= MISSION_HEARTBEAT_STALE_MS;
}

function requireNonEmpty(value: string, name: string): string {
  if (value.length === 0) {
    throw new Error(`${name} must be non-empty`);
  }
  return value;
}

function requirePid(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("ownerPid must be a positive integer");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
