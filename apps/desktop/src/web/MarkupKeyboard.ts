import type { WebMarkupSubmission } from "@kora/contracts";

interface MarkupKeyboardEvent {
  readonly isComposing: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly key: string;
}

export function resolveMarkupSubmission(evt: MarkupKeyboardEvent): WebMarkupSubmission | null {
  // Enter submits the comment field like the Attach button; Shift+Enter is a newline.
  if (evt.key !== "Enter" || evt.shiftKey || evt.isComposing) return null;
  return "attach";
}
