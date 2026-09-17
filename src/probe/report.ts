import { writeFileSync } from "node:fs";
import { readProbeRecords, isRecord, stringField, numberField, type ProbeRecord } from "./log.js";
import { probeHookLogDir, probeMcpLogDir, probeReportPath } from "./paths.js";
import { absolutePathsIn } from "./process-info.js";

/**
 * Turn the probe's raw journals into the answer the architecture depends on.
 *
 * The report is deliberately split in two: the evidence, printed verbatim, and a
 * verdict derived from it. The verdict is a convenience — every fact it rests on is in
 * the evidence above it, because the previous session's failure was announcing a fix
 * from green tests rather than from a measurement.
 */

/** OS noise that would otherwise match a project-ish key name and drown the signal. */
const ENV_NOISE = new Set([
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PUBLIC",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);

const PROJECTISH_KEY = /WORKSPACE|PROJECT|ROOT|FOLDER|SESSION|CONVERSATION|WINDOW|CWD|PWD/i;

/**
 * The narrow key pattern that may count as project identity evidence.
 *
 * Nothing else qualifies: an environment variable is evidence only when the host
 * named it after a project or a workspace.
 */
const PROJECT_ENV_KEY = /WORKSPACE|PROJECT/i;

/** Methods the probe models. Anything else the host sends is reported, not swallowed. */
const MODELLED_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "tools/list",
  "tools/call",
  "ping",
]);

/**
 * Environment markers only a test runner sets.
 *
 * Recorded as *provenance*, not as an exclusion. OMA's test suite invokes the real
 * AntiGravity runtime (`agy`), whose own MCP client cold-spawns this server and replays
 * a discovery sequence — genuine host behaviour, observed from a test process. What must
 * never decide the verdict is OMA's own configuration appearing in that environment.
 */
const TEST_RUNNER_ENV_KEYS = ["BUN_TEST_WORKER_ID", "JEST_WORKER_ID", "VITEST", "NODE_TEST_CONTEXT"] as const;

/**
 * Variables OMA sets itself, in its installer, its tests and its operator pins.
 *
 * `OMA_WORKSPACE_ROOT` proves nothing about the host: it is the global pin whose
 * single-project limitation is the reason this probe exists. Reading it as "the server
 * instance carries a project signal" is how one leftover test fixture produced a
 * confident, wrong `host-environment` verdict on real data.
 */
const SELF_INFLICTED_ENV_KEY = /^OMA_/i;

export interface WorkspaceHint {
  key: string;
  value: string;
}

export interface RootsAttempt {
  id?: string;
  reason?: string;
  requestedAt: string;
  answered: boolean;
  elapsedMs?: number;
  rootCount?: number;
  roots: string[];
}

export interface ProbeMcpInstance {
  instance: string;
  pid: number;
  ppid?: number;
  cwd?: string;
  argv: string[];
  startedAt: string;
  lastSeenAt: string;
  exitedAt?: string;
  uptimeMs?: number;
  parentCommandLine?: string;
  parentPaths: string[];
  /** The full environment the host handed over, scrubbed. Diffed between instances. */
  env: Record<string, string>;
  envWorkspaceHints: WorkspaceHint[];
  initializeParams?: Record<string, unknown>;
  rootsAttempts: RootsAttempt[];
  toolCalls: { name?: string; hasMeta: boolean; paramKeys: string[] }[];
  notifications: string[];
  /** Distinct request methods the host sent, in first-seen order. */
  methods: string[];
  /**
   * The instance inherits a test-runner marker, so it was spawned by a test suite that
   * inherited OMA's own configuration, not by the editor. Kept as evidence, excluded from
   * the verdict — one `OMA_WORKSPACE_ROOT` left over from a broker test was enough to
   * announce `host-environment` for a host that states nothing.
   */
  spawnedByTestRunner: boolean;
  heartbeats: number;
}

export interface ProbeHookInvocation {
  at: string;
  pid?: number;
  ppid?: number;
  cwd?: string;
  event: string;
  conversationId?: string;
  workspacePaths: string[];
  hasWorkspacePaths: boolean;
  toolName?: string;
  toolCwd?: string;
  payloadKeys: string[];
  envWorkspaceHints: WorkspaceHint[];
}

