import { useLayoutEffect, useState } from "react";

const EDITOR = '[data-testid="composer-editor"]';
const px = (value: string) => Number.parseFloat(value);

/**
 * Whether the prompt's text needs more than one line. It measures the text itself, not the editor box (whose minimum
 * height can be taller than a line). Width is compared with the row's expanded width even while the actions sit
 * inline, so moving them in and out can't flip the answer back and forth. `null` while the editor is hidden.
 */
export function promptWraps(body: HTMLElement): boolean | null {
  const editor = body.querySelector<HTMLElement>(EDITOR);
  if (!editor?.clientWidth) return null;
  const bodyStyle = getComputedStyle(body);
  const fullWidth = body.clientWidth - px(bodyStyle.paddingLeft) - px(bodyStyle.paddingRight);
  const oneLine = px(getComputedStyle(editor).lineHeight);
  const text = document.createRange();
  text.selectNodeContents(editor);
  const { width, height } = text.getBoundingClientRect();
  // One pixel of slack for sub-pixel rounding.
  return height > oneLine + 1 || width > fullWidth + 1;
}

/** Calls `onChange` with `promptWraps` now and whenever the composer resizes or its text changes. */
function watchWrapping(body: HTMLElement, onChange: (wraps: boolean) => void): () => void {
  const update = () => {
    const answer = promptWraps(body);
    if (answer !== null) onChange(answer);
  };
  const sizes = new ResizeObserver(update);
  const edits = new MutationObserver(update);
  for (const el of [body, body.querySelector<HTMLElement>(EDITOR)]) if (el) sizes.observe(el);
  edits.observe(body, { subtree: true, childList: true, characterData: true });
  update();
  return () => {
    sizes.disconnect();
    edits.disconnect();
  };
}

/** Whether the composer's prompt runs past one line, kept current. */
export function usePromptWraps(body: HTMLElement | null): boolean {
  const [wraps, setWraps] = useState(false);
  useLayoutEffect(() => (body ? watchWrapping(body, setWraps) : undefined), [body]);
  return wraps;
}
