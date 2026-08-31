import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, hashJson, sha256 } from "../ledger/canonical.js";
import { resolveGraphGates, type ResolvedGraphGates } from "./gate-registry.js";
import type {
  ExecutionGraph,
  GraphAuthority,
  GraphEvent,
  GraphOutcome,
} from "./model.js";
import { parseExecutionGraph, parseGraphEvent } from "./model.js";
import { assertTransitionAllowed, projectGraph } from "./kernel.js";

export const GRAPH_GENESIS_HASH = "0".repeat(64);

export interface GraphPaths {
  root: string;
  graphDir: string;
  definition: string;
  events: string;
  head: string;
  lock: string;
}

export interface LoadedGraphRuntime {
  paths: GraphPaths;
  graph: ExecutionGraph;
  graphHash: string;
  resolvedGates: ResolvedGraphGates;
  gateResolutionError?: string;
}

export interface GraphStoreVerification {
  valid: boolean;
  errors: string[];
  events: GraphEvent[];
  headHash: string;
}

export type GraphTransitionInput =
  | {
      eventType: "node_dispatched";
      nodeId: string;
      dispatchId: string;
      authorityId: string;
    }
  | {
      eventType: "node_completed";
      nodeId: string;
      dispatchId: string;
      authority: GraphAuthority;
      authorityId: string;
      outcome: GraphOutcome;
      evidenceHash: string;
    };

export function graphPaths(root: string): GraphPaths {
  const normalizedRoot = resolve(root);
  const graphDir = join(normalizedRoot, ".oma", "graph");
  return {
    root: normalizedRoot,
    graphDir,
    definition: join(graphDir, "execution-graph.json"),
    events: join(graphDir, "events.jsonl"),
    head: join(graphDir, "head.json"),
    lock: join(graphDir, "graph.lock"),
  };
}

export function loadGraphRuntime(root: string): LoadedGraphRuntime {
  const paths = graphPaths(root);
  const raw = JSON.parse(readFileSync(paths.definition, "utf8")) as unknown;
  const graph = parseExecutionGraph(raw);
  try {
    return {
      paths,
      graph,
      graphHash: hashJson(raw),
      resolvedGates: resolveGraphGates(graph, paths.root),
    };
  } catch (error) {
    return {
      paths,
      graph,
      graphHash: hashJson(raw),
      resolvedGates: new Map(),
      gateResolutionError: messageOf(error),
    };
  }
}

