import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgyDriver } from "./agy-driver.js";
import { readBindAttempts, type BindAttempt } from "../brain/workspace-registry.js";
import { HOOK_EVENT_EVIDENCE, validateHooksFile } from "../packaging/hook-contract.js";

export interface DoctorReport {
  timestamp: string;
  os: string;
  architecture: string;
  agyCli: {
    available: boolean;
    path?: string;
    version?: string;
    supportedFlags: string[];
    error?: string;
    diagnostics: string[];
  };
  bunCli: {
    available: boolean;
    path?: string;
    version?: string;
  };
  gitCli: {
    available: boolean;
    path?: string;
    version?: string;
  };
  nodeCli: {
    available: boolean;
    path?: string;
    version?: string;
  };
  pluginDiscovery: {
    installed: boolean;
    pluginPath?: string;
    valid: boolean;
    agentsDetected: string[];
    skillsDetected: string[];
    declaredAgents: string[];
    declaredSkills: string[];
    diagnostics: string[];
  };
  /**
   * Which directory this instance believes it governs, and why. Reported because
   * the wrong answer is otherwise silent, and it invalidates every other line of
   * this report: a healthy broker pointed at the editor's own install tree
   * attests to a workspace no user asked about.
   */
  workspace: WorkspaceReport;
  /**
   * The most recent attempts to bind a workspace, newest first.
   *
   * A session that governed the wrong project left no evidence once it ended, which made the one
   * question that matters — does this host answer `roots/list`? — unanswerable after the fact.
   */
  bindHistory: BindAttempt[];
  /**
   * Layered attestation: installed != loaded != tested.
   * `pluginDiscovery.valid` above is a static file-existence check and stays for
   * backward compatibility; it says nothing about whether AGY accepted the hooks,
   * whether the MCP server answers, or which `oma` binary actually ran.
   */
  attestation: AttestationReport;
}

export interface WorkspaceReport {
  /** Absolute path this instance treats as the workspace root. */
  root: string;
  /** How the root was chosen. Only the first two are explicit. */
  source: "OMA_WORKSPACE_ROOT" | "roots/list" | "argument" | "process.cwd";
  /**
   * Files that identify this root as an editor installation tree rather than a
   * project. Deliberately not a "does this look like a project" check: a real
   * workspace may carry no marker at all, so only an unambiguous install
   * signature is treated as proof of the wrong target.
   */
  installTreeMarkers: string[];
  /**
   * True whenever the governed root is an editor installation tree. Measured
   * 2026-09-11: AntiGravity spawns stdio MCP servers with cwd set to
   * `%LOCALAPPDATA%\Programs\antigravity`, so `OMA_WORKSPACE_ROOT || process.cwd()`
   * silently made the editor's own install directory the governed workspace.
   * Verified again 2026-09-14: that install tree held the only populated brain —
   * one `projects` row, named "antigravity", holding both the Symap mission and an
   * unrelated session from another workspace.
   *
   * Reported for every source, including an explicit pin: the editor install tree
   * is never a valid OMA workspace, whichever way it was chosen. Callers must treat
   * this as a failure, not a warning.
   */
  governsEditorInstall: boolean;
}

export interface HookFileAttestation {
  path: string;
  exists: boolean;
  /**
   * AGY 1.2.1 loads plugin hooks from the per-user config store
   * (`~/.gemini/config/plugins/<name>`), not from a workspace
   * `.agents/plugins/<name>` copy. Recorded so a green workspace install is not
   * mistaken for a loaded one.
   */
  runtimeLoadsFromHere: boolean;
  valid: boolean;
  hookNames: string[];
  events: string[];
  unprovenEvents: string[];
  problems: string[];
  parseError?: string;
}

export interface McpProbeAttestation {
  ok: boolean;
  serverPath?: string;
  serverName?: string;
  protocolVersion?: string;
  toolCount?: number;
  missingTools: string[];
  /**
   * Problems in the JSON-RPC handshake itself. The broker used to answer
   * `resources/list` with `id: null` and a parse-error code, which made AGY
   * abandon the server so no OMA tool ever reached the session — while a naive
   * `initialize` + `tools/list` probe still passed. The probe therefore replays
   * the real client sequence.
   */
  handshakeProblems: string[];
  error?: string;
}

