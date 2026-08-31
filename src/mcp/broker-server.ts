import { existsSync, readFileSync } from "node:fs";
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

const protocolVersion = "2025-06-18";

export interface BrokerConfig {
  workspaceRoot: string;
  gates: OracleGate[];
  missionId?: string;
  missionClass?: string;
  runKey?: string;
  expertId?: string;
  ledgerPath?: string;
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

  const authorRunKey = config.runKey ?? "worker-run";
  const authorExpertId = config.expertId ?? "oma-executor";
  if (!journal.expertIdForRun(authorRunKey)) {
    journal.appendRunStarted({
      missionId,
      runKey: authorRunKey,
      expertId: authorExpertId,
    });
  }

  const stagedRecords = new Map<string, StagedRecord>();

  readline.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      if (request.id === undefined) {
        // Notification - do not send response
        return;
      }
      const response = handleRequest(config, journal, stagedRecords, request);
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
): Record<string, unknown> {
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion,
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
      } else {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      const isError =
        result.status !== "promoted" &&
        result.status !== "staged_pending_review" &&
        result.status !== "review_attested";

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
      const reasonCode = error instanceof JournalRefusal ? error.reasonCode : undefined;
      const failure = {
        status: "rejected",
        reason: messageOf(error),
        ...(reasonCode ? { reasonCode } : {}),
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
    const authorRunKey = config.runKey ?? "worker-run";
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
    : stagedRecords.get(transactionId)?.authorRunKey ?? (config.runKey ?? "worker-run");

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
  });
}