export function initializeGraphStore(root: string): LoadedGraphRuntime {
  const runtime = loadGraphRuntime(root);
  const runtimeErrors = graphRuntimeErrors(runtime);
  if (runtimeErrors.length > 0) {
    throw new Error(`Cannot initialize invalid graph store: ${runtimeErrors.join("; ")}`);
  }
  if (existsSync(runtime.paths.events) || existsSync(runtime.paths.head)) {
    throw new Error("Graph event store is already initialized");
  }
  mkdirSync(runtime.paths.graphDir, { recursive: true });
  writeFileSync(runtime.paths.events, "", { encoding: "utf8", flag: "wx" });
  writeFileSync(
    runtime.paths.head,
    `${JSON.stringify({ entries: 0, headHash: GRAPH_GENESIS_HASH }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return runtime;
}

export function verifyGraphStore(runtime: LoadedGraphRuntime): GraphStoreVerification {
  const errors = graphRuntimeErrors(runtime);
  if (!existsSync(runtime.paths.events) || !existsSync(runtime.paths.head)) {
    return {
      valid: false,
      errors: [...errors, "Graph event store is not initialized"],
      events: [],
      headHash: GRAPH_GENESIS_HASH,
    };
  }
  const lines = readFileSync(runtime.paths.events, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  const events: GraphEvent[] = [];
  let previousHash = GRAPH_GENESIS_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const event = parseGraphEvent(JSON.parse(lines[index]) as unknown);
      if (event.sequence !== index + 1) errors.push(`Sequence mismatch at event ${index + 1}`);
      if (event.previousHash !== previousHash) errors.push(`Previous hash mismatch at event ${index + 1}`);
      if (event.graphId !== runtime.graph.graphId) {
        errors.push(`Graph identity mismatch at event ${index + 1}`);
      } else if (event.graphRevision === runtime.graph.revision) {
        if (event.graphHash !== runtime.graphHash) {
          errors.push(`Graph identity mismatch at event ${index + 1}`);
        }
      } else if (event.graphRevision < runtime.graph.revision) {
        const revPath = join(runtime.paths.graphDir, "revisions", `rev_${event.graphRevision}.json`);
        const paddedRevPath = join(runtime.paths.graphDir, "revisions", `rev_${String(event.graphRevision).padStart(3, "0")}.json`);
        const targetRevPath = existsSync(revPath) ? revPath : existsSync(paddedRevPath) ? paddedRevPath : undefined;
        if (!targetRevPath) {
          errors.push(`Graph identity mismatch at event ${index + 1}`);
        } else {
          try {
            const revRaw = JSON.parse(readFileSync(targetRevPath, "utf8"));
            const revHash = hashJson(revRaw);
            if (event.graphHash !== revHash) {
              errors.push(`Graph identity mismatch at event ${index + 1}`);
            }
          } catch {
            errors.push(`Graph identity mismatch at event ${index + 1}`);
          }
        }
      } else {
        errors.push(`Graph identity mismatch at event ${index + 1}`);
      }
      const { eventHash, ...unsigned } = event;
      if (eventHash !== sha256(canonicalJson(unsigned))) {
        errors.push(`Event hash mismatch at event ${index + 1}`);
      }
      assertTransitionAllowed(runtime.graph, events, event);
      previousHash = event.eventHash;
      events.push(event);
    } catch (error) {
      errors.push(`Invalid graph event ${index + 1}: ${messageOf(error)}`);
    }
  }
  try {
    const head = JSON.parse(readFileSync(runtime.paths.head, "utf8")) as unknown;
    if (
      typeof head !== "object" ||
      head === null ||
      !("entries" in head) ||
      head.entries !== events.length ||
      !("headHash" in head) ||
      head.headHash !== previousHash
    ) {
      errors.push("Graph head does not match event store");
    }
  } catch (error) {
    errors.push(`Invalid graph head: ${messageOf(error)}`);
  }
  try {
    projectGraph(runtime.graph, events);
  } catch (error) {
    errors.push(`Graph replay failed: ${messageOf(error)}`);
  }
  return { valid: errors.length === 0, errors, events, headHash: previousHash };
}

export function appendGraphTransition(
  runtime: LoadedGraphRuntime,
  input: GraphTransitionInput,
): GraphEvent {
  return withGraphLock(runtime.paths, () => {
    const verification = verifyGraphStore(runtime);
    if (!verification.valid) {
      throw new Error(`Cannot append to invalid graph store: ${verification.errors.join("; ")}`);
    }
    const common = {
      sequence: verification.events.length + 1,
      timestamp: new Date().toISOString(),
      graphId: runtime.graph.graphId,
      graphRevision: runtime.graph.revision,
      graphHash: runtime.graphHash,
      nodeId: input.nodeId,
      dispatchId: input.dispatchId,
      authority: input.eventType === "node_dispatched" ? ("scheduler" as const) : input.authority,
      authorityId: input.authorityId,
      previousHash: verification.headHash,
    };
    const unsigned =
      input.eventType === "node_dispatched"
        ? { ...common, eventType: input.eventType }
        : {
            ...common,
            eventType: input.eventType,
            outcome: input.outcome,
            evidenceHash: input.evidenceHash,
          };
    const event = parseGraphEvent({
      ...unsigned,
      eventHash: sha256(canonicalJson(unsigned)),
    });
    assertTransitionAllowed(runtime.graph, verification.events, event);
    appendFileSync(runtime.paths.events, `${canonicalJson(event)}\n`, "utf8");
    writeFileSync(
      runtime.paths.head,
      `${JSON.stringify({ entries: event.sequence, headHash: event.eventHash }, null, 2)}\n`,
      "utf8",
    );
    return event;
  });
}

function withGraphLock<T>(paths: GraphPaths, operation: () => T): T {
  mkdirSync(dirname(paths.lock), { recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(paths.lock, "wx");
  } catch {
    throw new Error(`Graph state is locked: ${paths.lock}`);
  }
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    rmSync(paths.lock, { force: true });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function graphRuntimeErrors(runtime: LoadedGraphRuntime): string[] {
  const errors: string[] = [];
  if (runtime.gateResolutionError) {
    errors.push(`Gate registry resolution failed: ${runtime.gateResolutionError}`);
  }
  return errors;
}
