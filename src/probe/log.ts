import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SecretScrubber } from "../runtime/secret-scrubber.js";

/**
 * Append-only probe journal.
 *
 * Two hard rules, both learned from the host contract:
 *
 *  * **Fail-open.** A probe that can break, slow down or throw inside the session it
 *    measures is worse than no probe. Every write is best-effort and silent.
 *  * **Never persist a secret.** The probe records raw environments, and this machine's
 *    `~/.gemini/config/mcp_config.json` carries live API keys in `env` blocks. The
 *    scrubber runs before anything reaches disk, and the probe adds the probe process's
 *    own environment to the scrub list — that is exactly where a forwarded key would be.
 */

const MAX_VALUE_CHARS = 4_000;

const scrubber = new SecretScrubber({ scrubEnvironmentSecrets: true });

export interface ProbeRecord {
  at: string;
  kind: string;
  data: Record<string, unknown>;
}

export interface ProbeTarget {
  dir: string;
  file: string;
}

/**
 * Best-effort append. Never throws, never reports.
 *
 * `at` is injectable so a test can pin a timeline instead of racing the wall clock. The
 * report's spawn-model conclusion is a statement about overlapping lifetimes, and a
 * conclusion that can only be tested against whatever the clock did is not tested.
 */
export function appendProbeRecord(
  target: ProbeTarget,
  kind: string,
  data: unknown,
  at: Date = new Date(),
): void {
  try {
    mkdirSync(target.dir, { recursive: true });
    const record: ProbeRecord = {
      at: at.toISOString(),
      kind,
      data: toRecord(scrubber.scrubObject(data)),
    };
    appendFileSync(join(target.dir, target.file), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Measuring must never be able to break the measured session.
  }
}

/** Best-effort single-record file, for one-shot writers such as a hook invocation. */
export function writeProbeRecord(
  target: ProbeTarget,
  kind: string,
  data: unknown,
  at: Date = new Date(),
): void {
  try {
    mkdirSync(target.dir, { recursive: true });
    const record: ProbeRecord = {
      at: at.toISOString(),
      kind,
      data: toRecord(scrubber.scrubObject(data)),
    };
    writeFileSync(join(target.dir, target.file), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Same reason.
  }
}

export function readProbeRecords(dir: string): ProbeRecord[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const records: ProbeRecord[] = [];
  for (const name of names) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) continue;
        if (typeof parsed.at !== "string" || typeof parsed.kind !== "string") continue;
        const data = isRecord(parsed.data) ? parsed.data : {};
        records.push({ at: parsed.at, kind: parsed.kind, data: { ...data, __file: name } });
      } catch {
        continue;
      }
    }
  }
  records.sort((left, right) => left.at.localeCompare(right.at));
  return records;
}

/**
 * The environment as the host handed it over, values included.
 *
 * Both the key list and the values matter: a key list catches a workspace variable under
 * an unexpected name, and a value sweeps catch a project path passed anonymously.
 */
export function captureEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): { keys: string[]; values: Record<string, string> } {
  const keys: string[] = [];
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    keys.push(key);
    if (typeof value !== "string") continue;
    values[key] = value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…[truncated]` : value;
  }
  keys.sort();
  return { keys, values };
}

export function captureProcessIdentity(): Record<string, unknown> {
  return {
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    argv: process.argv,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    startedAt: new Date().toISOString(),
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

export function numberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
