import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  type StagedTransaction,
  discardStagedTransaction,
  snapshotCleanGitWorkspace,
  stageProposal,
} from "../broker/staging.js";
import { promoteApprovedTransaction } from "../broker/promotion.js";
import { validateProposal } from "../broker/transaction.js";
import { isRecord } from "../ledger/canonical.js";
import {
  type OracleGate,
  evaluateStagedTransaction,
} from "../oracle/executor.js";
import {
  MissionJournal,
  JournalRefusal,
  subjectDigest,
  type TransactionStagedEvent,
} from "../ledger/mission-journal.js";
import type { ReviewSubject, ReviewerVerdict } from "../orchestration/model.js";
import {
  ensureMissionStarted,
  findActiveMissionId,
  listMissions,
  loadMissionProjection,
  summarizeMission,
} from "../mission/read-model.js";
import { OmaDoctor } from "../runtime/doctor.js";
import { BrainStore } from "../brain/brain-store.js";
import {
  BRAIN_SUCCESS_STATUSES,
  BRAIN_TOOL_DEFINITIONS,
  BRAIN_TOOL_NAMES,
  executeBrainTool,
} from "./brain-tools.js";
import {
  GRAPH_SUCCESS_STATUSES,
  GRAPH_TOOL_DEFINITIONS,
  GRAPH_TOOL_NAMES,
  executeGraphTool,
} from "./graph-tools.js";
import {
  ROUTING_SUCCESS_STATUSES,
  ROUTING_TOOL_DEFINITIONS,
  ROUTING_TOOL_NAMES,
  executeRoutingTool,
} from "./routing-tools.js";
import {
  ORCHESTRATION_SUCCESS_STATUSES,
  ORCHESTRATION_TOOL_DEFINITIONS,
  ORCHESTRATION_TOOL_NAMES,
  executeOrchestrationTool,
} from "./orchestration-tools.js";
import { GraphBrokerError } from "../graph/broker.js";

const protocolVersion = "2025-06-18";
const supportedProtocolVersions = new Set(["2024-11-05", protocolVersion]);

export interface BrokerConfig {
  workspaceRoot: string;
  gates: OracleGate[];
  missionId?: string;
  missionClass?: string;
  runKey?: string;
  expertId?: string;
  ledgerPath?: string;
  /** Path to the Neural Brain SQLite database. Defaults to `.oma/brain.sqlite`. */
  brainPath?: string;
}

/** Lazily open the Neural Brain so servers that never touch it create no file. */
export type BrainAccessor = () => BrainStore;

function createBrainAccessor(config: BrokerConfig): BrainAccessor {
  let brain: BrainStore | undefined;
  return () => {
    if (!brain) {
      const brainPath =
        config.brainPath ?? join(config.workspaceRoot, ".oma", "brain.sqlite");
      brain = new BrainStore(brainPath);
    }
    return brain;
  };
}