export interface ProbeReport {
  generatedAt: string;
  logDirectory: string;
  mcp: {
    instanceCount: number;
    spawnModel: "none-observed" | "single-shared" | "per-window-with-cwd" | "per-window-indistinguishable" | "per-query-cold-spawn";
    spawnModelEvidence: string;
    distinctCwds: string[];
    overlappingLifetimes: boolean;
    /** Highest number of probe servers alive at the same instant. */
    concurrentPeak: number;
    /** Instances spawned while a test suite was running: provenance, not a verdict input. */
    testRunnerInstances: number;
    /** Median server lifetime, the signature of a cold spawn per query. */
    medianLifetimeMs: number;
    instances: ProbeMcpInstance[];
    rootsRequests: number;
    rootsAnswered: number;
    /** Answers that carried at least one root. An empty answer is not an answer here. */
    rootsAnsweredWithRoots: number;
    distinctRoots: string[];
    workspaceSignals: { pid: number; channel: string; value: string }[];
    /**
     * Environment variables whose *name* names a workspace or project, in any
     * instance. Deliberately narrower than `envWorkspaceHints`: a key merely
     * containing "ROOT" matches `COREPACK_ROOT`, `PLUGIN_ROOT` and `SYSTEMROOT`, and
     * reading one of those as project identity is the same guess that produced the
     * global workspace pin.
     */
    projectEnvSignals: { pid: number; key: string; value: string }[];
    /** `OMA_*` variables found in a server environment: OMA's configuration, not the host's statement. */
    selfInflictedEnvSignals: { pid: number; key: string; value: string }[];
    /** Request methods the probe did not model, e.g. a host-specific discovery call. */
    unknownMethods: string[];
    perInstanceEnvKeys: { key: string; values: string[] }[];
  };
  hooks: {
    invocationCount: number;
    byEvent: Record<string, { count: number; withWorkspacePaths: number }>;
    withWorkspacePaths: number;
    distinctWorkspaces: string[];
    distinctConversations: number;
    distinctCwds: string[];
    invocations: ProbeHookInvocation[];
  };
  correlation: {
    workspacesSeenByHooks: string[];
    workspacesSeenByMcp: string[];
    intersection: string[];
    conversationsWithWorkspace: number;
  };
  verdict: {
    channel: "host-roots" | "host-environment" | "hook-channel-only" | "no-channel";
    multiplexingRequired: boolean;
    statement: string;
    residualUnknowns: string[];
  };
  questions: { id: string; question: string; answer: string }[];
}

export interface BuildProbeReportOptions {
  homeDirectory?: string;
  now?: Date;
}

