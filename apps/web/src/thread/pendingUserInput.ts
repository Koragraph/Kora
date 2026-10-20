import type { AskQuestion } from "@kora/contracts";

export interface PendingQuestionDraftAnswer {
  attachmentsBlocked?: boolean;
  attachmentCount?: number;
  customAnswer?: string;
  selectedOptionValues?: string[];
}

export interface PendingQuestionProgress {
  canAdvance: boolean;
  isComplete: boolean;
  isLastQuestion: boolean;
  answeredQuestionCount: number;
  usingCustomAnswer: boolean;
  resolvedAnswer: string | string[] | null;
  customAnswer: string;
  selectedOptionValues: string[];
  activeDraft: PendingQuestionDraftAnswer | undefined;
  activeQuestion: AskQuestion | null;
  questionIndex: number;
}

export interface PendingUserInputDrafts {
  answers: Record<string, Record<string, PendingQuestionDraftAnswer>>;
  indexes: Record<string, number>;
}

const STORAGE_KEY = "kora.pendingUserInput.v1";
const MAX_REMEMBERED_REQUESTS = 20;

const optionValue = (option: { value?: string | undefined; label: string }) =>
  option.value ?? option.label;
const allowsCustom = (question: AskQuestion) => question.allowCustomAnswer !== false;

function selectedValues(draftAnswer: PendingQuestionDraftAnswer | undefined): string[] {
  const unparsed = draftAnswer?.selectedOptionValues;
  if (!Array.isArray(unparsed)) return [];
  return [...new Set(unparsed.filter((value): value is string => typeof value === "string"))];
}

/** `null` means "not answerable yet"; an empty string is a valid, attachments-only answer. */
export function resolvePendingQuestionAnswer(
  question: AskQuestion,
  draftAnswer: PendingQuestionDraftAnswer | undefined,
): string | string[] | null {
  if (draftAnswer?.attachmentsBlocked) return null;
  if (allowsCustom(question)) {
    const custom = draftAnswer?.customAnswer?.trim() ?? "";
    if (custom !== "") return custom;
  }
  const recognised = new Set(question.options.map(optionValue));
  const chosen = selectedValues(draftAnswer).filter((value) => recognised.has(value));
  const attachmentsOnly = allowsCustom(question) && (draftAnswer?.attachmentCount ?? 0) > 0;
  if (question.multiSelect) {
    if (chosen.length > 0) return chosen;
    return attachmentsOnly ? "" : null;
  }
  if (chosen.length > 0) return chosen[0]!;
  return attachmentsOnly ? "" : null;
}

export function setPendingQuestionCustomAnswer(
  draftAnswer: PendingQuestionDraftAnswer | undefined,
  customAnswer: string,
): PendingQuestionDraftAnswer {
  const retained = customAnswer.trim() === "" ? selectedValues(draftAnswer) : [];
  return {
    customAnswer,
    ...(retained.length > 0 ? { selectedOptionValues: retained } : {}),
  };
}

export function togglePendingQuestionOptionSelection(
  question: AskQuestion,
  draftAnswer: PendingQuestionDraftAnswer | undefined,
  val: string,
): PendingQuestionDraftAnswer {
  if (!question.multiSelect) return { customAnswer: "", selectedOptionValues: [val] };
  const live = selectedValues(draftAnswer);
  const upcoming = live.includes(val) ? live.filter((value) => value !== val) : [...live, val];
  return { customAnswer: "", ...(upcoming.length > 0 ? { selectedOptionValues: upcoming } : {}) };
}

export function buildPendingQuestionAnswers(
  questions: ReadonlyArray<AskQuestion>,
  typedAnswers: Record<string, PendingQuestionDraftAnswer>,
): Record<string, string | string[]> | null {
  const collected: Array<[string, string | string[]]> = [];
  for (const question of questions) {
    const resolved = resolvePendingQuestionAnswer(question, typedAnswers[question.id]);
    if (resolved === null) return null;
    collected.push([question.id, resolved]);
  }
  return Object.fromEntries(collected);
}

export function countAnsweredQuestions(
  questions: ReadonlyArray<AskQuestion>,
  typedAnswers: Record<string, PendingQuestionDraftAnswer>,
): number {
  return questions.filter((q) => resolvePendingQuestionAnswer(q, typedAnswers[q.id]) !== null)
    .length;
}

export function derivePendingQuestionProgress(
  questions: ReadonlyArray<AskQuestion>,
  typedAnswers: Record<string, PendingQuestionDraftAnswer>,
  currentIndex: number,
): PendingQuestionProgress {
  const pos =
    questions.length === 0 ? 0 : Math.max(0, Math.min(currentIndex, questions.length - 1));
  const activeQuestion = questions[pos] ?? null;
  const activeDraft = activeQuestion ? typedAnswers[activeQuestion.id] : undefined;
  const customAnswer =
    activeQuestion && allowsCustom(activeQuestion) ? (activeDraft?.customAnswer ?? "") : "";
  const resolvedAnswer = activeQuestion
    ? resolvePendingQuestionAnswer(activeQuestion, activeDraft)
    : null;

  return {
    questionIndex: pos,
    activeQuestion,
    activeDraft,
    selectedOptionValues: selectedValues(activeDraft),
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer: customAnswer.trim() !== "",
    answeredQuestionCount: countAnsweredQuestions(questions, typedAnswers),
    isLastQuestion: questions.length === 0 || pos === questions.length - 1,
    isComplete: buildPendingQuestionAnswers(questions, typedAnswers) !== null,
    canAdvance: resolvedAnswer !== null,
  };
}

// ---------- tab-lifetime persistence ----------

function defaultSession(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

const isObject = (value: unknown): value is Record<string, never> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function readPendingUserInputDrafts(
  storage: Pick<Storage, "getItem"> | null = defaultSession(),
): PendingUserInputDrafts {
  const empty: PendingUserInputDrafts = { answers: {}, indexes: {} };
  try {
    const unparsed = storage?.getItem(STORAGE_KEY);
    if (!unparsed) return empty;
    const decoded: unknown = JSON.parse(unparsed);
    if (!isObject(decoded)) return empty;
    return {
      answers: isObject(decoded.answers)
        ? (decoded.answers as PendingUserInputDrafts["answers"])
        : {},
      indexes: isObject(decoded.indexes)
        ? (decoded.indexes as PendingUserInputDrafts["indexes"])
        : {},
    };
  } catch {
    return empty;
  }
}

const newest = <Val>(entries: Record<string, Val>): Record<string, Val> =>
  Object.fromEntries(Object.entries(entries).slice(-MAX_REMEMBERED_REQUESTS));

export function writePendingUserInputDrafts(
  drafts: PendingUserInputDrafts,
  storage: Pick<Storage, "setItem"> | null = defaultSession(),
): void {
  try {
    storage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ answers: newest(drafts.answers), indexes: newest(drafts.indexes) }),
    );
  } catch {
    /* private window or quota: simply no restore */
  }
}
