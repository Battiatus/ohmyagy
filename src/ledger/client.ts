import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline";
import { isRecord } from "../control/model.js";
import type { AuthorityHead, SignedCommandEvidence } from "./model.js";
import { parseSignedEvidence } from "./verify.js";

export interface AuthorityServerConfig {
  workspaceRoot: string;
  stateDir: string;
  missionPath: string;
  graphPath: string;
}

export interface AuthorityReady {
  authorityId: string;
  contractHash: string;
  graphHash: string;
  head: AuthorityHead;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class AuthorityClient {
  readonly authorityId: string;
  readonly contractHash: string;
  readonly graphHash: string;
  readonly initialHead: AuthorityHead;
  private sequence = 0;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    lines: Interface,
    ready: AuthorityReady,
  ) {
    this.authorityId = ready.authorityId;
    this.contractHash = ready.contractHash;
    this.graphHash = ready.graphHash;
    this.initialHead = ready.head;
    lines.on("line", (line) => this.handleLine(line));
    child.on("exit", (code) => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error(`Authority process exited with code ${String(code)}`));
      }
      this.pending.clear();
    });
  }

  async runCheck(taskId: string, checkId: string): Promise<SignedCommandEvidence> {
    const response = await this.request("run_check", { taskId, checkId });
    if (!isRecord(response) || !("event" in response)) {
      throw new Error("Authority returned malformed run_check response");
    }
    return parseSignedEvidence(response.event);
  }

  snapshot(): Promise<unknown> {
    return this.request("snapshot");
  }

  request(method: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Authority request timed out: ${method}`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ id, method, ...fields })}\n`);
    });
  }

  async shutdown(): Promise<void> {
    const exited = this.child.exitCode === null
      ? new Promise<void>((resolve) => this.child.once("exit", () => resolve()))
      : Promise.resolve();
    await this.request("shutdown");
    this.child.stdin.end();
    await exited;
  }

  private handleLine(line: string): void {
    let response: unknown;
    try {
      response = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isRecord(response) || typeof response.id !== "string") {
      return;
    }
    const request = this.pending.get(response.id);
    if (!request) {
      return;
    }
    clearTimeout(request.timeout);
    this.pending.delete(response.id);
    if (response.ok === true) {
      request.resolve(response);
      return;
    }
    request.reject(new Error(typeof response.error === "string" ? response.error : "Authority error"));
  }
}

export async function startAuthorityServer(
  config: AuthorityServerConfig,
): Promise<AuthorityClient> {
  const serverPath = fileURLToPath(new URL("./server.js", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      serverPath,
      "--workspace",
      config.workspaceRoot,
      "--state",
      config.stateDir,
      "--mission",
      config.missionPath,
      "--graph",
      config.graphPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ready = await new Promise<AuthorityReady>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Authority startup timed out")), 20_000);
    const onLine = (line: string): void => {
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        return;
      }
      if (!isRecord(message)) {
        return;
      }
      if (message.type === "fatal") {
        clearTimeout(timeout);
        lines.off("line", onLine);
        reject(new Error(typeof message.error === "string" ? message.error : stderr));
        return;
      }
      if (message.type === "ready") {
        clearTimeout(timeout);
        lines.off("line", onLine);
        resolve(parseReady(message));
      }
    };
    lines.on("line", onLine);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Authority exited during startup (${String(code)}): ${stderr}`));
    });
  });
  return new AuthorityClient(child, lines, ready);
}

function parseReady(input: Record<string, unknown>): AuthorityReady {
  const head = input.head;
  if (
    typeof input.authorityId !== "string" ||
    typeof input.contractHash !== "string" ||
    typeof input.graphHash !== "string" ||
    !isRecord(head) ||
    !Number.isInteger(head.entries) ||
    typeof head.headHash !== "string"
  ) {
    throw new Error("Malformed authority ready response");
  }
  return {
    authorityId: input.authorityId,
    contractHash: input.contractHash,
    graphHash: input.graphHash,
    head: { entries: Number(head.entries), headHash: head.headHash },
  };
}