export function buildProbeReport(options: BuildProbeReportOptions = {}): ProbeReport {
  const mcpRecords = readProbeRecords(probeMcpLogDir(options.homeDirectory));
  const hookRecords = readProbeRecords(probeHookLogDir(options.homeDirectory));
  const instances = groupInstances(mcpRecords);
  const invocations = hookRecords
    .filter((record) => record.kind === "hook_invocation")
    .map(toInvocation);

  const distinctCwds = unique(instances.map((instance) => instance.cwd).filter(isString));
  const overlappingLifetimes = hasOverlap(instances);
  const concurrentPeak = peakConcurrency(instances);
  const { spawnModel, spawnModelEvidence } = classifySpawnModel(instances, distinctCwds, concurrentPeak);

  // Provenance only: instances spawned while a test suite ran are still host evidence —
  // the suite invokes the real runtime — they are simply not the editor.
  const testRunnerInstances = instances.filter((instance) => instance.spawnedByTestRunner).length;

  const allRoots = unique(instances.flatMap((instance) => instance.rootsAttempts.flatMap((attempt) => attempt.roots)));
  const rootsRequests = instances.reduce((total, instance) => total + instance.rootsAttempts.length, 0);
  const rootsAnswered = instances.reduce(
    (total, instance) => total + instance.rootsAttempts.filter((attempt) => attempt.answered).length,
    0,
  );
  // "Answered" and "answered with a root" are different facts, and the difference is the
  // whole finding: this host answers, politely, with an empty list.
  const rootsAnsweredWithRoots = instances.reduce(
    (total, instance) => total + instance.rootsAttempts.filter((attempt) => attempt.roots.length > 0).length,
    0,
  );

  // OMA's own variables are excluded: they are OMA's configuration, not the host naming a
  // project. Non-OMA workspace/project-named variables are genuine evidence.
  const projectEnvSignals = instances.flatMap((instance) =>
    Object.entries(instance.env)
      .filter(([key]) => PROJECT_ENV_KEY.test(key) && !SELF_INFLICTED_ENV_KEY.test(key))
      .map(([key, value]) => ({ pid: instance.pid, key, value })),
  );
  const selfInflictedEnvSignals = instances.flatMap((instance) =>
    Object.entries(instance.env)
      .filter(([key]) => SELF_INFLICTED_ENV_KEY.test(key))
      .map(([key, value]) => ({ pid: instance.pid, key, value })),
  );
  const unknownMethods = unique(
    instances
      .flatMap((instance) => instance.methods)
      .filter((method) => !MODELLED_METHODS.has(method)),
  );

  const workspaceSignals = instances.flatMap((instance) => [
    ...instance.envWorkspaceHints.map((hint) => ({ pid: instance.pid, channel: `env:${hint.key}`, value: hint.value })),
    ...instance.parentPaths.map((path) => ({ pid: instance.pid, channel: "parent-command-line", value: path })),
    ...instance.rootsAttempts.flatMap((attempt) =>
      attempt.roots.map((root) => ({ pid: instance.pid, channel: "roots/list", value: root })),
    ),
  ]);

  const hooksWithWorkspace = invocations.filter((invocation) => invocation.hasWorkspacePaths);
  const byEvent: Record<string, { count: number; withWorkspacePaths: number }> = {};
  for (const invocation of invocations) {
    const entry = (byEvent[invocation.event] ??= { count: 0, withWorkspacePaths: 0 });
    entry.count += 1;
    if (invocation.hasWorkspacePaths) entry.withWorkspacePaths += 1;
  }

  const workspacesSeenByHooks = unique(hooksWithWorkspace.flatMap((invocation) => invocation.workspacePaths));
  const workspacesSeenByMcp = unique([
    ...allRoots.map(fileUriToPath).filter(isString),
    ...workspaceSignals.map((signal) => signal.value).filter(looksLikeAbsolutePath),
  ]);
  const intersection = workspacesSeenByHooks.filter((workspace) =>
    workspacesSeenByMcp.some((candidate) => samePath(candidate, workspace)),
  );

  const verdict = decideVerdict({
    rootsAnsweredWithRoots,
    allRoots,
    projectEnvSignals,
    parentPaths: instances.flatMap((instance) =>
      instance.parentPaths.map((path) => ({ pid: instance.pid, value: path })),
    ),
    hooksWithWorkspace: hooksWithWorkspace.length,
    hookWorkspaces: workspacesSeenByHooks,
    spawnModel,
  });

  const perInstanceEnvKeys = differingEnvKeys(instances);

  const report: ProbeReport = {
    generatedAt: (options.now ?? new Date()).toISOString(),
    logDirectory: probeMcpLogDir(options.homeDirectory).replace(/[\\/]mcp$/u, ""),
    mcp: {
      instanceCount: instances.length,
      spawnModel,
      spawnModelEvidence,
      distinctCwds,
      overlappingLifetimes,
      concurrentPeak,
      testRunnerInstances,
      medianLifetimeMs: medianOf(
        instances
          .filter((instance) => instance.exitedAt !== undefined)
          .map((instance) => Date.parse(instance.exitedAt as string) - Date.parse(instance.startedAt))
          .filter((value) => Number.isFinite(value) && value >= 0),
      ),
      instances,
      rootsRequests,
      rootsAnswered,
      rootsAnsweredWithRoots,
      distinctRoots: allRoots,
      workspaceSignals,
      projectEnvSignals,
      selfInflictedEnvSignals,
      unknownMethods,
      perInstanceEnvKeys,
    },
    hooks: {
      invocationCount: invocations.length,
      byEvent,
      withWorkspacePaths: hooksWithWorkspace.length,
      distinctWorkspaces: workspacesSeenByHooks,
      distinctConversations: unique(invocations.map((invocation) => invocation.conversationId).filter(isString)).length,
      distinctCwds: unique(invocations.map((invocation) => invocation.cwd).filter(isString)),
      invocations,
    },
    correlation: {
      workspacesSeenByHooks,
      workspacesSeenByMcp,
      intersection,
      conversationsWithWorkspace: unique(hooksWithWorkspace.map((invocation) => invocation.conversationId).filter(isString)).length,
    },
    verdict,
    questions: [],
  };

  report.questions = answerQuestions(report);
  return report;
}

