import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface ProcessSpawnOptions {
  /** Nom de l'exécutable ou chemin absolu (ex: "agy", "node", "git") */
  executable: string;
  /** Arguments de la ligne de commande */
  args: string[];
  /** Répertoire de travail pour l'exécution */
  cwd: string;
  /** Variables d'environnement fusionnées avec process.env */
  env?: Record<string, string>;
  /** Données optionnelles à injecter dans l'entrée standard (stdin) */
  stdinInput?: string | Buffer | Uint8Array;
  /** Délai d'expiration maximal en millisecondes avant abattage (0 = pas de timeout) */
  timeoutMs?: number;
  /**
   * Recorded for callers, **not enforced**: no memory ceiling is applied today. It used
   * to be wired to a Windows Job Object that killed the child instead of limiting it,
   * so treating it as a guarantee is wrong in both directions.
   */
  maxMemoryMb?: number;
  /** Plafond de taille en octets pour la capture de stdout/stderr (défaut: 10 Mo) */
  maxBufferBytes?: number;
  /** Callback optionnel recevant les fragments stdout au fil de l'eau */
  onStdoutChunk?: (chunk: string) => void;
  /** Callback optionnel recevant les fragments stderr au fil de l'eau */
  onStderrChunk?: (chunk: string) => void;
  /** Scrubber optionnel appliqué en direct sur les chunks et les sorties finales */
  scrubber?: { scrub(text: string): string };
  /** Masquage de la fenêtre console sous Windows (défaut: true) */
  windowsHide?: boolean;
}

export interface ProcessRunResult {
  /** Code de retour (0 = succès, 124 = timeout watchdog, 1..255 = erreur/signal) */
  exitCode: number;
  /** Sortie standard capturée (assainie par le scrubber si configuré) */
  stdout: string;
  /** Sortie d'erreur capturée (assainie par le scrubber si configuré) */
  stderr: string;
  /** Durée exacte d'exécution en millisecondes */
  durationMs: number;
  /** Indique si le processus a été interrompu par le watchdog de timeout */
  timedOut: boolean;
  /** Indique si le processus a été abattu de force (timeout, annulation ou OOM) */
  killed: boolean;
  /** Signal POSIX ayant causé la terminaison le cas échéant (ex: "SIGKILL") */
  signal?: NodeJS.Signals | null;
}

const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

