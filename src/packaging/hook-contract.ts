import { readFileSync } from "node:fs";

/**
 * AntiGravity (AGY) `hooks.json` contract, captured empirically.
 *
 * Probe basis: AGY 1.2.1, Windows, 2026-09-11. The runtime is a Go binary whose
 * `jsonhook` package decodes the file as `map[string]JSONHookSpec`.
 *
 * Established behaviour:
 *  1. EVERY top-level key is a hook NAME; every value must be a usable spec.
 *  2. A spec is either a *command hook* (it carries `command`) or an *event
 *     group* keyed by a SUPPORTED event name (`PreToolUse`, ...).
 *  3. Unrecognised keys are ignored. If that leaves a spec with no recognised
 *     event group, the runtime validates it as a command hook and fails with
 *     `invalid hook "<name>": command hook must specify 'command'`.
 *  4. A single invalid hook invalidates the WHOLE file: the runtime logs
 *     `Failed to parse hooks for plugin <name>` and registers NONE of its hooks.
 *     This is how one unsupported event name silently disabled every other hook.
 *  5. A UTF-8 BOM makes the decoder fail before any hook is read.
 *
 * Do not add an event to this table without a recorded observation. Guessing an
 * event name is not a harmless mistake here: it disables the entire file.
 */

export interface HookEventEvidence {
  /** Event key as written in hooks.json. */
  event: string;
  /** The runtime's parser accepted a spec using this event. */
  parseAccepted: boolean;
  /** The hook was observed actually executing. */
  firingObserved: boolean;
  /** How the observation was made, or why the event is rejected. */
  note: string;
}

export const HOOK_EVENT_EVIDENCE: readonly HookEventEvidence[] = [
  {
    event: "PreToolUse",
    parseAccepted: true,
    firingObserved: true,
    note: "Fires before every tool call. A `{\"decision\":\"deny\",\"reason\":\"...\"}` on stdout is decoded and enforced: measured 2026-09-11, the agent received `tool call denied by pre-tool hook: <reason>` carrying OMA's own policy strings.",
  },
  {
    event: "PostToolUse",
    parseAccepted: true,
    firingObserved: true,
    note: "Fires after every tool call. IMPORTANT: its result message has no `decision` field, so emitting one fails protojson decoding and AGY reports it to the agent as `Encountered error in tool execution`. A PostToolUse hook must emit an empty object or its own valid result shape.",
  },
  {
    event: "SessionEnd",
    parseAccepted: true,
    firingObserved: false,
    note: "Parser accepted a spec using only this event, but it never fired under `agy -p` (one-shot). Its result shape is therefore unverified; emit `{}` rather than a decision object until firing is observed interactively.",
  },
  {
    event: "SessionStart",
    parseAccepted: false,
    firingObserved: false,
    note: "REJECTED by the runtime, measured 2026-09-11: `invalid hook \"<name>\": command hook must specify 'command'`. This is why the superpowers and *-connector plugins never load their hooks.",
  },
  {
    event: "UserPromptSubmit",
    parseAccepted: false,
    firingObserved: false,
    note: "Not probed on this host. Do not emit until captured.",
  },
  {
    event: "Stop",
    parseAccepted: false,
    firingObserved: false,
    note: "REJECTED by the runtime: `invalid hook \"<name>\": command hook must specify 'command'`. An unsupported event name makes the whole hooks.json unparseable.",
  },
] as const;

/**
 * Events the runtime's parser accepts, i.e. the only events safe to emit.
 * Deliberately excludes unprobed names rather than trusting the Claude/Gemini
 * hook vocabulary AGY partially emulates.
 */
export const EMITTABLE_HOOK_EVENTS: readonly string[] = HOOK_EVENT_EVIDENCE.filter(
  (entry) => entry.parseAccepted,
).map((entry) => entry.event);

export interface HookContractProblem {
  /** Dotted location of the defect, e.g. `oma-memory-summarizer.SessionEnd[0].hooks[0]`. */
  path: string;
  message: string;
}

