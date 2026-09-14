import { existsSync } from "node:fs";
import { MissionEventsStore } from "../ledger/mission-events.js";
import { eventsPathFor } from "./read-model.js";

/**
 * The interview gate, as a contract rather than a convention.
 *
 * The product requirement is explicit: **no run and no execution before the user has
 * answered and confirmed.** Until now that lived only as prose in the `oma-start` skill
 * — the test that "proved" it asserted a regular expression against a Markdown file, and
 * `ask_question` did not exist as a tool at all. A conductor could create a graph and
 * dispatch a node without ever asking anything, and nothing would notice.
 *
 * The gate below is written into the mission journal, so the answers are durable evidence
 * rather than a claim in a chat message, and every execution entry point consults it.
 */

export interface InterviewRecord {
  questions: string[];
  answers: string[];
  confirmed: boolean;
  at: string;
}

export interface InterviewGateOptions {
  workspaceRoot: string;
  missionId: string;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    entries.push(entry);
  }
  return entries;
}

/** The most recent recorded interview for a mission, or undefined when none exists. */
export function readInterview(options: InterviewGateOptions): InterviewRecord | undefined {
  const eventsPath = eventsPathFor(options.workspaceRoot, options.missionId);
  if (!existsSync(eventsPath)) return undefined;
  let events: ReturnType<typeof MissionEventsStore.readEvents>;
  try {
    events = MissionEventsStore.readEvents(eventsPath);
  } catch {
    return undefined;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "interview_recorded") continue;
    const record = event as unknown as Record<string, unknown>;
    const questions = asStringArray(record.questions) ?? [];
    const answers = asStringArray(record.answers) ?? [];
    return {
      questions,
      answers,
      confirmed: record.confirmed === true,
      at: typeof record.timestamp === "string" ? record.timestamp : "",
    };
  }
  return undefined;
}

/**
 * Record the interview that authorises this mission's execution.
 *
 * Refuses an interview with no question, or with a question the user never answered:
 * recording an unanswered question as "asked" is how a gate turns into a formality.
 */
export function recordInterview(
  options: InterviewGateOptions & {
    questions: unknown;
    answers: unknown;
    confirmed: unknown;
    conversationId?: unknown;
  },
): InterviewRecord {
  const questions = asStringArray(options.questions);
  const answers = asStringArray(options.answers);
  if (questions === undefined || answers === undefined) {
    throw new Error("record_interview requires 'questions' and 'answers' arrays of strings.");
  }
  const asked = questions.map((question) => question.trim()).filter((question) => question.length > 0);
  const replied = answers.map((answer) => answer.trim()).filter((answer) => answer.length > 0);
  if (asked.length === 0) {
    throw new Error("record_interview requires at least one non-empty question.");
  }
  if (replied.length === 0) {
    throw new Error(
      "record_interview requires the user's answers: an interview nobody answered cannot authorise execution.",
    );
  }

  const confirmed = options.confirmed === true;
  const eventsPath = eventsPathFor(options.workspaceRoot, options.missionId);
  MissionEventsStore.appendEvent(eventsPath, options.missionId, {
    type: "interview_recorded",
    questions: asked,
    answers: replied,
    confirmed,
    ...(typeof options.conversationId === "string" && options.conversationId.length > 0
      ? { conversationId: options.conversationId }
      : {}),
  });

  return { questions: asked, answers: replied, confirmed, at: new Date().toISOString() };
}

/**
 * Throws unless the user answered **and** confirmed this mission.
 *
 * The message names what is missing, because the caller is an agent that has to fix it.
 */
export function assertInterviewAuthorisesExecution(options: InterviewGateOptions): InterviewRecord {
  const interview = readInterview(options);
  if (interview === undefined) {
    throw new Error(
      `Mission '${options.missionId}' has no recorded interview. Ask the user the questions that matter and call 'record_interview' with their answers before any run is dispatched.`,
    );
  }
  if (interview.confirmed !== true) {
    throw new Error(
      `Mission '${options.missionId}' recorded an interview the user never confirmed. Execution stays blocked until 'record_interview' is called with confirmed=true.`,
    );
  }
  return interview;
}