export class ProcessRunner {
  /**
   * Exécute un processus de manière bornée avec confinement physique et watchdog.
   */
  public static async execute(options: ProcessSpawnOptions): Promise<ProcessRunResult> {
    const isWindows = process.platform === "win32";
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

    return new Promise((resolve) => {
      let timedOut = false;
      let killed = false;
      let stdoutAccumulator = "";
      let stderrAccumulator = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let childSignal: NodeJS.Signals | null = null;

      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");

      let child: ChildProcess;
      try {
        child = spawn(options.executable, options.args, {
          cwd: options.cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          // Sous POSIX, un nouveau process group est créé (setsid)
          detached: !isWindows,
          windowsHide: options.windowsHide ?? true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (spawnError) {
        const errorMsg = spawnError instanceof Error ? spawnError.message : String(spawnError);
        const durationMs = Date.now() - startTime;
        return resolve({
          exitCode: 255,
          stdout: "",
          stderr: `Failed to spawn process '${options.executable}': ${errorMsg}`,
          durationMs,
          timedOut: false,
          killed: true,
          signal: null,
        });
      }

      const pid = child.pid;

      // No Windows Job Object here. The previous implementation created a job with
      // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE from a fire-and-forget PowerShell process
      // that exited immediately, so the last job handle closed within a few hundred
      // milliseconds and Windows terminated the child with exit code 0 and no output.
      // Every AgyDriver invocation therefore looked like a successful run that produced
      // nothing (measured 2026-09-14: ProcessRunner returned exitCode 0, empty stdout
      // and empty stderr in 593 ms for an argv that exits 1 with a JSON error under
      // spawnSync). The memory limit it was meant to apply was never implemented -- the
      // parameter was unused -- so the mechanism could only cause harm.

      // Armement du Watchdog de Timeout
      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(async () => {
          timedOut = true;
          killed = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignorer si déjà clos
          }
          await ProcessRunner.terminateTree(pid, isWindows);
        }, timeoutMs);
      }

      // Gestion de l'écriture Stdin
      if (child.stdin) {
        child.stdin.on("error", () => {
          // Absorbe EPIPE si le sous-processus ferme stdin avant consommation
        });

        if (options.stdinInput !== undefined) {
          child.stdin.write(options.stdinInput);
          child.stdin.end();
        } else {
          child.stdin.end();
        }
      }

      // Capture et Streaming Stdout
      if (child.stdout) {
        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > maxBufferBytes) {
            if (!stdoutTruncated) {
              stdoutTruncated = true;
              const text = stdoutDecoder.write(chunk);
              const scrubbed = options.scrubber ? options.scrubber.scrub(text) : text;
              stdoutAccumulator += scrubbed + "\n[OMA WARNING: stdout truncated at max buffer limit]";
              options.onStdoutChunk?.(scrubbed);
            }
            return;
          }
          const text = stdoutDecoder.write(chunk);
          const scrubbed = options.scrubber ? options.scrubber.scrub(text) : text;
          stdoutAccumulator += scrubbed;
          options.onStdoutChunk?.(scrubbed);
        });
      }

      // Capture et Streaming Stderr
      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          stderrBytes += chunk.length;
          if (stderrBytes > maxBufferBytes) {
            if (!stderrTruncated) {
              stderrTruncated = true;
              const text = stderrDecoder.write(chunk);
              const scrubbed = options.scrubber ? options.scrubber.scrub(text) : text;
              stderrAccumulator += scrubbed + "\n[OMA WARNING: stderr truncated at max buffer limit]";
              options.onStderrChunk?.(scrubbed);
            }
            return;
          }
          const text = stderrDecoder.write(chunk);
          const scrubbed = options.scrubber ? options.scrubber.scrub(text) : text;
          stderrAccumulator += scrubbed;
          options.onStderrChunk?.(scrubbed);
        });
      }

      child.on("error", async (err) => {
        if (timer) clearTimeout(timer);
        killed = true;
        await ProcessRunner.terminateTree(pid, isWindows);
        const durationMs = Date.now() - startTime;
        resolve({
          exitCode: 255,
          stdout: stdoutAccumulator + stdoutDecoder.end(),
          stderr: `${stderrAccumulator}${stderrDecoder.end()}\nFailed to spawn process '${options.executable}': ${err.message}`,
          durationMs,
          timedOut: false,
          killed: true,
          signal: null,
        });
      });

      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        childSignal = signal;

        stdoutAccumulator += stdoutDecoder.end();
        stderrAccumulator += stderrDecoder.end();

        let finalExitCode: number;
        if (timedOut) {
          finalExitCode = 124; // Code d'expiration standard POSIX timeout
          if (!stderrAccumulator.includes("timed out")) {
            stderrAccumulator += `\n[OMA ERROR: Process timed out after ${timeoutMs}ms]`;
          }
        } else if (code !== null && code < 0) {
          finalExitCode = 255;
          if (!stderrAccumulator.includes("Failed to spawn process")) {
            stderrAccumulator += `\nFailed to spawn process '${options.executable}' (errno: ${code})`;
          }
        } else if (code !== null) {
          finalExitCode = code;
        } else if (signal === "SIGKILL") {
          finalExitCode = 137;
        } else if (signal === "SIGTERM") {
          finalExitCode = 143;
        } else {
          finalExitCode = 1;
        }

        const durationMs = Date.now() - startTime;
        resolve({
          exitCode: finalExitCode,
          stdout: stdoutAccumulator,
          stderr: stderrAccumulator,
          durationMs,
          timedOut,
          killed: killed || timedOut,
          signal: childSignal,
        });
      });
    });
  }

  /**
   * Abat de manière déterministe et irrévocable l'arborescence complète des processus.
   */
  public static async terminateTree(pid: number | undefined, isWindows: boolean): Promise<void> {
    if (!pid || pid <= 0) return;

    if (isWindows) {
      try {
        // taskkill /F /T détruit le PID et tous ses descendants
        spawnSync("taskkill", ["/F", "/T", "/PID", pid.toString()], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        // Ignorer si déjà clos
      }
    } else {
      try {
        // Envoi de SIGTERM au groupe de processus (-pid)
        process.kill(-pid, "SIGTERM");
      } catch {
        // Processus déjà mort
        return;
      }

      // Attente brève puis envoi de SIGKILL si persistant
      await new Promise((r) => setTimeout(r, 200));
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Déjà terminé
      }
    }
  }

}
