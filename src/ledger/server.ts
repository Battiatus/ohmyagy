import { generateKeyPairSync, sign } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { canonicalJson, hashJson, hashTrackedPaths, sha256 } from "../control/canonical.js";
import { executeCheck } from "../control/cli.js";
import {
  type AcceptanceCheck,
  type MissionTask,
  isRecord,
  parseMissionContract,
  parseTaskGraph,
} from "../control/model.js";
import { GENESIS_HASH } from "../control/store.js";
import type {
  AuthorityHead,
  AuthorityMetadata,
  SignedCommandEvidence,
} from "./model.js";
import { signedEventHashInput, verifySignedLedger } from "./verify.js";

interface ServerConfig {
  workspaceRoot: string;
  stateDir: string;
  missionPath: string;
  graphPath: string;
}

function main(): void {
  try {
    const config = parseArgs(process.argv.slice(2));
    const server = initializeServer(config);
    send({
      type: "ready",
      authorityId: server.metadata.authorityId,
      contractHash: server.metadata.contractHash,
      graphHash: server.metadata.graphHash,
      head: server.head,
    });
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let id = "unknown";
      try {
        const request = JSON.parse(line) as unknown;
        if (!isRecord(request)) {
          throw new Error("Request must be an object");
        }
        if (typeof request.id === "string") {
          id = request.id;
        }
        const method = request.method;
        if (method === "run_check") {
          const taskId = requireString(request, "taskId");
          const checkId = requireString(request, "checkId");
          const event = server.runCheck(taskId, checkId);
          send({ id, ok: true, event });
          return;
        }
        if (method === "snapshot") {
          send({ id, ok: true, snapshot: server.snapshot() });
          return;
        }
        if (method === "shutdown") {
          send({ id, ok: true });
          lines.close();
          process.stdin.destroy();
          return;
        }
        throw new Error(`Unsupported authority method: ${String(method)}`);
      } catch (error) {
        send({ id, ok: false, error: messageOf(error) });
      }
    });
  } catch (error) {
    send({ type: "fatal", error: messageOf(error) });
    process.exitCode = 1;
  }
}