export interface AttestationReport {
  install: { ok: boolean; pluginPath?: string };
  loaded: {
    ok: boolean;
    globalPluginDir: string;
    workspacePluginDir: string;
    hookFiles: HookFileAttestation[];
    runtimeHookRejections: string[];
    diagnostics: string[];
  };
  tested: {
    ok: boolean;
    mcp: McpProbeAttestation;
    diagnostics: string[];
  };
  invocation: {
    /** First `oma` executable found walking PATH; not necessarily the one a given shell resolves. */
    firstOnPath?: string;
    shims: Array<{ path: string; modifiedAt: string }>;
    diagnostics: string[];
  };
}

/** Tools the session conductor cannot do without. */
const REQUIRED_MCP_TOOLS = [
  "graph_init",
  "graph_apply",
  "graph_mark_node",
  "graph_ready_nodes",
  "graph_inspect",
  "plan_route",
  "converge_step",
  "converge_status",
  "graph_replan",
  "brain_store",
  "brain_query",
  "brain_summarize",
  "mission_status",
  "list_missions",
  "propose_change",
  "attest_review",
  "promote_change",
];

export class OmaDoctor {
  public static diagnoseEnvironment(
    workspaceRoot = process.cwd(),
    workspaceSource?: WorkspaceReport["source"],
  ): DoctorReport {
    const isWindows = process.platform === "win32";

    // 1. Detect Git
    let gitInfo = { available: false, path: undefined as string | undefined, version: undefined as string | undefined };
    try {
      const gitRes = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 1000 });
      if (gitRes.status === 0 && gitRes.stdout) {
        gitInfo = { available: true, path: "git", version: gitRes.stdout.trim() };
      }
    } catch {}

    // 2. Detect Bun
    let bunInfo = { available: false, path: undefined as string | undefined, version: undefined as string | undefined };
    try {
      const bunRes = spawnSync("bun", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 1000 });
      if (bunRes.status === 0 && bunRes.stdout) {
        bunInfo = { available: true, path: "bun", version: bunRes.stdout.trim() };
      }
    } catch {}

    // 3. Detect Node
    let nodeInfo = { available: false, path: undefined as string | undefined, version: undefined as string | undefined };
    try {
      nodeInfo = { available: true, path: process.execPath, version: process.version };
    } catch {}

    // 4. Detect AntiGravity (agy / agy.exe / gemini)
    let agyInfo: DoctorReport["agyCli"] = {
      available: false,
      supportedFlags: [],
      diagnostics: [],
    };

    const resolvedAgy = AgyDriver.resolveAgyBinary();
    if (resolvedAgy && existsSync(resolvedAgy) && isActualAgyExecutable(resolvedAgy)) {
      agyInfo.path = resolvedAgy;
      try {
        const verProc = spawnSync(resolvedAgy, ["--version"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5_000,
        });
        if (verProc.status === 0 && verProc.stdout.trim()) {
          agyInfo.version = verProc.stdout.trim();
        } else {
          agyInfo.diagnostics.push(`agy --version failed: ${String(verProc.stderr ?? "").trim() || `exit ${String(verProc.status)}`}`);
        }
      } catch {
        agyInfo.diagnostics.push("agy --version could not be executed");
      }

      try {
        const helpProc = spawnSync(resolvedAgy, ["--help"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5_000,
        });
        if (helpProc.status === 0) {
          const helpOut = `${helpProc.stdout ?? ""}\n${helpProc.stderr ?? ""}`;
          const flags = ["--agent", "-p", "--output-format", "--effort", "--add-dir", "--print-timeout", "--model", "--mode", "--new-project"];
          agyInfo.supportedFlags = flags.filter((flag) => helpOut.includes(flag));
          const missingFlags = flags.filter((flag) => !agyInfo.supportedFlags.includes(flag));
          if (missingFlags.length > 0) {
            agyInfo.diagnostics.push(`agy --help is missing required flags: ${missingFlags.join(", ")}`);
          }
        } else {
          agyInfo.diagnostics.push(`agy --help failed: ${String(helpProc.stderr ?? "").trim() || `exit ${String(helpProc.status)}`}`);
        }
      } catch {
        agyInfo.diagnostics.push("agy --help could not be executed");
      }
    } else {
      agyInfo.error = `Resolved AntiGravity executable is unavailable or not agy.exe: ${resolvedAgy}`;
    }

    agyInfo.available = Boolean(agyInfo.path && existsSync(agyInfo.path) && !agyInfo.error);

    // 5. Plugin Discovery & Live AGY Attestation
    const pluginDir = join(workspaceRoot, ".agents", "plugins", "oma");
    const pluginInstalled = existsSync(pluginDir);
    const agentsDetected: string[] = [];
    const skillsDetected: string[] = [];
    const declaredAgents: string[] = [];
    const declaredSkills: string[] = [];
    const diagnostics: string[] = [];
    const coreAgentsRequired = [
      "orchestrator",
      "planner",
      "explorer",
      "executor",
      "reviewer",
      "verifier",
    ];

    if (pluginInstalled) {
      const pluginJsonPath = join(pluginDir, "plugin.json");
      if (!existsSync(pluginJsonPath)) {
        diagnostics.push("plugin.json missing in installed plugin directory");
      }

      const agentsDir = join(pluginDir, "agents");
      if (existsSync(agentsDir)) {
        try {
          for (const f of readdirSync(agentsDir).filter((file: string) => file.endsWith(".md"))) {
            const name = f.replace(/\.md$/, "");
            if (!declaredAgents.includes(name)) declaredAgents.push(name);
          }
        } catch {}
      }

      const skillsDir = join(pluginDir, "skills");
      if (existsSync(skillsDir)) {
        try {
          for (const s of readdirSync(skillsDir)) {
            if (!declaredSkills.includes(s)) declaredSkills.push(s);
          }
        } catch {}
      }

      for (const req of coreAgentsRequired) {
        const isPresent =
          declaredAgents.includes(req) ||
          (req === "executor" && declaredAgents.includes("worker"));
        if (!isPresent) {
          diagnostics.push(`Core agent persona '${req}' is missing from the workspace plugin`);
        }
      }

      // Attest deployed agents in workspace (.agents/agents/{agent}/agent.md) or pluginDir
      const nativeAgentsDir = join(workspaceRoot, ".agents", "agents");
      for (const req of coreAgentsRequired) {
        const namesToCheck = req === "executor" ? ["executor", "worker"] : [req];
        const found = namesToCheck.some((name) => {
          const nativeFolder = join(nativeAgentsDir, name, "agent.md");
          const nativeFlat = join(nativeAgentsDir, `${name}.md`);
          const pluginFile = join(pluginDir, "agents", `${name}.md`);
          return existsSync(nativeFolder) || existsSync(nativeFlat) || existsSync(pluginFile);
        });
        if (found) {
          agentsDetected.push(req);
        } else {
          diagnostics.push(`Core agent persona '${req}' is missing from the workspace plugin`);
        }
      }

      // Attest deployed skills in workspace (.agents/skills/{skill}/SKILL.md) or pluginDir
      const nativeSkillsDir = join(workspaceRoot, ".agents", "skills");
      for (const skill of declaredSkills) {
        const nativeSkill = join(nativeSkillsDir, skill, "SKILL.md");
        const pluginSkill = join(pluginDir, "skills", skill, "SKILL.md");
        if (existsSync(nativeSkill) || existsSync(pluginSkill)) {
          skillsDetected.push(skill);
        }
      }
    } else {
      diagnostics.push("OMA plugin is not installed in workspace (.agents/plugins/oma)");
    }

    return {
      timestamp: new Date().toISOString(),
      os: `${process.platform} ${process.arch}`,
      architecture: process.arch,
      agyCli: agyInfo,
      bunCli: bunInfo,
      gitCli: gitInfo,
      nodeCli: nodeInfo,
      pluginDiscovery: {
        installed: pluginInstalled,
        pluginPath: pluginInstalled ? pluginDir : undefined,
        valid: pluginInstalled && diagnostics.length === 0 && agentsDetected.length >= coreAgentsRequired.length,
        agentsDetected: Array.from(new Set(agentsDetected)),
        skillsDetected: Array.from(new Set(skillsDetected)),
        declaredAgents: Array.from(new Set(declaredAgents)),
        declaredSkills: Array.from(new Set(declaredSkills)),
        diagnostics,
      },
      workspace: describeWorkspace(workspaceRoot, workspaceSource),
      // Whether the host answers `roots/list` decides which project a session governs, and the
      // session is gone by the time anyone asks. These are the last few recorded attempts.
      bindHistory: readBindAttempts({ limit: 5 }),
      attestation: buildAttestationReport(workspaceRoot),
    };
  }
}

