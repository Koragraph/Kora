export type PromptSelectionRange = {
  start: number;
  end: number;
};

export function didPromptSelectionChangeVisibly(
  previous: PromptSelectionRange,
  next: PromptSelectionRange | null,
): boolean {
  if (next === null || next.start === next.end) {
    return false;
  }
  return next.start !== previous.start || next.end !== previous.end;
}