export interface StagedRecord {
  staged: StagedTransaction;
  approval: unknown;
  authorRunKey: string;
  authorExpertId: string;
  leaseId: string;
  epoch: string;
  transactionId: string;
  parentVersion: string;
  stagedDiffDigest: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export function startMcpBrokerServer(config: BrokerConfig): void {
  const readline = createInterface({ input: process.stdin, terminal: false });
  const missionId = config.missionId ?? "oma-mission";
  const missionClass = config.missionClass ?? "code-change";
  const ledgerPath = config.ledgerPath ?? process.env.OMA_LEDGER_PATH;

  const journal = new MissionJournal(
    missionId,
    missionClass,
    ledgerPath ? { journalStorePath: ledgerPath } : undefined,
  );

  const authorRunKey = config.runKey ?? "executor-run";
  const authorExpertId = config.expertId ?? "oma-executor";
  if (!journal.expertIdForRun(authorRunKey)) {
    journal.appendRunStarted({
      missionId,
      runKey: authorRunKey,
      expertId: authorExpertId,
    });
  }

  const stagedRecords = new Map<string, StagedRecord>();
  const getBrain = createBrainAccessor(config);

  readline.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      if (request.id === undefined) {
        // Notification - do not send response
        return;
      }
      const response = handleRequest(config, journal, stagedRecords, request, getBrain);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: messageOf(error) },
        })}\n`,
      );
    }
  });
}

export function handleRequest(
  config: BrokerConfig,
  journal: MissionJournal,
  stagedRecords: Map<string, StagedRecord>,
  request: JsonRpcRequest,
  getBrain?: BrainAccessor,
): Record<string, unknown> {
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: negotiateProtocolVersion(request.params?.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: "oma-broker", version: "1.0.0" },
      },
    };
  }
  if (request.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "propose_change",
            description:
              "Propose a structured, multi-file change to the repository. Evaluates quality gates and stages the proposal in an isolated worktree.",
            inputSchema: {
              type: "object",
              properties: {
                parentVersion: { type: "string" },
                operations: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["create", "modify", "delete"] },
                      kind: { type: "string", enum: ["write", "delete"] },
                      path: { type: "string" },
                      content: { type: "string" },
                      baseHash: { type: "string" },
                    },
                    required: ["path"],
                  },
                },
              },
              required: ["parentVersion", "operations"],
            },
          },
          {
            name: "attest_review",
            description:
              "Attest an independent review verdict (approved/rejected) on a staged transaction.",
            inputSchema: {
              type: "object",
              properties: {
                transactionId: { type: "string" },
                stagedDiffDigest: { type: "string" },
                reviewerRunKey: { type: "string" },
                reviewerExpertId: { type: "string" },
                verdict: { type: "string", enum: ["approved", "rejected"] },
                comments: { type: "string" },
              },
              required: ["transactionId", "stagedDiffDigest", "reviewerRunKey", "verdict"],
            },
          },
          {
            name: "promote_change",
            description:
              "Promote an approved and independently attested staged transaction to HEAD via fast-forward commit.",
            inputSchema: {
              type: "object",
              properties: {
                transactionId: { type: "string" },
                stagedDiffDigest: { type: "string" },
              },
              required: ["transactionId"],
            },
          },
          {
            name: "run_mission",
            description:
              "Initialize an OMA mission for session-native orchestration (zero detached background processes).",
            inputSchema: {
              type: "object",
              properties: {
                goal: { type: "string", minLength: 1 },
                missionId: { type: "string" },
              },
              required: ["goal"],
            },
          },
          {
            name: "mission_status",
            description:
              "Report the live status of an OMA mission: phase, current wave, ready/running/accepted work items and progress vector. Targets the active mission when no missionId is given. Read-only.",
            inputSchema: {
              type: "object",
              properties: {
                missionId: { type: "string" },
              },
            },
          },
          {
            name: "mission_inspect",
            description:
              "Inspect the cryptographic provenance chain of an OMA mission: produced artifacts, attested reviews and the terminal verdict. Targets the active mission when no missionId is given. Read-only.",
            inputSchema: {
              type: "object",
              properties: {
                missionId: { type: "string" },
              },
            },
          },
          {
            name: "list_missions",
            description:
              "List every OMA mission recorded in this workspace with its status and current wave, most recently active first. Read-only.",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "resume_mission",
            description:
              "Resume an interrupted OMA mission for session-native orchestration without re-running work that already succeeded. Targets the active mission when no missionId is given.",
            inputSchema: {
              type: "object",
              properties: {
                missionId: { type: "string" },
              },
            },
          },
          {
            name: "doctor",
            description:
              "Diagnose the local AntiGravity runtime and this workspace's OMA plugin installation. Read-only.",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          ...BRAIN_TOOL_DEFINITIONS,
          ...GRAPH_TOOL_DEFINITIONS,
          ...ROUTING_TOOL_DEFINITIONS,
          ...ORCHESTRATION_TOOL_DEFINITIONS,
        ],
      },
    };
  }
  if (request.method === "tools/call") {
    const toolName = request.params?.name;
    const input = request.params?.arguments;
    try {
      let result: Record<string, unknown>;
      if (toolName === "propose_change") {
        result = executeProposal(config, journal, stagedRecords, input);
      } else if (toolName === "attest_review") {
        result = executeAttestReview(config, journal, stagedRecords, input);
      } else if (toolName === "promote_change") {
        result = executePromoteChange(config, journal, stagedRecords, input);
      } else if (toolName === "run_mission") {
        result = executeMission(config, input);
      } else if (toolName === "mission_status") {
        result = executeMissionStatus(config, input);
      } else if (toolName === "mission_inspect") {
        result = executeMissionInspect(config, input);
      } else if (toolName === "list_missions") {
        result = executeListMissions(config);
      } else if (toolName === "resume_mission") {
        result = executeResumeMission(config, input);
      } else if (toolName === "doctor") {
        result = executeDoctor(config);
      } else if (typeof toolName === "string" && BRAIN_TOOL_NAMES.has(toolName)) {
        const accessor = getBrain ?? createBrainAccessor(config);
        result = executeBrainTool(accessor(), config.workspaceRoot, toolName, input);
      } else if (typeof toolName === "string" && GRAPH_TOOL_NAMES.has(toolName)) {
        result = executeGraphTool(config.workspaceRoot, toolName, input);
      } else if (typeof toolName === "string" && ROUTING_TOOL_NAMES.has(toolName)) {
        result = executeRoutingTool(toolName, input);
      } else if (typeof toolName === "string" && ORCHESTRATION_TOOL_NAMES.has(toolName)) {
        const accessor = getBrain ?? createBrainAccessor(config);
        result = executeOrchestrationTool(config.workspaceRoot, toolName, input, accessor());
      } else {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      const isError =
        result.status !== "promoted" &&
        result.status !== "staged_pending_review" &&
        result.status !== "review_attested" &&
        result.status !== "started" &&
        result.status !== "resumed" &&
        result.status !== "succeeded" &&
        result.status !== "reported" &&
        !(typeof result.status === "string" && BRAIN_SUCCESS_STATUSES.has(result.status)) &&
        !(typeof result.status === "string" && GRAPH_SUCCESS_STATUSES.has(result.status)) &&
        !(typeof result.status === "string" && ROUTING_SUCCESS_STATUSES.has(result.status)) &&
        !(typeof result.status === "string" && ORCHESTRATION_SUCCESS_STATUSES.has(result.status));

      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError,
        },
      };
    } catch (error) {
      const reasonCode =
        error instanceof JournalRefusal
          ? error.reasonCode
          : error instanceof GraphBrokerError
            ? error.code
            : undefined;
      const failure: Record<string, unknown> = {
        status: "rejected",
        reason: messageOf(error),
        ...(reasonCode ? { reasonCode } : {}),
        ...(error instanceof GraphBrokerError && error.diagnostics.length > 0
          ? { diagnostics: error.diagnostics }
          : {}),
        ...(error instanceof GraphBrokerError && error.cyclePath
          ? { cyclePath: error.cyclePath }
          : {}),
      };
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(failure) }],
          structuredContent: failure,
          isError: true,
        },
      };
    }
  }
  throw new Error(`Unsupported MCP method: ${request.method}`);
}

function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && supportedProtocolVersions.has(requested)
    ? requested
    : protocolVersion;
}

function executeMission(config: BrokerConfig, input: unknown): Record<string, unknown> {
  if (!isRecord(input) || typeof input.goal !== "string" || input.goal.trim().length === 0) {
    throw new Error("run_mission requires a non-empty goal.");
  }
  if (input.missionId !== undefined && (typeof input.missionId !== "string" || input.missionId.trim().length === 0)) {
    throw new Error("run_mission missionId must be a non-empty string when provided.");
  }

  const missionId = typeof input.missionId === "string" ? input.missionId.trim() : `oma-${Date.now()}`;
  ensureMissionStarted(config.workspaceRoot, missionId, input.goal.trim());
  return {
    status: "started",
    missionId,
    mode: "session-native",
    message: "Mission initialized for in-session orchestration. Use /oma:start or converge_step to drive execution.",
  };
}

function executeResumeMission(config: BrokerConfig, input: unknown): Record<string, unknown> {
  const missionId = resolveMissionId(config, input);
  const projection = loadMissionProjection(config.workspaceRoot, missionId);
  if (projection.status === "succeeded") {
    return {
      status: "succeeded",
      missionId,
      mode: "session-native",
      message: `Mission '${missionId}' has already succeeded.`,
    };
  }
  return {
    status: "resumed",
    missionId,
    mode: "session-native",
    message: "Mission resumed for in-session orchestration. Use /oma:start or converge_step to continue execution.",
  };
}

function resolveMissionId(config: BrokerConfig, input: unknown): string {
  const explicit =
    isRecord(input) && typeof input.missionId === "string" && input.missionId.trim().length > 0
      ? input.missionId.trim()
      : undefined;
  const missionId = explicit ?? findActiveMissionId(config.workspaceRoot);
  if (!missionId) {
    throw new Error("No active mission found. Provide a missionId or start one with /oma:start.");
  }
  return missionId;
}

function executeMissionStatus(config: BrokerConfig, input: unknown): Record<string, unknown> {
  const missionId = resolveMissionId(config, input);
  const projection = loadMissionProjection(config.workspaceRoot, missionId);
  return { status: "reported", ...summarizeMission(missionId, projection) };
}

function executeMissionInspect(config: BrokerConfig, input: unknown): Record<string, unknown> {
  const missionId = resolveMissionId(config, input);
  const projection = loadMissionProjection(config.workspaceRoot, missionId);
  return { status: "reported", missionId, provenance: projection.provenance };
}

function executeListMissions(config: BrokerConfig): Record<string, unknown> {
  return { status: "reported", missions: listMissions(config.workspaceRoot) };
}

function executeDoctor(config: BrokerConfig): Record<string, unknown> {
  return { status: "reported", report: OmaDoctor.diagnoseEnvironment(config.workspaceRoot) };
}

function executeProposal(
  config: BrokerConfig,
  journal: MissionJournal,
  stagedRecords: Map<string, StagedRecord>,
  input: unknown,
): Record<string, unknown> {
  assertUnprotectedProposalInput(input);
  const source = snapshotCleanGitWorkspace(config.workspaceRoot);
  const validated = validateProposal(source, input);
  assertUnprotectedOperations(validated.operations.map((operation) => operation.path));

  let staged: StagedTransaction | undefined;
  try {
    staged = stageProposal(config.workspaceRoot, input);
    const evaluation = evaluateStagedTransaction(staged, config.gates);
    if (evaluation.status === "rejected") {
      staged = undefined;
      return {
        status: "rejected",
        transactionId: validated.transactionId,
        reason: evaluation.reason,
        failedGateId: evaluation.failedGateId,
        observations: evaluation.observations,
      };
    }

    const missionId = config.missionId ?? journal.missionId;
    const authorRunKey = config.runKey ?? "executor-run";
    const authorExpertId = config.expertId ?? "oma-executor";
    const leaseId = `lease-${Date.now()}`;
    const epoch = "1";

    if (!journal.expertIdForRun(authorRunKey)) {
      journal.appendRunStarted({
        missionId,
        runKey: authorRunKey,
        expertId: authorExpertId,
      });
    }

    journal.appendTransactionStaged({
      runKey: authorRunKey,
      missionId,
      leaseId,
      epoch,
      transactionId: validated.transactionId,
      stagedDiffDigest: staged.stagedDiffDigest,
    });

    stagedRecords.set(validated.transactionId, {
      staged,
      approval: evaluation.approval,
      authorRunKey,
      authorExpertId,
      leaseId,
      epoch,
      transactionId: validated.transactionId,
      parentVersion: validated.parentVersion,
      stagedDiffDigest: staged.stagedDiffDigest,
    });

    return {
      status: "staged_pending_review",
      transactionId: validated.transactionId,
      stagedDiffDigest: staged.stagedDiffDigest,
      stagingPath: staged.worktreePath,
      observations: evaluation.observations,
    };
  } catch (error) {
    if (staged && existsSync(staged.containerPath)) {
      discardStagedTransaction(staged);
    }
    throw error;
  }
}

function executeAttestReview(
  config: BrokerConfig,
  journal: MissionJournal,
  stagedRecords: Map<string, StagedRecord>,
  input: unknown,
): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new Error("Invalid attest_review input.");
  }

  const transactionId = String(input.transactionId);
  const stagedDiffDigest = String(input.stagedDiffDigest);
  const reviewerRunKey = String(input.reviewerRunKey);
  const verdict = input.verdict as ReviewerVerdict;

  if (verdict !== "approved" && verdict !== "rejected") {
    throw new Error(`Invalid verdict: ${String(input.verdict)}. Must be 'approved' or 'rejected'.`);
  }

  const missionId = config.missionId ?? journal.missionId;
  const reviewerExpertId = input.reviewerExpertId
    ? String(input.reviewerExpertId)
    : (reviewerRunKey.includes("reviewer") ? "oma-reviewer" : "reviewer-expert");

  if (!journal.expertIdForRun(reviewerRunKey)) {
    journal.appendRunStarted({
      missionId,
      runKey: reviewerRunKey,
      expertId: reviewerExpertId,
    });
  }

  // Find staged transaction author runKey
  const stagedEvent = journal
    .events()
    .find(
      (e): e is TransactionStagedEvent & { seq: number } =>
        e.type === "transaction_staged" &&
        e.transactionId === transactionId,
    );

  const authorRunKey = stagedEvent
    ? stagedEvent.runKey
    : stagedRecords.get(transactionId)?.authorRunKey ?? (config.runKey ?? "executor-run");

  const subject: ReviewSubject[] = [
    {
      runKey: authorRunKey,
      transactionId,
      stagedDiffDigest,
      artifactHashes: [],
    },
  ];

  const calculatedSubjectDigest = subjectDigest(subject);

  const event = journal.appendOracleReviewAttested({
    runKey: reviewerRunKey,
    reviewerRunKey,
    missionId,
    epoch: "1",
    leaseId: `lease-${Date.now()}`,
    subject,
    subjectDigest: calculatedSubjectDigest,
    reviewerVerdict: verdict,
  });

  return {
    status: "review_attested",
    transactionId,
    reviewerVerdict: verdict,
    sequence: event.seq,
  };
}

function executePromoteChange(
  config: BrokerConfig,
  journal: MissionJournal,
  stagedRecords: Map<string, StagedRecord>,
  input: unknown,
): Record<string, unknown> {
  if (!isRecord(input) || !input.transactionId) {
    throw new Error("Invalid promote_change input: transactionId is required.");
  }

  const transactionId = String(input.transactionId);
  const stagedRecord = stagedRecords.get(transactionId);

  const stagedEvent = journal
    .events()
    .find(
      (e): e is TransactionStagedEvent & { seq: number } =>
        e.type === "transaction_staged" &&
        e.transactionId === transactionId,
    );

  if (!stagedEvent) {
    throw new Error(`Transaction ${transactionId} is not staged in journal.`);
  }

  const authorRunKey = stagedEvent.runKey;
  const stagedDiffDigest = String(input.stagedDiffDigest ?? stagedEvent.stagedDiffDigest);
  const missionId = config.missionId ?? journal.missionId;

  // Verify review attestation & policies in journal
  journal.assertPromotionAllowed({
    runKey: authorRunKey,
    missionId,
    leaseId: stagedEvent.leaseId,
    epoch: stagedEvent.epoch,
    transactionId,
    stagedDiffDigest,
    diffDigest: stagedDiffDigest,
  });

  if (!stagedRecord) {
    throw new Error(
      `Staged transaction ${transactionId} not found in active staging cache for promotion.`,
    );
  }

  const promotion = promoteApprovedTransaction(stagedRecord.approval, {
    missionId,
    runKey: authorRunKey,
    expectedStagedDiffDigest: stagedDiffDigest,
  });

  journal.appendTransactionPromoted({
    runKey: authorRunKey,
    missionId,
    leaseId: stagedEvent.leaseId,
    epoch: stagedEvent.epoch,
    transactionId,
    stagedDiffDigest: promotion.stagedDiffDigest,
    commitSha: promotion.commitSha,
    diffDigest: promotion.diffDigest,
  });

  stagedRecords.delete(transactionId);

  return {
    status: "promoted",
    transactionId: promotion.transactionId,
    commitSha: promotion.commitSha,
    verdictHash: promotion.verdictHash,
    parentVersion: promotion.parentVersion,
    promotedVersion: promotion.promotedVersion,
    targetRef: promotion.targetRef,
  };
}

function assertUnprotectedProposalInput(input: unknown): void {
  if (!isRecord(input) || !Array.isArray(input.operations)) return;
  const paths = input.operations.flatMap((operation) =>
    isRecord(operation) && typeof operation.path === "string" ? [operation.path] : [],
  );
  assertUnprotectedOperations(paths);
}

function assertUnprotectedOperations(paths: string[]): void {
  const protectedPrefixes = [
    ".agents/plugins/oma",
    ".oma/graph",
    ".oma/ledger",
    ".oma/control",
  ];
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
    if (protectedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
      throw new Error(`Transaction targets protected OMA control path: ${path}`);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Direct CLI entrypoint
if (
  process.argv[1] &&
  (process.argv[1].endsWith("broker-server.js") || process.argv[1].endsWith("broker-server.ts"))
) {
  const gatesPath = process.env.OMA_GATES_PATH;
  let gates: OracleGate[] = [];
  if (gatesPath && existsSync(gatesPath)) {
    try {
      const parsed = JSON.parse(readFileSync(gatesPath, "utf8"));
      if (isRecord(parsed) && Array.isArray(parsed.gates)) {
        gates = parsed.gates as OracleGate[];
      }
    } catch {
      // Use empty gates
    }
  }

  startMcpBrokerServer({
    workspaceRoot: process.env.OMA_WORKSPACE_ROOT || process.cwd(),
    gates,
    missionId: process.env.OMA_MISSION_ID,
    missionClass: process.env.OMA_MISSION_CLASS,
    runKey: process.env.OMA_RUN_KEY,
    expertId: process.env.OMA_EXPERT_ID,
    ledgerPath: process.env.OMA_LEDGER_PATH,
    brainPath: process.env.OMA_BRAIN_PATH,
  });
}