const EDITOR_INSTALL_MARKERS = [
  "Antigravity.exe",
  join("resources", "app"),
  "chrome_100_percent.pak",
] as const;

/**
 * Describe the governed workspace without guessing whether it is legitimate.
 * `OMA_WORKSPACE_ROOT`, an MCP `roots/list` answer and an explicit argument are
 * statements of intent; `process.cwd()` is an assumption, and in this host that
 * assumption resolves to the editor installation directory.
 *
 * `declaredSource` lets a caller that resolved the root itself (the MCP broker,
 * rebinding from the host's roots) report how, instead of having the choice
 * re-inferred from the environment.
 */
export function describeWorkspace(
  workspaceRoot: string = process.cwd(),
  declaredSource?: WorkspaceReport["source"],
): WorkspaceReport {
  const root = resolve(workspaceRoot);
  const envRoot = process.env.OMA_WORKSPACE_ROOT;
  const statesRoot =
    typeof envRoot === "string" && envRoot.length > 0 && samePath(resolve(envRoot), root);
  const isFallback = samePath(root, resolve(process.cwd()));
  const installTreeMarkers = EDITOR_INSTALL_MARKERS.filter((marker) =>
    existsSync(join(root, marker)),
  );
  const source: WorkspaceReport["source"] =
    declaredSource ??
    (statesRoot ? "OMA_WORKSPACE_ROOT" : isFallback ? "process.cwd" : "argument");

  return {
    root,
    source,
    installTreeMarkers: [...installTreeMarkers],
    governsEditorInstall: installTreeMarkers.length > 0,
  };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === "win32" ? resolve(value).toLocaleLowerCase("en-US") : resolve(value);
  return normalize(left) === normalize(right);
}

