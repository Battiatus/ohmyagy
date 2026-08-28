import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  canonicalJson,
  hashJson,
  hashTrackedPaths,
  sha256,
} from "./canonical.js";
import {
  type AcceptanceCheck,
  type CommandEvidence,
  type MissionContract,
  type TaskGraph,
  parseCommandEvidence,
  parseMissionContract,
  parseTaskGraph,
} from "./model.js";

export const GENESIS_HASH = "0".repeat(64);

export interface ControlPaths {
  root: string;
  controlDir: string;
  mission: string;
  graph: string;
  ledger: string;
  ledgerHead: string;
  evidenceDir: string;
  lock: string;
}

export interface LoadedControl {
  paths: ControlPaths;
  mission: MissionContract;
  graph: TaskGraph;
  contractHash: string;
  graphHash: string;
}

export interface LedgerVerification {
  valid: boolean;
  errors: string[];
  events: CommandEvidence[];
  headHash: string;
}

export function controlPaths(root: string): ControlPaths {
  const normalizedRoot = resolve(root);
  const controlDir = join(normalizedRoot, ".oma", "control");
  return {
    root: normalizedRoot,
    controlDir,
    mission: join(controlDir, "mission.json"),
    graph: join(controlDir, "task-graph.json"),
    ledger: join(controlDir, "ledger.jsonl"),
    ledgerHead: join(controlDir, "ledger.head.json"),
    evidenceDir: join(controlDir, "evidence"),
    lock: join(controlDir, "control.lock"),
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function loadControl(root: string): LoadedControl {
  const paths = controlPaths(root);
  const missionRaw = readJson(paths.mission);
  const graphRaw = readJson(paths.graph);
  const mission = parseMissionContract(missionRaw);
  const graph = parseTaskGraph(graphRaw);
  if (mission.missionId !== graph.missionId) {
    throw new Error(
      `Mission mismatch: ${mission.missionId} != ${graph.missionId}`,
    );
  }
  return {
    paths,
    mission,
    graph,
    contractHash: hashJson(missionRaw),
    graphHash: hashJson(graphRaw),
  };
}

export function ledgerHashInput(event: Omit<CommandEvidence, "entryHash">): string {
  return canonicalJson(event);
}

export function verifyLedger(control: LoadedControl): LedgerVerification {
  if (!existsSync(control.paths.ledger)) {
    return {
      valid: false,
      errors: ["Missing ledger.jsonl"],
      events: [],
      headHash: GENESIS_HASH,
    };
  }
  const lines = readFileSync(control.paths.ledger, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  const events: CommandEvidence[] = [];
  const errors: string[] = [];
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const parsed = parseCommandEvidence(JSON.parse(lines[index]) as unknown);
      const expectedSequence = index + 1;
      if (parsed.sequence !== expectedSequence) {
        errors.push(
          `Sequence mismatch at line ${expectedSequence}: ${parsed.sequence}`,
        );
      }
      if (parsed.previousHash !== previousHash) {
        errors.push(`Previous hash mismatch at line ${expectedSequence}`);
      }
      const { entryHash, ...withoutHash } = parsed;
      const expectedHash = sha256(ledgerHashInput(withoutHash));
      if (entryHash !== expectedHash) {
        errors.push(`Entry hash mismatch at line ${expectedSequence}`);
      }
      previousHash = entryHash;
      events.push(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Invalid ledger line ${index + 1}: ${message}`);
    }
  }
  if (existsSync(control.paths.ledgerHead)) {
    try {
      const head = readJson(control.paths.ledgerHead);
      if (
        typeof head !== "object" ||
        head === null ||
        !("headHash" in head) ||
        head.headHash !== previousHash ||
        !("entries" in head) ||
        head.entries !== events.length
      ) {
        errors.push("Ledger head does not match ledger contents");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Invalid ledger head: ${message}`);
    }
  } else if (events.length > 0) {
    errors.push("Missing ledger head for non-empty ledger");
  }
  return {
    valid: errors.length === 0,
    errors,
    events,
    headHash: previousHash,
  };
}

export interface CheckResultInput {
  taskId: string;
  check: AcceptanceCheck;
  inputHashBefore: string;
  inputHashAfter: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function appendCheckEvidence(
  control: LoadedControl,
  input: CheckResultInput,
): CommandEvidence {
  return withControlLock(control.paths, () => {
    const verification = verifyLedger(control);
    if (!verification.valid) {
      throw new Error(
        `Cannot append to invalid ledger: ${verification.errors.join("; ")}`,
      );
    }
    mkdirSync(control.paths.evidenceDir, { recursive: true });
    const sequence = verification.events.length + 1;
    const stdoutHash = sha256(input.stdout);
    const stderrHash = sha256(input.stderr);
    const timestamp = new Date().toISOString();
    const withoutHash: Omit<CommandEvidence, "entryHash"> = {
      sequence,
      timestamp,
      eventType: "check_run",
      taskId: input.taskId,
      checkId: input.check.id,
      contractHash: control.contractHash,
      graphHash: control.graphHash,
      inputHashBefore: input.inputHashBefore,
      inputHashAfter: input.inputHashAfter,
      stableInputs: input.inputHashBefore === input.inputHashAfter,
      command: {
        program: input.check.program,
        args: input.check.args,
        cwd: input.check.cwd,
      },
      result: {
        exitCode: input.exitCode,
        stdoutHash,
        stderrHash,
      },
      previousHash: verification.headHash,
    };
    const entryHash = sha256(ledgerHashInput(withoutHash));
    const event: CommandEvidence = { ...withoutHash, entryHash };
    const prefix = `${String(sequence).padStart(4, "0")}-${entryHash}`;
    writeFileSync(
      join(control.paths.evidenceDir, `${prefix}.stdout.log`),
      input.stdout,
      "utf8",
    );
    writeFileSync(
      join(control.paths.evidenceDir, `${prefix}.stderr.log`),
      input.stderr,
      "utf8",
    );
    appendFileSync(control.paths.ledger, `${canonicalJson(event)}\n`, "utf8");
    writeFileSync(
      control.paths.ledgerHead,
      `${JSON.stringify({ entries: sequence, headHash: entryHash }, null, 2)}\n`,
      "utf8",
    );
    return event;
  });
}

function withControlLock<T>(paths: ControlPaths, operation: () => T): T {
  mkdirSync(dirname(paths.lock), { recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(paths.lock, "wx");
  } catch {
    throw new Error(`Control state is locked: ${paths.lock}`);
  }
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    rmSync(paths.lock, { force: true });
  }
}

export function currentCheckInputHash(
  control: LoadedControl,
  check: AcceptanceCheck,
): string {
  return hashTrackedPaths(control.paths.root, check.trackedPaths);
}

export function evidenceLogPaths(
  control: LoadedControl,
  event: CommandEvidence,
): { stdout: string; stderr: string } {
  const prefix = `${String(event.sequence).padStart(4, "0")}-${event.entryHash}`;
  return {
    stdout: join(control.paths.evidenceDir, `${prefix}.stdout.log`),
    stderr: join(control.paths.evidenceDir, `${prefix}.stderr.log`),
  };
}
