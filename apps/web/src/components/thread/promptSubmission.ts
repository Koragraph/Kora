import { expandAssistantFootnotesForAgent } from "@kora/shared/assistantFootnotes";
import { AGENT_SEND_TURN_MAX_INPUT_CHARS } from "@kora/contracts";

type PromptSubmitEvent = { preventDefault: () => void };

type PromptSubmissionInput = {
  submissionTarget: "provider-turn" | "pending-user-input";
  providerInput?: string;
  prompt: string;
};

export function getPromptLengthValidationMessage(prompt: string): string | null {
  const trimmed = prompt.trim();
  const expandedLength = expandAssistantFootnotesForAgent(trimmed).length;
  const inputLength = Math.max(trimmed.length, expandedLength);
  const excessCharacters = inputLength - AGENT_SEND_TURN_MAX_INPUT_CHARS;
  if (excessCharacters <= 0) return null;

  const characterLabel = excessCharacters === 1 ? "character" : "characters";
  return `Prompt is ${excessCharacters.toLocaleString("en-US")} ${characterLabel} over the ${AGENT_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")}-character limit. Shorten or split it before sending.`;
}

export function getPromptSubmissionValidationMessage(
  options: PromptSubmissionInput,
): string | null {
  return options.submissionTarget === "provider-turn"
    ? getPromptLengthValidationMessage(options.providerInput ?? options.prompt)
    : null;
}

export function submitPromptDraft(
  options: PromptSubmissionInput & {
    event: PromptSubmitEvent | undefined;
    onSend: (event?: PromptSubmitEvent) => boolean | void;
  },
): { validationMessage: string | null; didDispatch: boolean } {
  const validationMessage = getPromptSubmissionValidationMessage(options);
  if (validationMessage) {
    options.event?.preventDefault();
    return { didDispatch: false, validationMessage };
  }

  if (options.onSend(options.event) === false) {
    options.event?.preventDefault();
    return { didDispatch: false, validationMessage: null };
  }
  return { didDispatch: true, validationMessage: null };
}