export interface HookContractVerdict {
  valid: boolean;
  problems: HookContractProblem[];
  /** Hook names that would be registered if the file parses. */
  hookNames: string[];
  /** Events used by the file. */
  events: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reproduce the runtime's decision for a decoded hooks document.
 *
 * The important semantic is all-or-nothing: one problem means the runtime
 * registers zero hooks for the plugin, so `valid` is only true when there are
 * no problems at all.
 */
export function validateHooksDocument(document: unknown): HookContractVerdict {
  const problems: HookContractProblem[] = [];
  const hookNames: string[] = [];
  const events = new Set<string>();

  if (!isPlainObject(document)) {
    problems.push({ path: "", message: "hooks.json must decode to a JSON object." });
    return { valid: false, problems, hookNames, events: [] };
  }

  const names = Object.keys(document);
  if (names.length === 0) {
    problems.push({
      path: "",
      message: "hooks.json declares no hook: the runtime loads nothing from an empty object.",
    });
  }

  for (const name of names) {
    const spec = document[name];
    const specPath = name;

    if (!isPlainObject(spec)) {
      problems.push({
        path: specPath,
        message: `hook value must be an object (decoded ${Array.isArray(spec) ? "array" : typeof spec}). The runtime treats every top-level key as a hook name, so a scalar such as "description" is rejected as a malformed hook.`,
      });
      continue;
    }

    const specEvents = Object.keys(spec).filter((key) =>
      EMITTABLE_HOOK_EVENTS.includes(key),
    );
    const hasInlineCommand =
      typeof spec.command === "string" && spec.command.trim().length > 0;

    if (specEvents.length === 0 && !hasInlineCommand) {
      const declared = Object.keys(spec).filter((key) => key !== "enabled");
      const unsupported = declared.filter((key) => Array.isArray(spec[key]));
      problems.push({
        path: specPath,
        message:
          unsupported.length > 0
            ? `unsupported event name(s) ${unsupported
                .map((key) => `'${key}'`)
                .join(", ")}. The runtime ignores unknown events, then validates the spec as a command hook and fails with "command hook must specify 'command'". Emittable events: ${EMITTABLE_HOOK_EVENTS.join(", ")}.`
            : `hook declares neither a supported event (${EMITTABLE_HOOK_EVENTS.join(", ")}) nor a top-level 'command'.`,
      });
      continue;
    }

    hookNames.push(name);

    for (const event of specEvents) {
      events.add(event);
      const groups = spec[event];
      if (!Array.isArray(groups)) {
        problems.push({
          path: `${specPath}.${event}`,
          message: "event value must be an array of hook groups.",
        });
        continue;
      }
      groups.forEach((group, groupIndex) => {
        const groupPath = `${specPath}.${event}[${groupIndex}]`;
        if (!isPlainObject(group)) {
          problems.push({ path: groupPath, message: "hook group must be an object." });
          return;
        }
        const handlers = group.hooks;
        if (handlers === undefined) {
          problems.push({
            path: groupPath,
            message: "hook group must declare a 'hooks' array.",
          });
          return;
        }
        if (!Array.isArray(handlers)) {
          problems.push({ path: `${groupPath}.hooks`, message: "'hooks' must be an array." });
          return;
        }
        if (handlers.length === 0) {
          problems.push({
            path: `${groupPath}.hooks`,
            message: "'hooks' is empty: the group registers nothing.",
          });
        }
        handlers.forEach((handler, handlerIndex) => {
          const handlerPath = `${groupPath}.hooks[${handlerIndex}]`;
          if (!isPlainObject(handler)) {
            problems.push({ path: handlerPath, message: "hook handler must be an object." });
            return;
          }
          if (typeof handler.command !== "string" || handler.command.trim().length === 0) {
            problems.push({
              path: handlerPath,
              message: "hook handler must declare a non-empty 'command'.",
            });
          }
        });
      });
    }
  }

  return {
    valid: problems.length === 0,
    problems,
    hookNames,
    events: [...events],
  };
}

/** The runtime decodes with a plain JSON decoder, which rejects a leading BOM. */
export function hasUtf8Bom(raw: Buffer): boolean {
  return raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
}

/** Validate a hooks.json on disk, including the encoding the runtime rejects. */
export function validateHooksFile(path: string): HookContractVerdict & { parseError?: string } {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (error) {
    return {
      valid: false,
      problems: [],
      hookNames: [],
      events: [],
      parseError: error instanceof Error ? error.message : String(error),
    };
  }

  if (hasUtf8Bom(raw)) {
    return {
      valid: false,
      problems: [
        {
          path: "",
          message:
            "file starts with a UTF-8 BOM. The runtime decoder fails with \"invalid character '\\\\ufeff' looking for beginning of value\" and registers no hook. Write hooks.json as UTF-8 without BOM.",
        },
      ],
      hookNames: [],
      events: [],
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    return {
      valid: false,
      problems: [],
      hookNames: [],
      events: [],
      parseError: error instanceof Error ? error.message : String(error),
    };
  }

  return validateHooksDocument(decoded);
}

export interface HookHandlerSpec {
  type: "command";
  command: string;
  timeout?: number;
}

export interface HookGroupSpec {
  matcher: string;
  hooks: HookHandlerSpec[];
}

/**
 * Build the hooks.json OMA installs.
 *
 * Centralised and validated on purpose: the memory hook historically used the
 * unsupported `Stop` event, which discarded this entire file and disabled the
 * strict write gate along with it. `buildOmaHooks` refuses to return a document
 * the runtime would reject, so that regression cannot be reintroduced silently.
 */
export function buildOmaHooks(options: {
  writeGateCommand: string;
  memoryCommand: string;
  memoryEvent?: string;
}): Record<string, unknown> {
  const memoryEvent = options.memoryEvent ?? "SessionEnd";
  const document: Record<string, unknown> = {
    "oma-strict-write-gate": {
      enabled: true,
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: options.writeGateCommand, timeout: 10 }],
        },
      ],
    },
    "oma-memory-summarizer": {
      enabled: true,
      [memoryEvent]: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: options.memoryCommand, timeout: 30 }],
        },
      ],
    },
  };

  const verdict = validateHooksDocument(document);
  if (!verdict.valid) {
    throw new Error(
      `Refusing to install an invalid hooks.json (the runtime would register zero hooks): ${verdict.problems
        .map((problem) => `${problem.path || "<root>"}: ${problem.message}`)
        .join("; ")}`,
    );
  }
  return document;
}
