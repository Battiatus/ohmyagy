import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AcceptanceCheck, MissionTask } from "./model.js";
import {
  appendCheckEvidence,
  currentCheckInputHash,
  loadControl,
} from "./store.js";
import { deriveSnapshot, nextRunnableTask } from "./status.js";
import { authorityHandoffFromEnvironment } from "../resume/reconstruct.js";

export function runControlCli(args: string[], root = process.cwd()): number {
  const command = args[0] ?? "status";
  try {
    if (command === "handoff-authority") {
      const handoff = authorityHandoffFromEnvironment(root);
      console.log(JSON.stringify(handoff, null, 2));
      return handoff.ledgerValid ? 0 : 1;
    }
    const control = loadControl(root);
    if (command === "status" || command === "handoff") {
      const snapshot = deriveSnapshot(control);
      const json = args.includes("--json") || command === "handoff";
      if (json) {
        console.log(
          JSON.stringify(
            {
              mission: {
                id: control.mission.missionId,
                status: control.mission.status,
                executionGate: control.mission.executionGate,
                goal: control.mission.goal,
              },
              ...snapshot,
              nextTask: nextRunnableTask(snapshot) ?? null,
              bootstrapTrust: {
                mode: "detect-only",
                limitation:
                  "The ledger is still inside the agent-writable workspace until LEDGER-001 is accepted.",
              },
            },
            null,
            2,
          ),
        );
      } else {
        printHumanStatus(control.mission.goal, snapshot);
      }
      return snapshot.ledgerValid ? 0 : 1;
    }
    if (command === "verify") {
      const snapshot = deriveSnapshot(control);
      const gateReady =
        control.mission.status === "ready" &&
        control.mission.executionGate === "allowed" &&
        control.mission.acceptanceCriteria.length > 0;
      const valid = gateReady && snapshot.ledgerValid;
      console.log(
        JSON.stringify(
          {
            valid,
            gateReady,
            contractHash: snapshot.contractHash,
            graphHash: snapshot.graphHash,
            ledgerHead: snapshot.ledgerHead,
            ledgerErrors: snapshot.ledgerErrors,
          },
          null,
          2,
        ),
      );
      return valid ? 0 : 1;
    }
    if (command === "next") {
      const snapshot = deriveSnapshot(control);
      console.log(JSON.stringify(nextRunnableTask(snapshot) ?? null, null, 2));
      return snapshot.ledgerValid ? 0 : 1;
    }
    if (command === "run-check") {
      const taskId = args[1];
      const checkId = args[2];
      if (!taskId || !checkId) {
        throw new Error("Usage: oma control run-check <task-id> <check-id>");
      }
      const { task, check } = resolveCheck(control.graph.tasks, taskId, checkId);
      const inputHashBefore = currentCheckInputHash(control, check);
      const result = executeCheck(root, check);
      const inputHashAfter = currentCheckInputHash(control, check);
      const event = appendCheckEvidence(control, {
        taskId: task.id,
        check,
        inputHashBefore,
        inputHashAfter,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      if (result.stdout.length > 0) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr.length > 0) {
        process.stderr.write(result.stderr);
      }
      console.log(
        JSON.stringify(
          {
            evidenceHash: event.entryHash,
            stableInputs: event.stableInputs,
            exitCode: event.result.exitCode,
          },
          null,
          2,
        ),
      );
      return result.exitCode === 0 && event.stableInputs ? 0 : 1;
    }
    printControlHelp();
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`OMA control error: ${message}`);
    return 1;
  }
}

function resolveCheck(
  tasks: MissionTask[],
  taskId: string,
  checkId: string,
): { task: MissionTask; check: AcceptanceCheck } {
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`Unknown task: ${taskId}`);
  }
  const check = task.acceptanceChecks.find(
    (candidate) => candidate.id === checkId,
  );
  if (!check) {
    throw new Error(`Unknown check ${taskId}/${checkId}`);
  }
  return { task, check };
}

export interface ExecutedCheck {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function executeCheck(root: string, check: AcceptanceCheck): ExecutedCheck {
  const resolved = resolveCheckCommand(check);
  const result = spawnSync(resolved.program, resolved.args, {
    cwd: resolve(root, check.cwd),
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const spawnError = result.error?.message;
  const stderr = `${result.stderr ?? ""}${spawnError ? `${spawnError}\n` : ""}`;
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr,
  };
}

export function resolveCheckCommand(check: AcceptanceCheck): {
  program: string;
  args: string[];
} {
  if (process.platform !== "win32" || check.program !== "npm") {
    return { program: check.program, args: check.args };
  }
  const npmCli = join(
    dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (!existsSync(npmCli)) {
    throw new Error(`Unable to resolve npm CLI entrypoint at ${npmCli}`);
  }
  return {
    program: process.execPath,
    args: [npmCli, ...check.args],
  };
}

function printHumanStatus(
  goal: string,
  snapshot: ReturnType<typeof deriveSnapshot>,
): void {
  console.log(`Mission: ${goal}`);
  console.log(`Ledger: ${snapshot.ledgerValid ? "valid" : "INVALID"}`);
  for (const task of snapshot.tasks) {
    console.log(`${task.id}\t${task.status}\t${task.title}`);
  }
  const next = nextRunnableTask(snapshot);
  console.log(`Next: ${next ? `${next.id} - ${next.title}` : "none"}`);
  console.log(
    "Trust boundary: detect-only bootstrap; ledger authority is not isolated yet.",
  );
}

function printControlHelp(): void {
  console.log(`OMA control commands:
  oma control status [--json]
  oma control handoff
  oma control handoff-authority
  oma control verify
  oma control next
  oma control run-check <task-id> <check-id>`);
}
