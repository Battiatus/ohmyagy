import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
export class ProcessRunner {
    /**
     * Exécute un processus de manière bornée avec confinement physique et watchdog.
     */
    static async execute(options) {
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
            let childSignal = null;
            const stdoutDecoder = new StringDecoder("utf8");
            const stderrDecoder = new StringDecoder("utf8");
            let child;
            try {
                child = spawn(options.executable, options.args, {
                    cwd: options.cwd,
                    env: options.env ? { ...process.env, ...options.env } : process.env,
                    // Sous POSIX, detached: true crée un process group (setsid)
                    detached: !isWindows,
                    windowsHide: options.windowsHide ?? true,
                    stdio: ["pipe", "pipe", "pipe"],
                });
            }
            catch (spawnError) {
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
            // Configuration Job Object sous Windows
            if (isWindows && pid) {
                ProcessRunner.assignToWindowsJobObject(pid, options.maxMemoryMb);
            }
            // Armement du Watchdog de Timeout
            let timer = null;
            if (timeoutMs > 0) {
                timer = setTimeout(async () => {
                    timedOut = true;
                    killed = true;
                    try {
                        child.kill("SIGKILL");
                    }
                    catch {
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
                }
                else {
                    child.stdin.end();
                }
            }
            // Capture et Streaming Stdout
            if (child.stdout) {
                child.stdout.on("data", (chunk) => {
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
                child.stderr.on("data", (chunk) => {
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
                if (timer)
                    clearTimeout(timer);
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
                if (timer)
                    clearTimeout(timer);
                childSignal = signal;
                stdoutAccumulator += stdoutDecoder.end();
                stderrAccumulator += stderrDecoder.end();
                let finalExitCode;
                if (timedOut) {
                    finalExitCode = 124; // Code d'expiration standard POSIX timeout
                    if (!stderrAccumulator.includes("timed out")) {
                        stderrAccumulator += `\n[OMA ERROR: Process timed out after ${timeoutMs}ms]`;
                    }
                }
                else if (code !== null && code < 0) {
                    finalExitCode = 255;
                    if (!stderrAccumulator.includes("Failed to spawn process")) {
                        stderrAccumulator += `\nFailed to spawn process '${options.executable}' (errno: ${code})`;
                    }
                }
                else if (code !== null) {
                    finalExitCode = code;
                }
                else if (signal === "SIGKILL") {
                    finalExitCode = 137;
                }
                else if (signal === "SIGTERM") {
                    finalExitCode = 143;
                }
                else {
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
    static async terminateTree(pid, isWindows) {
        if (!pid || pid <= 0)
            return;
        if (isWindows) {
            try {
                // taskkill /F /T détruit le PID et tous ses descendants
                spawnSync("taskkill", ["/F", "/T", "/PID", pid.toString()], {
                    windowsHide: true,
                    stdio: "ignore",
                });
            }
            catch {
                // Ignorer si déjà clos
            }
        }
        else {
            try {
                // Envoi de SIGTERM au groupe de processus (-pid)
                process.kill(-pid, "SIGTERM");
            }
            catch {
                // Processus déjà mort
                return;
            }
            // Attente brève puis envoi de SIGKILL si persistant
            await new Promise((r) => setTimeout(r, 200));
            try {
                process.kill(-pid, "SIGKILL");
            }
            catch {
                // Déjà terminé
            }
        }
    }
    /**
     * Rapprochement et assignation du processus au Job Object sous Windows.
     */
    static assignToWindowsJobObject(pid, _maxMemoryMb) {
        try {
            // Commande PowerShell P/Invoke inline configurant KillOnJobClose
            const psScript = `
        $code = @'
        using System;
        using System.Runtime.InteropServices;
        public class JobHelper {
            [DllImport("kernel32.dll", SetLastError=true)]
            public static extern IntPtr CreateJobObject(IntPtr a, string n);
            [DllImport("kernel32.dll", SetLastError=true)]
            public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
            [DllImport("kernel32.dll", SetLastError=true)]
            public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
            [DllImport("kernel32.dll", SetLastError=true)]
            public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint len);
            [StructLayout(LayoutKind.Sequential)]
            public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
                public long PerProcessUserTimeLimit;
                public long PerJobUserTimeLimit;
                public uint LimitFlags;
                public UIntPtr MinimumWorkingSetSize;
                public UIntPtr MaximumWorkingSetSize;
                public uint ActiveProcessLimit;
                public UIntPtr Affinity;
                public uint PriorityClass;
                public uint SchedulingClass;
            }
            [StructLayout(LayoutKind.Sequential)]
            public struct IO_COUNTERS { public ulong r1,r2,r3,r4,r5,r6; }
            [StructLayout(LayoutKind.Sequential)]
            public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
                public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic;
                public IO_COUNTERS Io;
                public UIntPtr ProcessMemoryLimit;
                public UIntPtr JobMemoryLimit;
                public UIntPtr PeakProcessMemoryUsed;
                public UIntPtr PeakJobMemoryUsed;
            }
            public static bool Configure(int targetPid) {
                IntPtr hJob = CreateJobObject(IntPtr.Zero, null);
                if (hJob == IntPtr.Zero) return false;
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                ext.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                IntPtr pExt = Marshal.AllocHGlobal(size);
                try {
                    Marshal.StructureToPtr(ext, pExt, false);
                    if (!SetInformationJobObject(hJob, 9, pExt, (uint)size)) return false;
                } finally {
                    Marshal.FreeHGlobal(pExt);
                }
                IntPtr hProc = OpenProcess(0x1F0FFF, false, targetPid);
                if (hProc == IntPtr.Zero) return false;
                return AssignProcessToJobObject(hJob, hProc);
            }
        }
'@
        Add-Type -TypeDefinition $code -Language CSharp
        [JobHelper]::Configure(${pid})
      `;
            spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
                windowsHide: true,
                stdio: "ignore",
                detached: true,
            }).unref();
        }
        catch {
            // En cas d'indisponibilité de PowerShell, le mécanisme taskkill en fallback reste actif
        }
    }
}
