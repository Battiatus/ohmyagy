import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { canonicalJson, sha256 } from "../ledger/canonical.js";
import { ProcessRunner } from "./process-runner.js";
import { defaultSecretScrubber } from "./secret-scrubber.js";
import { CapabilityResolver } from "./capability-resolver.js";
export class AgyDriver {
    executablePath;
    scrubber;
    processRunner;
    maxMemoryMb;
    constructor(options = {}) {
        this.executablePath = options.executablePath ?? AgyDriver.resolveAgyBinary();
        this.scrubber = options.secretScrubber ?? defaultSecretScrubber;
        this.processRunner = options.processRunner ?? ProcessRunner;
        this.maxMemoryMb = options.maxMemoryMb ?? 4096;
    }
    static resolveAgyBinary() {
        if (process.env.OMA_AGY_BIN && existsSync(process.env.OMA_AGY_BIN)) {
            return process.env.OMA_AGY_BIN;
        }
        const isWindows = process.platform === "win32";
        const candidates = isWindows
            ? ["agy.exe", "agy", "gemini.cmd", "gemini"]
            : ["agy", "gemini"];
        for (const bin of candidates) {
            try {
                const cmd = isWindows ? `where.exe "${bin}"` : `which "${bin}"`;
                const found = execSync(cmd, { encoding: "utf8" }).trim().split(/\r?\n/)[0];
                if (found && existsSync(found)) {
                    return found;
                }
            }
            catch {
                // Continue
            }
        }
        // Default fallback
        return isWindows ? "agy.exe" : "agy";
    }
    async invoke(options) {
        const resolvedCap = CapabilityResolver.resolve(options.persona, {
            modelOverride: options.modelOverride,
            effortOverride: options.reasoningEffort,
        });
        const args = this.buildCliArguments(options, resolvedCap);
        const processResult = await this.processRunner.execute({
            executable: this.executablePath,
            args,
            cwd: options.worktreeDir,
            env: options.env,
            timeoutMs: options.timeoutMs,
            maxMemoryMb: this.maxMemoryMb,
        });
        const rawStdout = processResult.stdout;
        const rawStderr = processResult.stderr;
        const scrubbedStdout = this.scrubber.scrub(rawStdout);
        const scrubbedStderr = this.scrubber.scrub(rawStderr);
        const stdoutHash = sha256(rawStdout);
        const scrubbedStdoutHash = sha256(scrubbedStdout);
        // Extraction & parsing du JSON structuré
        const { parsed, parseError } = this.extractStructuredOutput(rawStdout);
        // Classification du statut d'exécution
        let status;
        let errorMessage;
        if (processResult.timedOut || processResult.exitCode === 124 || processResult.exitCode === 143) {
            status = "timed_out";
            errorMessage = "Task execution timed out by watchdog.";
        }
        else if (processResult.exitCode === 137) {
            status = "oom_killed";
            errorMessage = "Process terminated due to out-of-memory limits.";
        }
        else if (processResult.exitCode === 255) {
            status = "fatal_crash";
            errorMessage = `Process failed to start or crashed: ${scrubbedStderr || processResult.stderr}`;
        }
        else if (processResult.exitCode !== 0) {
            status = "failed";
            errorMessage = `Process exited with non-zero code ${processResult.exitCode}: ${scrubbedStderr || "Task failed"}`;
        }
        else {
            if (parsed !== undefined) {
                status = "success";
            }
            else {
                status = "failed";
                errorMessage = `Process returned exit code 0 but failed to provide valid JSON output: ${parseError}`;
            }
        }
        const runId = options.runId ?? `run-${Date.now()}`;
        const rawReceipt = {
            runId,
            expertId: resolvedCap.expertId,
            model: resolvedCap.modelSlug,
            effort: resolvedCap.effort,
            sandbox: resolvedCap.sandbox,
            durationMs: processResult.durationMs,
            exitCode: processResult.exitCode,
            status,
            stdoutHash,
            scrubbedStdoutHash,
        };
        const receiptHash = sha256(canonicalJson(rawReceipt));
        const receipt = { ...rawReceipt, receiptHash };
        return {
            exitCode: processResult.exitCode,
            status,
            timedOut: processResult.timedOut || status === "timed_out",
            parsedOutput: parsed,
            rawStdout,
            rawStderr,
            scrubbedStdout,
            scrubbedStderr,
            stdoutHash,
            scrubbedStdoutHash,
            durationMs: processResult.durationMs,
            receipt,
            error: errorMessage,
        };
    }
    buildCliArguments(options, resolvedCap) {
        const cap = resolvedCap ??
            CapabilityResolver.resolve(options.persona, {
                modelOverride: options.modelOverride,
                effortOverride: options.reasoningEffort,
            });
        const args = [
            "-p",
            options.contractPrompt,
            "--agent",
            cap.agentName,
            "--model",
            cap.modelSlug,
            "--output-format",
            "json",
            "--add-dir",
            options.worktreeDir,
            "--effort",
            cap.effort,
            "--sandbox",
            options.sandboxMode ?? cap.sandbox,
        ];
        if (options.jsonSchemaPath) {
            args.push("--json-schema", options.jsonSchemaPath);
        }
        if (options.extraArgs && options.extraArgs.length > 0) {
            args.push(...options.extraArgs);
        }
        return args;
    }
    extractStructuredOutput(stdout) {
        if (!stdout || stdout.trim().length === 0) {
            return { parseError: "Empty stdout" };
        }
        const cleanStdout = stdout.replace(/\u001b\[[0-9;]*m/g, "").trim();
        try {
            const direct = JSON.parse(cleanStdout);
            return { parsed: direct };
        }
        catch {
            // Continue
        }
        const codeBlockMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(cleanStdout);
        if (codeBlockMatch && codeBlockMatch[1]) {
            try {
                const parsedCodeBlock = JSON.parse(codeBlockMatch[1].trim());
                return { parsed: parsedCodeBlock };
            }
            catch {
                // Continue
            }
        }
        const lines = cleanStdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        const jsonObjects = [];
        for (const line of lines) {
            if ((line.startsWith("{") && line.endsWith("}")) || (line.startsWith("[") && line.endsWith("]"))) {
                try {
                    const parsedLine = JSON.parse(line);
                    jsonObjects.push(parsedLine);
                }
                catch {
                    // Ignore non-json lines
                }
            }
        }
        if (jsonObjects.length > 0) {
            const terminalResult = jsonObjects
                .slice()
                .reverse()
                .find((obj) => typeof obj === "object" &&
                obj !== null &&
                (("type" in obj && (obj.type === "result" || obj.type === "completion")) ||
                    "status" in obj ||
                    "verdict" in obj));
            if (terminalResult) {
                return { parsed: terminalResult };
            }
            return { parsed: jsonObjects[jsonObjects.length - 1] };
        }
        const firstBrace = cleanStdout.indexOf("{");
        const lastBrace = cleanStdout.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            const candidate = cleanStdout.substring(firstBrace, lastBrace + 1);
            try {
                const parsed = JSON.parse(candidate);
                return { parsed };
            }
            catch (err) {
                return {
                    parseError: `Failed to parse extracted JSON candidate: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
        }
        return { parseError: "No valid JSON structure found in output" };
    }
}