function initializeServer(config: ServerConfig) {
  const workspaceRoot = resolve(config.workspaceRoot);
  const stateDir = resolve(config.stateDir);
  assertExternalStateDir(workspaceRoot, stateDir);
  if (existsSync(stateDir) && readdirSync(stateDir).length > 0) {
    throw new Error(`Authority state directory is not empty: ${stateDir}`);
  }
  mkdirSync(stateDir, { recursive: true });
  const missionRaw = readJson(config.missionPath);
  const graphRaw = readJson(config.graphPath);
  const mission = parseMissionContract(missionRaw);
  const graph = parseTaskGraph(graphRaw);
  if (mission.missionId !== graph.missionId) {
    throw new Error("Mission and graph ids differ");
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const metadata: AuthorityMetadata = {
    schemaVersion: 1,
    authorityId: sha256(publicDer),
    publicKey: publicDer.toString("base64"),
    missionId: mission.missionId,
    contractHash: hashJson(missionRaw),
    graphHash: hashJson(graphRaw),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(stateDir, "authority.json"), `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  writeFileSync(join(stateDir, "mission.json"), `${canonicalJson(missionRaw)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  writeFileSync(join(stateDir, "task-graph.json"), `${canonicalJson(graphRaw)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  writeFileSync(join(stateDir, "ledger.jsonl"), "", { encoding: "utf8", flag: "wx" });
  const head: AuthorityHead = { entries: 0, headHash: GENESIS_HASH };
  writeFileSync(join(stateDir, "head.json"), `${JSON.stringify(head, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  mkdirSync(join(stateDir, "evidence"));

  const verifyDisk = (): void => {
    const verification = verifySignedLedger(stateDir, metadata.authorityId, {
      authorityId: metadata.authorityId,
      ...head,
    });
    if (!verification.valid) {
      throw new Error(`Authority disk state was modified: ${verification.errors.join("; ")}`);
    }
  };
  const runCheck = (taskId: string, checkId: string): SignedCommandEvidence => {
    verifyDisk();
    const { task, check } = resolveCheck(graph.tasks, taskId, checkId);
    assertDependenciesAccepted(graph.tasks, task, stateDir, metadata.authorityId, workspaceRoot);
    const inputHashBefore = hashTrackedPaths(workspaceRoot, check.trackedPaths);
    const result = executeCheck(workspaceRoot, check);
    const inputHashAfter = hashTrackedPaths(workspaceRoot, check.trackedPaths);
    const sequence = head.entries + 1;
    const unsigned = {
      sequence,
      timestamp: new Date().toISOString(),
      eventType: "check_run" as const,
      taskId,
      checkId,
      contractHash: metadata.contractHash,
      graphHash: metadata.graphHash,
      inputHashBefore,
      inputHashAfter,
      stableInputs: inputHashBefore === inputHashAfter,
      command: { program: check.program, args: check.args, cwd: check.cwd },
      result: {
        exitCode: result.exitCode,
        stdoutHash: sha256(result.stdout),
        stderrHash: sha256(result.stderr),
      },
      previousHash: head.headHash,
      authorityId: metadata.authorityId,
    };
    const entryHash = sha256(signedEventHashInput(unsigned));
    const event: SignedCommandEvidence = {
      ...unsigned,
      entryHash,
      signature: sign(null, Buffer.from(entryHash, "hex"), privateKey).toString("base64"),
    };
    const prefix = `${String(sequence).padStart(4, "0")}-${entryHash}`;
    writeFileSync(join(stateDir, "evidence", `${prefix}.stdout.log`), result.stdout, "utf8");
    writeFileSync(join(stateDir, "evidence", `${prefix}.stderr.log`), result.stderr, "utf8");
    appendFileSync(join(stateDir, "ledger.jsonl"), `${canonicalJson(event)}\n`, "utf8");
    head.entries = sequence;
    head.headHash = entryHash;
    writeFileSync(join(stateDir, "head.json"), `${JSON.stringify(head, null, 2)}\n`, "utf8");
    verifyDisk();
    return event;
  };
  return {
    metadata,
    head,
    runCheck,
    snapshot: () => {
      verifyDisk();
      return { metadata, head: { ...head } };
    },
  };
}

function assertDependenciesAccepted(
  tasks: MissionTask[],
  target: MissionTask,
  stateDir: string,
  authorityId: string,
  workspaceRoot: string,
): void {
  const verification = verifySignedLedger(stateDir, authorityId);
  if (!verification.valid) {
    throw new Error("Cannot derive dependencies from invalid authority ledger");
  }
  const accepted = new Set<string>();
  for (const task of tasks) {
    if (task.id === target.id) {
      break;
    }
    const dependenciesAccepted = task.dependencies.every((id) => accepted.has(id));
    const checksPassed = task.acceptanceChecks.every((check) => {
      const latest = verification.events
        .filter((event) => event.taskId === task.id && event.checkId === check.id)
        .at(-1);
      return (
        latest !== undefined &&
        latest.result.exitCode === 0 &&
        latest.stableInputs &&
        latest.inputHashAfter === hashTrackedPaths(workspaceRoot, check.trackedPaths)
      );
    });
    if (dependenciesAccepted && checksPassed && task.acceptanceChecks.length > 0) {
      accepted.add(task.id);
    }
  }
  const missing = target.dependencies.filter((id) => !accepted.has(id));
  if (missing.length > 0) {
    throw new Error(`Task dependencies are not accepted: ${missing.join(", ")}`);
  }
}

function resolveCheck(
  tasks: MissionTask[],
  taskId: string,
  checkId: string,
): { task: MissionTask; check: AcceptanceCheck } {
  const task = tasks.find((candidate) => candidate.id === taskId);
  const check = task?.acceptanceChecks.find((candidate) => candidate.id === checkId);
  if (!task || !check) {
    throw new Error(`Check is not registered in frozen graph: ${taskId}/${checkId}`);
  }
  return { task, check };
}

function parseArgs(args: string[]): ServerConfig {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Invalid authority server arguments");
    }
    values.set(key.slice(2), value);
  }
  return {
    workspaceRoot: requiredArg(values, "workspace"),
    stateDir: requiredArg(values, "state"),
    missionPath: requiredArg(values, "mission"),
    graphPath: requiredArg(values, "graph"),
  };
}

function assertExternalStateDir(workspaceRoot: string, stateDir: string): void {
  const fromWorkspace = relative(workspaceRoot, stateDir);
  if (fromWorkspace.length === 0 || (!fromWorkspace.startsWith("..") && !isAbsolute(fromWorkspace))) {
    throw new Error("Authority state must be outside the agent workspace");
  }
}

function requiredArg(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) {
    throw new Error(`Missing --${key}`);
  }
  return value;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty ${key}`);
  }
  return value;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main();
