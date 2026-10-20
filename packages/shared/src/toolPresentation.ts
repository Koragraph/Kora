import type { ToolLifecycleItemType } from "@kora/contracts";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asTrimmedString = (value: unknown): string | undefined => {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? undefined : text;
};

export interface ToolActivityPresentationInput {
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly itemType?: ToolLifecycleItemType | null | undefined;
}

export interface ToolActivityPresentation {
  readonly detail?: string | undefined;
  readonly summary: string;
}

const QUESTION_TOOL_NAMES = /^(askuserquestion|requestuserinput(?:async)?|askquestion|question)$/;

/** `mcp__srv__Ask_User_Question` / `x.ask question` → `askuserquestion`. */
function bareToolName(qualified: string): string {
  const last = qualified.split(/__|[./]/).pop() ?? "";
  return last.replace(/[_\s]/g, "").toLowerCase();
}

function questionTextOf(entry: unknown): string | undefined {
  const fields = asRecord(entry);
  const candidates = [fields?.question, fields?.question_text, fields?.prompt, fields?.title];
  return asTrimmedString(candidates.find((candidate) => candidate != null));
}

export function projectQuestionToolInput(payload: Record<string, unknown>, fallbackName: unknown) {
  const data = payload;
  const item = asRecord(data.item);
  const toolName = [data.toolName, data.tool, item?.tool].find((v) => v != null) ?? fallbackName;
  const isQuestionTool =
    typeof toolName === "string" && QUESTION_TOOL_NAMES.test(bareToolName(toolName));
  const rawInput = isQuestionTool
    ? (data.input ?? data.rawInput ?? asRecord(data.state)?.input ?? item?.arguments)
    : undefined;
  const args = asRecord(rawInput);
  const questions = args?.questions ?? asRecord(args?.params)?.questions;
  if (!isQuestionTool || !Array.isArray(questions)) return {};
  // Clients match native tools to the canonical question; choices and answers
  // already live on the user-input activities and need not cross the wire twice.
  const projected = questions.map((entry) => ({ question: questionTextOf(entry) }));
  return { toolName, input: { questions: projected } };
}