export function writeProbeReport(report: ProbeReport, homeDirectory?: string): string {
  const path = probeReportPath(homeDirectory);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

// --- instance grouping -------------------------------------------------------------------

function groupInstances(records: readonly ProbeRecord[]): ProbeMcpInstance[] {
  const byInstance = new Map<string, ProbeRecord[]>();
  for (const record of records) {
    const key = stringField(record.data, "__file") ?? "unknown";
    const bucket = byInstance.get(key);
    if (bucket === undefined) byInstance.set(key, [record]);
    else bucket.push(record);
  }

  const instances: ProbeMcpInstance[] = [];
  for (const [key, bucket] of byInstance) {
    const start = bucket.find((record) => record.kind === "process_start");
    const exit = bucket.find((record) => record.kind === "process_exit");
    const parent = bucket.find((record) => record.kind === "parent_process");
    const env = start !== undefined && isRecord(start.data.env) ? start.data.env : {};
    const parentCommandLine = parent !== undefined ? stringField(parent.data, "commandLine") : undefined;

    const rootsAttempts = matchRootsAttempts(bucket);
    const initialize = bucket.find((record) => record.kind === "stdin" && isRecord(record.data.params) && record.data.method === "initialize");

    instances.push({
      instance: key,
      pid: start !== undefined ? (numberField(start.data, "pid") ?? -1) : -1,
      ...optional("ppid", start !== undefined ? numberField(start.data, "ppid") : undefined),
      ...optional("cwd", start !== undefined ? stringField(start.data, "cwd") : undefined),
      argv: start !== undefined && Array.isArray(start.data.argv) ? (start.data.argv as string[]) : [],
      startedAt: start?.at ?? bucket[0]?.at ?? "",
      lastSeenAt: bucket[bucket.length - 1]?.at ?? "",
      ...optional("exitedAt", exit?.at),
      ...optional("uptimeMs", exit !== undefined ? numberField(exit.data, "uptimeMs") : undefined),
      ...optional("parentCommandLine", parentCommandLine),
      parentPaths: parentCommandLine === undefined ? [] : absolutePathsIn(parentCommandLine),
      env: stringRecord(env),
      envWorkspaceHints: envHints(env),
      ...optional("initializeParams", initialize !== undefined && isRecord(initialize.data.params) ? initialize.data.params : undefined),
      rootsAttempts,
      toolCalls: bucket
        .filter((record) => record.kind === "stdin" && record.data.method === "tools/call")
        .map((record) => {
          const params = isRecord(record.data.params) ? record.data.params : {};
          return {
            ...optional("name", typeof params.name === "string" ? params.name : undefined),
            hasMeta: params._meta !== undefined,
            paramKeys: Object.keys(params).sort(),
          };
        }),
      notifications: unique(
        bucket
          .filter((record) => record.kind === "stdin" && typeof record.data.method === "string")
          .map((record) => record.data.method as string)
          .filter((method) => method.startsWith("notifications/")),
      ),
      methods: unique(
        bucket
          .filter((record) => record.kind === "stdin" && typeof record.data.method === "string")
          .map((record) => record.data.method as string),
      ),
      spawnedByTestRunner: TEST_RUNNER_ENV_KEYS.some((key) => (env as Record<string, unknown>)[key] !== undefined),
      heartbeats: bucket.filter((record) => record.kind === "heartbeat").length,
    });
  }
  instances.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return instances;
}

function matchRootsAttempts(bucket: readonly ProbeRecord[]): RootsAttempt[] {
  const attempts: RootsAttempt[] = [];
  const byId = new Map<string, RootsAttempt>();
  for (const record of bucket) {
    if (record.kind === "roots_request") {
      const attempt: RootsAttempt = {
        ...optional("id", stringField(record.data, "id")),
        ...optional("reason", stringField(record.data, "reason")),
        requestedAt: record.at,
        answered: false,
        roots: [],
      };
      attempts.push(attempt);
      const id = stringField(record.data, "id");
      if (id !== undefined) byId.set(id, attempt);
      continue;
    }
    if (record.kind === "roots_reply") {
      const id = stringField(record.data, "id");
      const attempt = id !== undefined ? byId.get(id) : undefined;
      if (attempt === undefined) continue;
      attempt.answered = record.data.answered === true;
      attempt.elapsedMs = numberField(record.data, "elapsedMs");
      attempt.rootCount = numberField(record.data, "rootCount");
      attempt.roots = Array.isArray(record.data.roots)
        ? record.data.roots.filter((root): root is string => typeof root === "string")
        : [];
    }
  }
  return attempts;
}

function toInvocation(record: ProbeRecord): ProbeHookInvocation {
  const workspacePaths = Array.isArray(record.data.workspacePaths)
    ? record.data.workspacePaths.filter((entry): entry is string => typeof entry === "string")
    : [];
  const env = isRecord(record.data.envOfInterest) ? record.data.envOfInterest : {};
  return {
    at: record.at,
    ...optional("pid", numberField(record.data, "pid")),
    ...optional("ppid", numberField(record.data, "ppid")),
    ...optional("cwd", stringField(record.data, "cwd")),
    event: stringField(record.data, "event") ?? "unknown",
    ...optional("conversationId", stringField(record.data, "conversationId")),
    workspacePaths,
    hasWorkspacePaths: workspacePaths.length > 0,
    ...optional("toolName", stringField(record.data, "toolName")),
    ...optional("toolCwd", stringField(record.data, "toolCwd")),
    payloadKeys: Array.isArray(record.data.payloadKeys)
      ? record.data.payloadKeys.filter((key): key is string => typeof key === "string")
      : [],
    envWorkspaceHints: envHints(env),
  };
}

// --- derivations -------------------------------------------------------------------------

function envHints(env: Record<string, unknown>): WorkspaceHint[] {
  const hints: WorkspaceHint[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (ENV_NOISE.has(key.toUpperCase())) continue;
    if (!PROJECTISH_KEY.test(key)) continue;
    hints.push({ key, value });
  }
  hints.sort((left, right) => left.key.localeCompare(right.key));
  return hints;
}

/**
 * Environment keys whose value is not the same across every instance.
 *
 * This is the sharpest single question in the measurement: if the host spawns one server
 * per project window, something must differ between the instances. A key that is present
 * only once, or carries a different value, is a candidate channel.
 */
function differingEnvKeys(instances: readonly ProbeMcpInstance[]): { key: string; values: string[] }[] {
  if (instances.length < 2) return [];
  const envByInstance = instances.map((instance) => instanceEnv(instance));
  const result: { key: string; values: string[] }[] = [];
  const keys = unique(envByInstance.flatMap((env) => env.keys));
  for (const key of keys) {
    const values = envByInstance.map((env) => env.values[key] ?? "<absent>");
    if (unique(values).length > 1) {
      result.push({ key, values });
    }
  }
  return result.sort((left, right) => left.key.localeCompare(right.key));
}

function instanceEnv(instance: ProbeMcpInstance): { keys: string[]; values: Record<string, string> } {
  return { keys: Object.keys(instance.env), values: instance.env };
}

function hasOverlap(instances: readonly ProbeMcpInstance[]): boolean {
  return peakConcurrency(instances) > 1;
}

/**
 * Highest number of probe servers alive at the same instant.
 *
 * The spawn model turns on this number, not on the instance count: the editor may spawn
 * one server per query and kill it, which produces many instances and a peak of one, or
 * hold several open at once, which is a completely different contract. Exits are applied
 * before starts at an identical timestamp so a handoff never reads as an overlap.
 */
function peakConcurrency(instances: readonly ProbeMcpInstance[]): number {
  interface Edge {
    at: string;
    delta: number;
  }
  const edges: Edge[] = [];
  for (const instance of instances) {
    edges.push({ at: instance.startedAt, delta: 1 });
    edges.push({ at: instance.exitedAt ?? instance.lastSeenAt, delta: -1 });
  }
  edges.sort((left, right) => (left.at === right.at ? left.delta - right.delta : left.at.localeCompare(right.at)));
  let current = 0;
  let peak = 0;
  for (const edge of edges) {
    current += edge.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

function classifySpawnModel(
  instances: readonly ProbeMcpInstance[],
  distinctCwds: readonly string[],
  concurrentPeak: number,
): { spawnModel: ProbeReport["mcp"]["spawnModel"]; spawnModelEvidence: string } {
  if (instances.length === 0) {
    return {
      spawnModel: "none-observed",
      spawnModelEvidence:
        "No probe MCP server ever started. Either the host did not load the probe plugin (check 'oma probe status' and the host logs) or the host was never restarted after the probe install.",
    };
  }
  if (instances.length === 1) {
    return {
      spawnModel: "single-shared",
      spawnModelEvidence: `One probe server (pid ${instances[0].pid}) served the whole measurement, so every project window shares one server process.`,
    };
  }
  if (distinctCwds.length > 1) {
    return {
      spawnModel: "per-window-with-cwd",
      spawnModelEvidence: `${instances.length} probe servers with ${distinctCwds.length} distinct working directories: ${distinctCwds.join(" | ")}. A per-window spawn is visible and carries its own cwd.`,
    };
  }

  // Cold spawn per query: many short-lived servers, one at a time, each started to answer
  // a discovery and then killed. Measured on this host as `server/discover` -> `initialize`
  // -> `tools/list` -> exit in about two seconds. This is neither "one shared server" nor
  // "one per window": there is no process whose lifetime a project could be attached to.
  const lifetimes = instances
    .filter((instance) => instance.exitedAt !== undefined)
    .map((instance) => Date.parse(instance.exitedAt as string) - Date.parse(instance.startedAt))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const median = medianOf(lifetimes);
  // A peak of two is a handoff between two query servers, not a shared session: the point
  // of the classification is that no process outlives a single query.
  if (lifetimes.length > 0 && median <= COLD_SPAWN_MAX_MS && concurrentPeak <= 2) {
    return {
      spawnModel: "per-query-cold-spawn",
      spawnModelEvidence: `${instances.length} probe servers, median lifetime ${(median / 1000).toFixed(1)}s, peak concurrency ${concurrentPeak}: each is started to answer one discovery and then killed. No process outlives a single query, so no project identity can be attached to a server lifetime.`,
    };
  }
  return {
    spawnModel: "per-window-indistinguishable",
    spawnModelEvidence: `${instances.length} probe servers all sharing the same working directory (${distinctCwds[0] ?? "<unknown>"}). Multiple instances exist but nothing distinguishes the project each one serves.`,
  };
}

/** Lifetimes at or under this are a cold spawn, not a session. */
const COLD_SPAWN_MAX_MS = 15_000;

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

function decideVerdict(input: {
  rootsAnsweredWithRoots: number;
  allRoots: readonly string[];
  projectEnvSignals: readonly { pid: number; key: string; value: string }[];
  parentPaths: readonly { pid: number; value: string }[];
  hooksWithWorkspace: number;
  hookWorkspaces: readonly string[];
  spawnModel: ProbeReport["mcp"]["spawnModel"];
}): ProbeReport["verdict"] {
  const multiplexingRequired = input.spawnModel !== "per-window-with-cwd";
  const residualUnknowns: string[] = [];

  if (input.rootsAnsweredWithRoots > 0 && input.allRoots.length > 0) {
    return {
      channel: "host-roots",
      multiplexingRequired,
      statement:
        "The host answered MCP roots/list with at least one root. Project identity can come from the handshake, and the broker must keep that path — with an explicit refusal when the list is empty.",
      residualUnknowns,
    };
  }

  // A parent-command-line path counts only when it matches a workspace the hooks stated.
  // An unmatched path from an editor's command line is not evidence: that string is full
  // of unrelated absolute paths (extensions, resources, logs), and reading one as "the
  // project" is the same class of guess that produced the global workspace pin.
  const correlatedParentPaths = input.parentPaths.filter((entry) =>
    input.hookWorkspaces.some((workspace) => samePath(workspace, entry.value)),
  );

  if (input.projectEnvSignals.length > 0 || correlatedParentPaths.length > 0) {
    const shown = [
      ...input.projectEnvSignals.map((signal) => `${signal.key} (pid ${signal.pid}) = ${signal.value}`),
      ...correlatedParentPaths.map((entry) => `parent command line (pid ${entry.pid}) = ${entry.value}`),
    ].slice(0, 5);
    return {
      channel: "host-environment",
      multiplexingRequired,
      statement: `roots/list answered nothing usable, but the server instance itself carries a project signal: ${shown.join(" | ")}. A per-window spawn can therefore be identified without the handshake.`,
      residualUnknowns,
    };
  }

  if (input.hooksWithWorkspace > 0) {
    residualUnknowns.push(
      "Whether the MCP server can learn its conversationId: nothing in the probe's handshake, environment or parent command line carried one. The hook channel is exact, but the broker has no key to join it on.",
    );
    return {
      channel: "hook-channel-only",
      multiplexingRequired,
      statement:
        "The hook payload states the workspace, and the MCP server is given nothing that can be attributed to a project: no root, no workspace-named environment variable, no parent path matching a stated workspace. The broker cannot discover its project — the session must state it, and the statement must be bound to a conversation or to the call itself.",
      residualUnknowns,
    };
  }

  return {
    channel: "no-channel",
    multiplexingRequired,
    statement:
      "Neither the handshake, nor the server environment, nor the hook payload stated a workspace during this run. Project identity must be stated explicitly by the session.",
    residualUnknowns,
  };
}

function answerQuestions(report: ProbeReport): { id: string; question: string; answer: string }[] {
  const answeredWithRoots = report.mcp.instances
    .flatMap((instance) => instance.rootsAttempts)
    .filter((attempt) => attempt.roots.length > 0);
  const projectishKeys = unique(
    report.mcp.instances.flatMap((instance) =>
      instance.envWorkspaceHints
        .map((hint) => hint.key)
        .filter((key) => !SELF_INFLICTED_ENV_KEY.test(key)),
    ),
  );
  return [
    {
      id: "Q1",
      question: "How many MCP server processes did the host spawn, and how many run at once?",
      answer: `${report.mcp.instanceCount} instance(s); peak concurrent ${report.mcp.concurrentPeak}; median lifetime ${(report.mcp.medianLifetimeMs / 1000).toFixed(1)}s.${report.mcp.testRunnerInstances > 0 ? ` ${report.mcp.testRunnerInstances} spawned while a test suite ran.` : ""} Model: ${report.mcp.spawnModel} — ${report.mcp.spawnModelEvidence}${
        report.mcp.unknownMethods.length > 0
          ? ` Unmodelled host method(s) seen: ${report.mcp.unknownMethods.join(", ")}.`
          : ""
      }`,
    },
    {
      id: "Q2",
      question: "Does any MCP instance carry a project signal of its own (cwd, environment, parent command line)?",
      answer:
        report.mcp.projectEnvSignals.length > 0
          ? report.mcp.projectEnvSignals
              .map((signal) => `pid ${signal.pid}: ${signal.key}=${signal.value}`)
              .join(" | ")
          : `No workspace- or project-named environment variable reaches the server. ${
              projectishKeys.length === 0
                ? "No project-ish key is present at all."
                : `Keys merely resembling one (${projectishKeys.join(", ")}) are shared by every instance and name no project.`
            } Working directory is identical across instances: ${report.mcp.distinctCwds.join(" | ") || "<none>"}.`,
    },
    {
      id: "Q3",
      question: "Does roots/list get answered, with what, and how fast?",
      answer:
        report.mcp.rootsRequests === 0
          ? "roots/list was never sent: the host did not advertise the roots capability."
          : `${report.mcp.rootsRequests} request(s), ${report.mcp.rootsAnswered} answered, ${report.mcp.rootsAnsweredWithRoots} carrying a root. Distinct roots: ${report.mcp.distinctRoots.length === 0 ? "<none>" : report.mcp.distinctRoots.join(", ")}. ${
              answeredWithRoots.length === 0
                ? "Every answer was an empty list — the same defect measured on 2026-09-14 (35 of 36 bind attempts unresolved), now reproduced with the host answering."
                : `Fastest answer carrying a root: ${Math.min(...answeredWithRoots.map((attempt) => attempt.elapsedMs ?? 0))} ms.`
            }`,
    },
    {
      id: "Q4",
      question: "Does the hook payload state the workspace, per event?",
      answer: Object.entries(report.hooks.byEvent)
        .map(
          ([event, entry]) =>
            `${event}: ${entry.withWorkspacePaths}/${entry.count} invocation(s) with a non-empty workspacePaths`,
        )
        .join(" | ") || "No hook invocation was recorded.",
    },
    {
      id: "Q5",
      question: "Is there anything that joins an MCP instance to a conversation?",
      answer:
        report.correlation.intersection.length > 0
          ? `The same workspace appears on both sides: ${report.correlation.intersection.join(", ")}. Join by workspace is possible; joining by conversation id still needs the server side to receive one.`
          : "Nothing. Workspaces seen by the hooks never appear on the server side, and no conversationId reached the server.",
    },
    {
      id: "Q6",
      question: "Which channel can carry project identity, and is multiplexing required?",
      answer: `${report.verdict.channel}. Multiplexing required: ${report.verdict.multiplexingRequired ? "yes" : "no"}. ${report.verdict.statement}`,
    },
  ];
}

// --- rendering ---------------------------------------------------------------------------

export function formatProbeReport(report: ProbeReport): string {
  const lines: string[] = [];
  lines.push("OMA session-identity probe — report");
  lines.push(`generated: ${report.generatedAt}`);
  lines.push(`logs:      ${report.logDirectory}`);
  lines.push("");
  lines.push("VERDICT");
  lines.push(`  channel              ${report.verdict.channel}`);
  lines.push(`  multiplexing required ${report.verdict.multiplexingRequired ? "yes" : "no"}`);
  lines.push(`  ${report.verdict.statement}`);
  for (const unknown of report.verdict.residualUnknowns) lines.push(`  residual unknown: ${unknown}`);
  lines.push("");
  lines.push("MCP SERVERS");
  lines.push(
    `  instances ${report.mcp.instanceCount} | peak concurrent ${report.mcp.concurrentPeak} | median lifetime ${(report.mcp.medianLifetimeMs / 1000).toFixed(1)}s | spawn model ${report.mcp.spawnModel}`,
  );
  if (report.mcp.testRunnerInstances > 0) {
    lines.push(
      `  provenance: ${report.mcp.testRunnerInstances} instance(s) were spawned while a test suite ran (the suite drives the real runtime, so they are host evidence, not editor evidence)`,
    );
  }
  lines.push(`  cwd(s): ${report.mcp.distinctCwds.join(" | ") || "<none>"}`);
  if (report.mcp.unknownMethods.length > 0) {
    lines.push(`  unmodelled host method(s): ${report.mcp.unknownMethods.join(", ")}`);
  }
  lines.push(`  ${report.mcp.spawnModelEvidence}`);

  // A busy host spawns a server per query; listing all of them would bury the answer.
  const MAX_LISTED_INSTANCES = 8;
  for (const instance of report.mcp.instances.slice(0, MAX_LISTED_INSTANCES)) {
    const answered = instance.rootsAttempts.filter((attempt) => attempt.answered).length;
    const withRoots = instance.rootsAttempts.filter((attempt) => attempt.roots.length > 0).length;
    lines.push(
      `  - pid ${instance.pid} (ppid ${instance.ppid ?? "?"}) ${instance.startedAt} -> ${instance.exitedAt ?? instance.lastSeenAt}${instance.uptimeMs !== undefined ? ` (${(instance.uptimeMs / 1000).toFixed(1)}s)` : ""}${instance.spawnedByTestRunner ? " [test-runner]" : ""}`,
    );
    lines.push(`      cwd: ${instance.cwd ?? "<unset>"}; methods: ${instance.methods.join(", ") || "<none>"}`);
    lines.push(
      `      roots: ${instance.rootsAttempts.length} request(s), ${answered} answered, ${withRoots} with a root`,
    );
    lines.push(
      `      project-named env: ${projectSignalsOf(instance).join(", ") || "<none>"}`,
    );
    if (instance.parentCommandLine !== undefined) {
      lines.push(`      parent: ${truncate(instance.parentCommandLine, 200)}`);
    }
  }
  if (report.mcp.instances.length > MAX_LISTED_INSTANCES) {
    lines.push(`  … ${report.mcp.instances.length - MAX_LISTED_INSTANCES} more instance(s); full record in the JSON report`);
  }
  if (report.mcp.projectEnvSignals.length > 0) {
    lines.push("  workspace- or project-named environment variables found:");
    for (const signal of report.mcp.projectEnvSignals.slice(0, 10)) {
      lines.push(`    pid ${signal.pid}: ${signal.key}=${signal.value}`);
    }
  }
  if (report.mcp.selfInflictedEnvSignals.length > 0) {
    lines.push("  OMA's own variables present (its configuration, never the host's statement):");
    for (const signal of report.mcp.selfInflictedEnvSignals.slice(0, 10)) {
      lines.push(`    pid ${signal.pid}: ${signal.key}=${signal.value}`);
    }
  }
  if (report.mcp.perInstanceEnvKeys.length > 0) {
    lines.push("  environment keys that differ between instances:");
    for (const entry of report.mcp.perInstanceEnvKeys.slice(0, 15)) {
      lines.push(`    ${entry.key}: ${entry.values.slice(0, 4).join(" | ")}`);
    }
  }
  lines.push("");
  lines.push("HOOKS");
  lines.push(`  invocations ${report.hooks.invocationCount} | with workspacePaths ${report.hooks.withWorkspacePaths}`);
  for (const [event, entry] of Object.entries(report.hooks.byEvent)) {
    lines.push(`  - ${event}: ${entry.count} invocation(s), ${entry.withWorkspacePaths} stating a workspace`);
  }
  lines.push(`  hook cwd(s): ${report.hooks.distinctCwds.join(" | ") || "<none>"}`);
  lines.push(`  workspaces seen: ${report.hooks.distinctWorkspaces.join(" | ") || "<none>"}`);
  lines.push(`  conversations seen: ${report.hooks.distinctConversations}`);
  lines.push("");
  lines.push("QUESTIONS");
  for (const entry of report.questions) {
    lines.push(`  ${entry.id}. ${entry.question}`);
    lines.push(`      ${entry.answer}`);
  }
  return lines.join("\n");
}

// --- small helpers -----------------------------------------------------------------------

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

/** The project-named variables of one instance, current values. */
function projectSignalsOf(instance: ProbeMcpInstance): string[] {
  return Object.entries(instance.env)
    .filter(([key]) => PROJECT_ENV_KEY.test(key))
    .map(([key, value]) => `${key}=${value}`);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function stringRecord(source: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function looksLikeAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("/");
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = value.replaceAll("/", "\\").replace(/\\+$/u, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function fileUriToPath(value: string): string | undefined {
  if (!value.startsWith("file:")) return value;
  try {
    return decodeURIComponent(value.replace(/^file:\/\/\/?/u, "")).replaceAll("/", "\\");
  } catch {
    return undefined;
  }
}
