import { AskAttachmentAnswerPayload, type ChatThreadActivity } from "@kora/contracts";
import { projectQuestionToolInput } from "@kora/shared/toolPresentation";
import * as Schema from "effect/Schema";

type Fields = Record<string, unknown>;

/** A plain object, or undefined for anything else (arrays included). */
function fieldsOf(value: unknown): Fields | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Fields;
}

const isAnswerPayload = Schema.is(AskAttachmentAnswerPayload);

const QUESTION_KINDS = new Set([
  "user-input.requested",
  "user-input.resolved",
  "user-input.answer-submitted",
]);
const ABANDONED_TOOL_STATUS = /^(failed|declined|stopped|cancelled)$/;

/** Swap option values for their labels, at any depth of `{ answers }` nesting. */
function withOptionLabels(answer: unknown, labelOf: ReadonlyMap<string, string>): unknown {
  if (typeof answer === "string") return labelOf.get(answer) ?? answer;
  if (Array.isArray(answer)) return answer.map((item) => withOptionLabels(item, labelOf));
  const holder = fieldsOf(answer);
  if (holder === undefined || !("answers" in holder)) return answer;
  return { ...holder, answers: withOptionLabels(holder.answers, labelOf) };
}

/** Identity of "these questions in this turn", or undefined when any question text is missing. */
function questionSetKey(turnId: string, questionTexts: ReadonlyArray<unknown>): string | undefined {
  if (questionTexts.length === 0) return undefined;
  const trimmed: string[] = [];
  for (const text of questionTexts) {
    const value = typeof text === "string" ? text.trim() : "";
    if (value === "") return undefined;
    trimmed.push(value);
  }
  // `.sort()` on our own copy: Hermes (mobile) has no `toSorted`.
  return JSON.stringify([turnId, trimmed.sort()]);
}

const toolKey = (turnId: string | null, toolCallId: string) => JSON.stringify([turnId, toolCallId]);

/**
 * A native question tool and the answer card can describe the same question. Once an answer
 * card exists for a turn's question set, hide the matching tool rows (unless they failed).
 */
function hideAnsweredQuestionTools(
  activities: ReadonlyArray<ChatThreadActivity>,
): ReadonlyArray<ChatThreadActivity> {
  const answeredSets = new Set<string>();
  for (const { kind, turnId, payload } of activities) {
    if (kind !== "user-input.answer-submitted" || !turnId) continue;
    const texts = Object.values(fieldsOf(fieldsOf(payload)?.questionTextById) ?? {});
    const key = questionSetKey(turnId, texts);
    if (key !== undefined) answeredSets.add(key);
  }
  if (answeredSets.size === 0) return activities;

  const hiddenTools = new Set<string>();
  for (const { kind, turnId, payload } of activities) {
    const fields = fieldsOf(payload);
    if (!kind.startsWith("tool.") || !turnId || typeof fields?.toolCallId !== "string") continue;
    const projected = projectQuestionToolInput(fieldsOf(fields.data) ?? {}, fields.title).input;
    if (projected === undefined) continue;
    const key = questionSetKey(
      turnId,
      projected.questions.map((question) => fieldsOf(question)?.question),
    );
    if (key !== undefined && answeredSets.has(key))
      hiddenTools.add(toolKey(turnId, fields.toolCallId));
  }

  return activities.filter((activity) => {
    const fields = fieldsOf(activity.payload);
    const callId = fields?.toolCallId;
    const isHiddenTool =
      activity.kind.startsWith("tool.") &&
      typeof callId === "string" &&
      hiddenTools.has(toolKey(activity.turnId, callId));
    // Failures stay visible: they explain why the question never got an answer.
    const failed = activity.tone === "error" || ABANDONED_TOOL_STATUS.test(String(fields?.status));
    return failed || !isHiddenTool;
  });
}

