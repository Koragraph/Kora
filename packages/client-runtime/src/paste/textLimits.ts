export type PastedTextDisposition = "attachment" | "inline";

export function wouldTextPasteExceedLimit(input: {
  readonly maxLength: number;
  readonly textLength: number;
  readonly selection: { readonly start: number; readonly end: number };
  readonly valueLength: number;
}): boolean {
  const clamp = (position: number, floor: number) =>
    Math.max(floor, Math.min(input.valueLength, position));
  const from = clamp(input.selection.start, 0);
  const to = clamp(input.selection.end, from);
  const lengthAfterPaste = input.valueLength - (to - from) + input.textLength;
  return lengthAfterPaste > input.maxLength;
}