/** Best-effort removal; a locked temp directory must never fail a diagnosis. */
function safeRemoveDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // The OS will reap it.
  }
}

function isActualAgyExecutable(filePath: string): boolean {
  if (!filePath) return false;
  const name = basename(filePath).toLocaleLowerCase("en-US");
  if (process.platform === "win32") {
    return (
      name === "agy.exe" ||
      name === "agy.cmd" ||
      name === "gemini.cmd" ||
      name === "gemini.exe" ||
      name === "agy" ||
      name === "gemini"
    );
  }
  return name === "agy" || name === "gemini";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

interface JsonRpcLine {
  id?: unknown;
  result?: {
    serverInfo?: { name?: string };
    protocolVersion?: string;
    tools?: Array<{ name?: string }>;
  };
  error?: { code?: number; message?: string };
}

/** Per-user AGY config root. AGY loads plugin hooks from here, not from a workspace copy. */
function agyConfigRoot(): string {
  return join(homedir(), ".gemini", "config");
}

function agyLogDir(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "log");
}

function resolveBrokerServerPath(): string | undefined {
  const candidates = [
    fileURLToPath(new URL("../mcp/broker-server.js", import.meta.url)),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/src/mcp/broker-server.js"),
    fileURLToPath(new URL("../mcp/broker-server.ts", import.meta.url)),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function attestHookFile(path: string, runtimeLoadsFromHere: boolean): HookFileAttestation {
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      runtimeLoadsFromHere,
      valid: false,
      hookNames: [],
      events: [],
      unprovenEvents: [],
      problems: [],
    };
  }
  const verdict = validateHooksFile(path);
  const unprovenEvents = verdict.events.filter((event) => {
    const evidence = HOOK_EVENT_EVIDENCE.find((entry) => entry.event === event);
    return evidence !== undefined && !evidence.firingObserved;
  });
  return {
    path,
    exists: true,
    runtimeLoadsFromHere,
    valid: verdict.valid,
    hookNames: verdict.hookNames,
    events: verdict.events,
    unprovenEvents,
    problems: verdict.problems.map((problem) => `${problem.path || "<root>"}: ${problem.message}`),
    parseError: verdict.parseError,
  };
}

/**
 * Rejections the AGY runtime actually logged for one plugin.
 *
 * Only logs written at or after `sinceMs` count: a rejection recorded before the
 * current hooks.json was written describes a file that no longer exists, and
 * failing the attestation on it would make the check permanently red.
 */
