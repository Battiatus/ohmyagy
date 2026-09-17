import { createInterface } from "node:readline";
import { captureEnvironment, captureProcessIdentity, appendProbeRecord, isRecord, type ProbeTarget } from "./log.js";
import { probeMcpLogDir } from "./paths.js";
import { readParentProcessInfo } from "./process-info.js";

/**
 * Probe MCP server: what does the host actually hand a session-scoped server?
 *
 * This is a *fake* OMA broker. It answers `initialize`, `tools/list` and `tools/call`
 * well enough to keep a real session healthy, and it writes down everything else:
 *
 *  * its own `cwd`, `argv`, full environment and parent command line — the channels a
 *    per-window spawn would use to state a project;
 *  * the `initialize` parameters verbatim, `clientInfo` and `capabilities` included —
 *    the only handshake field that could carry a session identity;
 *  * whether `roots/list` is answered, with what, and after how long;
 *  * every later message, including any `_meta` a tool call might carry;
 *  * a heartbeat, so overlapping server lifetimes show whether the host spawns one
 *    server per project window or one for the whole editor.
 *
 * It never refuses, never blocks and never throws.
 */

const HEARTBEAT_MS = 5_000;
const ROOTS_TIMEOUT_MS = 5_000;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface ProbeServerOptions {
  /** Injected for tests; defaults to `~/.oma-probe/mcp`. */
  logDir?: string;
  /** Injected for tests; defaults to the real parent lookup. */
  parentLookup?: (pid: number) => Promise<{ pid: number; commandLine?: string }>;
  env?: NodeJS.ProcessEnv;
}

export function startProbeMcpServer(options: ProbeServerOptions = {}): void {
  const target: ProbeTarget = {
    dir: options.logDir ?? probeMcpLogDir(),
    file: `${process.pid}.jsonl`,
  };
  const record = (kind: string, data: unknown): void => appendProbeRecord(target, kind, data);

  const environment = captureEnvironment(options.env ?? process.env);
  record("process_start", {
    ...captureProcessIdentity(),
    envKeys: environment.keys,
    env: environment.values,
  });

  // Parent identity is the channel a per-window spawn would use: an editor helper
  // launched for one workspace usually carries that workspace on its command line.
  const parentLookup = options.parentLookup ?? readParentProcessInfo;
  void parentLookup(process.ppid)
    .then((info) => record("parent_process", info))
    .catch(() => record("parent_process", { pid: process.ppid, error: "lookup-failed" }));

  const heartbeat = setInterval(() => record("heartbeat", { pid: process.pid }), HEARTBEAT_MS);
  heartbeat.unref();

  let exited = false;
  const recordExit = (): void => {
    if (exited) return;
    exited = true;
    record("process_exit", { pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) });
  };
  process.on("exit", recordExit);

  const pendingReplies = new Map<string | number, (message: JsonRpcMessage) => void>();
  let rootsSeq = 0;
  let lastRootsRoots: string[] = [];

  const write = (message: unknown): void => {
    record("stdout", message);
    try {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    } catch {
      // A closed stdout is the host leaving; the exit record is written separately.
    }
  };

  const requestRoots = async (reason: string): Promise<void> => {
    rootsSeq += 1;
    const id = `oma-probe-roots-${rootsSeq}`;
    const startedAt = Date.now();
    const answer = new Promise<JsonRpcMessage>((settle) => pendingReplies.set(id, settle));
    write({ jsonrpc: "2.0", id, method: "roots/list" });
    record("roots_request", { id, reason });

    const expired = new Promise<undefined>((settle) => {
      const timer = setTimeout(() => settle(undefined), ROOTS_TIMEOUT_MS);
      timer.unref();
    });
    const reply = await Promise.race([answer, expired]);
    pendingReplies.delete(id);

    if (reply === undefined) {
      record("roots_reply", { id, reason, answered: false, elapsedMs: Date.now() - startedAt });
      return;
    }
    const roots = rootsOf(reply);
    lastRootsRoots = roots;
    record("roots_reply", {
      id,
      reason,
      answered: true,
      elapsedMs: Date.now() - startedAt,
      rootCount: roots.length,
      roots,
      raw: reply.result ?? reply.error ?? null,
    });
  };

  const handle = (message: JsonRpcMessage): void => {
    if (message.method === undefined) {
      // A reply to one of our own requests.
      if (message.id !== undefined) {
        const settle = pendingReplies.get(message.id);
        if (settle !== undefined) {
          pendingReplies.delete(message.id);
          settle(message);
        }
      }
      return;
    }

    if (message.method === "initialize") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: negotiate(message.params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: { name: "oma-probe", version: "1.0.0" },
        },
      });
      const capabilities = isRecord(message.params?.capabilities) ? message.params.capabilities : {};
      if (isRecord(capabilities.roots)) {
        void requestRoots("after-initialize");
      } else {
        record("roots_skipped", { reason: "client advertised no roots capability", capabilities });
      }
      return;
    }

    if (message.method === "tools/list") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "oma_probe_ping",
              description:
                "OMA session-identity probe. Returns this MCP server instance's identity; read-only and side-effect free.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      });
      return;
    }

    if (message.method === "tools/call") {
      // The second roots attempt answers "does the host only answer once the session is
      // really running?", which the handshake-time attempt cannot.
      if (rootsSeq > 0 && lastRootsRoots.length === 0) {
        void requestRoots("after-first-tool-call");
      }
      const payload = {
        pid: process.pid,
        cwd: process.cwd(),
        argv: process.argv,
        rootsSeen: lastRootsRoots,
        probe: true,
      };
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: false,
        },
      });
      return;
    }

    if (message.method === "ping") {
      write({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }

    // Notifications carry no id and expect no answer.
    if (message.id === undefined) return;
    write({ jsonrpc: "2.0", id: message.id, result: {} });
  };

  const readline = createInterface({ input: process.stdin, terminal: false });
  let queue: Promise<void> = Promise.resolve();
  readline.on("line", (line) => {
    if (line.trim().length === 0) return;
    record("stdin_raw", line);
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      record("stdin_unparsed", { line, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    record("stdin", message);
    queue = queue.then(() => handle(message)).catch((error: unknown) => {
      record("handler_error", { error: error instanceof Error ? error.message : String(error) });
    });
  });
}

function rootsOf(message: JsonRpcMessage): string[] {
  if (!isRecord(message.result)) return [];
  const { roots } = message.result;
  if (!Array.isArray(roots)) return [];
  const paths: string[] = [];
  for (const entry of roots) {
    if (!isRecord(entry)) continue;
    const uri = entry.uri;
    if (typeof uri === "string") paths.push(uri);
    else if (typeof entry.path === "string") paths.push(entry.path);
  }
  return paths;
}

function negotiate(requested: unknown): string {
  const supported = new Set(["2024-11-05", "2025-06-18"]);
  return typeof requested === "string" && supported.has(requested) ? requested : "2025-06-18";
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("mcp-probe-server.js") || process.argv[1].endsWith("mcp-probe-server.ts"))
) {
  startProbeMcpServer();
}
