import { spawn } from "node:child_process";

/**
 * Best-effort parent identity.
 *
 * The question the probe exists to answer is "which process spawned this server, and
 * does that process know a workspace?". Node cannot read another process's command
 * line, so this shells out. It is asynchronous, bounded and silent: the MCP handshake
 * must never wait for it, and a failure costs a data point, never a session.
 */

const TIMEOUT_MS = 5_000;
const MAX_OUTPUT_CHARS = 2_000;

export interface ParentProcessInfo {
  pid: number;
  commandLine?: string;
  error?: string;
}

export async function readParentProcessInfo(pid = process.ppid): Promise<ParentProcessInfo> {
  const commandLine = await readCommandLine(pid);
  return commandLine === undefined ? { pid, error: "unavailable" } : { pid, commandLine };
}

export function readCommandLine(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(undefined);
  const command =
    process.platform === "win32"
      ? {
          program: "powershell.exe",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
          ],
        }
      : { program: "ps", args: ["-o", "args=", "-p", String(pid)] };

  return new Promise<string | undefined>((settle) => {
    let child;
    try {
      child = spawn(command.program, command.args, {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      settle(undefined);
      return;
    }

    let output = "";
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      settle(value);
    };
    const timer = setTimeout(() => finish(undefined), TIMEOUT_MS);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString("utf8");
    });
    child.on("error", () => finish(undefined));
    child.on("close", () => {
      const trimmed = output.trim();
      finish(trimmed.length === 0 ? undefined : trimmed.slice(0, MAX_OUTPUT_CHARS));
    });
  });
}

/** Absolute paths that a command line or an environment value happens to contain. */
export function absolutePathsIn(text: string): string[] {
  const found = new Set<string>();
  const windowsPattern = /[A-Za-z]:[\\/][^"'\s;|&<>()]*/gu;
  const posixPattern = /\/(?:[^"'\s;|&<>()]+\/?)+/gu;
  for (const pattern of process.platform === "win32" ? [windowsPattern, posixPattern] : [posixPattern]) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[0].replace(/[.,;:]+$/u, "");
      if (candidate.length > 3) found.add(candidate);
    }
  }
  return [...found];
}