/** The single answer card one request's activities fold into, or undefined when they do not form one. */
function answerCardFor(
  requestId: string,
  rows: ReadonlyArray<ChatThreadActivity>,
): ChatThreadActivity | undefined {
  const payloads = rows.map((row) => fieldsOf(row.payload)!);

  const questionsById = new Map<string, Fields>();
  const textById = new Map<string, unknown>();
  for (const payload of payloads) {
    Object.entries(fieldsOf(payload.questionTextById) ?? {}).forEach(([id, text]) =>
      textById.set(id, text),
    );
    const listed = Array.isArray(payload.questions) ? payload.questions.map(fieldsOf) : [];
    listed.forEach((question) => {
      const id = question?.id;
      if (question === undefined || typeof id !== "string") return;
      questionsById.set(id, question);
      if (typeof question.question === "string") textById.set(id, question.question);
    });
  }

  const answersIn = (payload: Fields | undefined) => fieldsOf(payload?.answers);
  const submittedRow = rows.findLast(
    (row) =>
      row.kind === "user-input.answer-submitted" && answersIn(fieldsOf(row.payload)) !== undefined,
  );
  const rawAnswers =
    answersIn(fieldsOf(submittedRow?.payload)) ??
    payloads.map(answersIn).findLast((found) => found !== undefined) ??
    {};

  const labelsFor = (questionId: string) => {
    const labels = new Map<string, string>();
    const options = questionsById.get(questionId)?.options;
    for (const candidate of Array.isArray(options) ? options : []) {
      const option = fieldsOf(candidate);
      if (typeof option?.value === "string" && typeof option.label === "string")
        labels.set(option.value, option.label);
    }
    return labels;
  };
  const answers = Object.fromEntries(
    Object.entries(rawAnswers).map(([questionId, value]) => [
      questionId,
      withOptionLabels(value, labelsFor(questionId)),
    ]),
  );
  const attachmentsByQuestionId = Object.fromEntries(
    payloads.flatMap((payload) => Object.entries(fieldsOf(payload.attachmentsByQuestionId) ?? {})),
  );

  const card = {
    requestId,
    questionTextById: Object.fromEntries(textById),
    answers,
    attachmentsByQuestionId,
  };
  if (!isAnswerPayload(card)) return undefined;

  const answered =
    Object.keys(answers).length > 0 || Object.keys(attachmentsByQuestionId).length > 0;
  const dismissed = rows.some((row) => row.kind === "user-input.resolved");
  return {
    ...rows[0]!,
    kind: "user-input.answer-submitted",
    tone: "tool",
    summary: answered
      ? "User input submitted"
      : dismissed
        ? "User input dismissed"
        : "User input requested",
    payload: card,
  };
}

/** Keep a question and its answer at the original tool position in the work log. */
export function foldUserInputActivities(
  activities: ReadonlyArray<ChatThreadActivity>,
): ReadonlyArray<ChatThreadActivity> {
  const rowsByRequest = new Map<string, ChatThreadActivity[]>();
  for (const activity of activities) {
    if (!QUESTION_KINDS.has(activity.kind)) continue;
    const requestId = fieldsOf(activity.payload)?.requestId;
    if (typeof requestId !== "string" || requestId === "") continue;
    const rows = rowsByRequest.get(requestId);
    if (rows === undefined) rowsByRequest.set(requestId, [activity]);
    else rows.push(activity);
  }

  // A folded request shows as one card where its first row was; its other rows disappear.
  const replaced = new Map<ChatThreadActivity, ChatThreadActivity | null>();
  rowsByRequest.forEach((rows, requestId) => {
    const card = answerCardFor(requestId, rows);
    if (card === undefined) return;
    rows.forEach((row) => replaced.set(row, null));
    replaced.set(rows[0]!, card);
  });

  const folded = activities.flatMap((activity) => {
    if (!replaced.has(activity)) return [activity];
    const card = replaced.get(activity);
    return card ? [card] : [];
  });
  return hideAnsweredQuestionTools(folded);
}

/** The text of an answer: strings as-is, lists joined with ", ", `{ answers }` unwrapped. */
export function getQuestionAnswerText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map(getQuestionAnswerText)
      .filter((text) => text !== "")
      .join(", ");
  const holder = fieldsOf(value);
  return holder === undefined ? "" : getQuestionAnswerText(holder.answers);
}

/** One line for a collapsed card: the typed answers, else the file names, else the questions. */
export function getQuestionAnswerPreview(answer: AskAttachmentAnswerPayload): string {
  const typed = Object.values(answer.answers).map(getQuestionAnswerText).filter(Boolean);
  const files = Object.values(answer.attachmentsByQuestionId).flatMap((list) =>
    list.map(({ name }) => name),
  );
  const asked = Object.values(answer.questionTextById ?? {});
  const line =
    typed.length > 0 ? typed.join(" · ") : files.length > 0 ? files.join(", ") : asked.join(" · ");
  return line.replace(/\s+/g, " ").trim();
}

export function hasQuestionAnswer(answer: AskAttachmentAnswerPayload): boolean {
  const typedSomething = Object.values(answer.answers).some(
    (value) => getQuestionAnswerText(value) !== "",
  );
  return (
    typedSomething || Object.values(answer.attachmentsByQuestionId).some((list) => list.length > 0)
  );
}