function recentHookRejections(pluginName: string, sinceMs: number, logLimit = 8): string[] {
  const dir = agyLogDir();
  if (!existsSync(dir)) return [];
  let logs: string[];
  try {
    logs = readdirSync(dir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .filter((entry) => entry.mtime >= sinceMs)
      .sort((left, right) => right.mtime - left.mtime)
      .slice(0, logLimit)
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
  const needle = `Failed to parse hooks for plugin ${pluginName}`;
  const hits: string[] = [];
  for (const log of logs) {
    try {
      for (const line of readFileSync(log, "utf8").split(/\r?\n/u)) {
        if (line.includes(needle)) hits.push(line.trim());
      }
    } catch {
      // Unreadable or rotated log: skip rather than fail the diagnosis.
    }
  }
  return hits;
}

/**
 * Start the broker over stdio and assert the conductor's tool surface exists.
 * This is the only check that proves "the session can actually call OMA",
 * as opposed to "the file is on disk".
 */
function probeMcpServer(workspaceRoot: string): McpProbeAttestation {
  const serverPath = resolveBrokerServerPath();
  if (!serverPath) {
    return {
      ok: false,
      missingTools: [...REQUIRED_MCP_TOOLS],
      handshakeProblems: [],
      error: "broker-server build artifact not found; run the build before attesting.",
    };
  }

  // Replay the sequence a real MCP client performs. `initialize` + `tools/list`
  // alone is not enough: AGY also probes the resource and prompt surfaces during
  // the handshake, and an invalid reply to any of them makes it abandon the
  // server before a single tool is registered.
  const probeRequests: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [
    {
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "oma-doctor", version: "1.0.0" },
      },
    },
    { id: 2, method: "tools/list" },
    { id: 3, method: "ping" },
    { id: 4, method: "resources/list" },
    { id: 5, method: "prompts/list" },
    { id: 6, method: "logging/setLevel", params: { level: "info" } },
  ];
  const requests =
    probeRequests.map((probe) => JSON.stringify({ jsonrpc: "2.0", ...probe })).join("\n") + "\n";

  let stdout = "";
  let stderr = "";
  // Probe under a throwaway OMA home inside the workspace's own ignored `.oma/`. The
  // broker publishes the workspace it binds into the machine-wide registry, so an
  // unisolated probe writes the caller's workspace (in tests, a temp fixture) into the
  // developer's real `~/.oma`.
  const probeHome = mkdtempSync(join(tmpdir(), "oma-probe-home-"));
  try {
    const result = spawnSync(process.execPath, [serverPath], {
      input: requests,
      encoding: "utf8",
      timeout: 25_000,
      windowsHide: true,
      env: { ...process.env, OMA_WORKSPACE_ROOT: workspaceRoot, OMA_HOME: probeHome },
    });
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
  } catch (error) {
    safeRemoveDirectory(probeHome);
    return {
      ok: false,
      serverPath,
      missingTools: [...REQUIRED_MCP_TOOLS],
      handshakeProblems: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let serverName: string | undefined;
  let protocolVersion: string | undefined;
  const toolNames: string[] = [];
  const handshakeProblems: string[] = [];
  const answered = new Set<number>();
  let sawNullId = false;
  safeRemoveDirectory(probeHome);

  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let message: JsonRpcLine;
    try {
      message = JSON.parse(line) as JsonRpcLine;
    } catch {
      continue;
    }
    if (message.id === null || message.id === undefined) {
      sawNullId = true;
      continue;
    }
    const id = typeof message.id === "number" ? message.id : Number(message.id);
    if (!Number.isFinite(id)) continue;
    answered.add(id);

    if (id === 1 && message.result) {
      serverName = message.result.serverInfo?.name;
      protocolVersion = message.result.protocolVersion;
    }
    if (id === 2 && Array.isArray(message.result?.tools)) {
      for (const tool of message.result.tools) {
        if (typeof tool?.name === "string") toolNames.push(tool.name);
      }
    }
    if (id !== 1 && id !== 2 && message.error) {
      const probe = probeRequests.find((entry) => entry.id === id);
      handshakeProblems.push(
        `${probe?.method ?? `id ${id}`} was refused: ${message.error.message ?? "error"} (code ${message.error.code ?? "?"}). AGY abandons a server that refuses a handshake probe, so no tool would reach the session.`,
      );
    }
  }

  for (const probe of probeRequests) {
    if (!answered.has(probe.id)) {
      handshakeProblems.push(`${probe.method} got no response (id ${probe.id} unanswered).`);
    }
  }
  if (sawNullId) {
    handshakeProblems.push(
      "a response carried id=null, which the client cannot match to its request; a real client treats that as a protocol violation and closes the connection.",
    );
  }

  if (toolNames.length === 0) {
    return {
      ok: false,
      serverPath,
      serverName,
      protocolVersion,
      missingTools: [...REQUIRED_MCP_TOOLS],
      handshakeProblems,
      error:
        stderr.trim().slice(0, 400) ||
        "MCP handshake produced no tools/list response; the session would see zero OMA tools.",
    };
  }

  const missingTools = REQUIRED_MCP_TOOLS.filter((tool) => !toolNames.includes(tool));
  return {
    ok: missingTools.length === 0 && handshakeProblems.length === 0,
    serverPath,
    serverName,
    protocolVersion,
    toolCount: toolNames.length,
    missingTools,
    handshakeProblems,
  };
}

function detectOmaShims(): { shims: Array<{ path: string; modifiedAt: string }>; firstOnPath?: string } {
  const extensions = process.platform === "win32" ? ["cmd", "ps1", "exe", "bat", "com", ""] : [""];
  const separator = process.platform === "win32" ? ";" : ":";
  const shims: Array<{ path: string; modifiedAt: string }> = [];
  const seen = new Set<string>();
  for (const dir of (process.env.PATH ?? "").split(separator)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, extension ? `oma.${extension}` : "oma");
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let stats;
      try {
        stats = statSync(candidate);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      shims.push({ path: candidate, modifiedAt: new Date(stats.mtimeMs).toISOString() });
    }
  }
  return { shims, firstOnPath: shims[0]?.path };
}

function buildAttestationReport(workspaceRoot: string): AttestationReport {
  const globalPluginDir = join(agyConfigRoot(), "plugins", "oma");
  const workspacePluginDir = join(workspaceRoot, ".agents", "plugins", "oma");

  const hookFiles = [
    attestHookFile(join(globalPluginDir, "hooks.json"), true),
    attestHookFile(join(workspacePluginDir, "hooks.json"), false),
  ];
  const globalHooks = hookFiles[0];
  let hooksWrittenAtMs = 0;
  try {
    hooksWrittenAtMs = globalHooks.exists ? statSync(globalHooks.path).mtimeMs : 0;
  } catch {
    hooksWrittenAtMs = 0;
  }
  const runtimeHookRejections = recentHookRejections("oma", hooksWrittenAtMs);

  const loadedDiagnostics: string[] = [];
  if (!globalHooks.exists) {
    loadedDiagnostics.push(
      `No global plugin at ${globalPluginDir}. AGY loads plugin hooks only from the per-user config store, so a workspace-only install is never loaded.`,
    );
  } else if (!globalHooks.valid) {
    loadedDiagnostics.push(
      `AGY would discard every hook in ${globalHooks.path}: ${[...globalHooks.problems, globalHooks.parseError ?? ""]
        .filter((entry) => entry.length > 0)
        .join("; ")}`,
    );
  }
  if (globalHooks.unprovenEvents.length > 0) {
    loadedDiagnostics.push(
      `Hook event(s) accepted by the parser but never observed firing: ${globalHooks.unprovenEvents.join(", ")}. Validate them interactively before relying on them for capture.`,
    );
  }
  if (runtimeHookRejections.length > 0) {
    loadedDiagnostics.push(
      `The AGY runtime logged ${runtimeHookRejections.length} hook-parse rejection(s) for plugin 'oma' in the most recent logs; newest: ${runtimeHookRejections[0]}`,
    );
  }

  const mcp = probeMcpServer(workspaceRoot);
  const testedDiagnostics: string[] = [];
  if (!mcp.ok) {
    testedDiagnostics.push(
      mcp.error ??
        `Broker did not expose every required tool (missing: ${mcp.missingTools.join(", ")}).`,
    );
  }

  const invocation = detectOmaShims();
  const invocationDiagnostics: string[] = [];
  if (invocation.shims.length > 1) {
    invocationDiagnostics.push(
      `${invocation.shims.length} 'oma' executables are reachable on PATH; the first is ${invocation.firstOnPath}. A stale earlier build would run silently.`,
    );
  }

  const globalInstalled = existsSync(globalPluginDir);
  const workspaceInstalled = existsSync(workspacePluginDir);

  return {
    install: {
      ok: globalInstalled || workspaceInstalled,
      pluginPath: globalInstalled ? globalPluginDir : workspaceInstalled ? workspacePluginDir : undefined,
    },
    loaded: {
      ok: globalHooks.exists && globalHooks.valid && runtimeHookRejections.length === 0,
      globalPluginDir,
      workspacePluginDir,
      hookFiles,
      runtimeHookRejections,
      diagnostics: loadedDiagnostics,
    },
    tested: { ok: mcp.ok, mcp, diagnostics: testedDiagnostics },
    invocation: {
      firstOnPath: invocation.firstOnPath,
      shims: invocation.shims,
      diagnostics: invocationDiagnostics,
    },
  };
}
