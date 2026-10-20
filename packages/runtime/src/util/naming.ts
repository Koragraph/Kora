// Pure naming helpers shared across the engine and any frontend. Lives outside src/server so a
// frontend (TUI, Electron GUI) can derive a pane name without importing the Runtime god-object.

/**
 * First ~28 chars of the first prompt, cut at a word boundary, no trailing punctuation. A long identifier straddling
 * the cut is kept whole up to `max + 10` ("what does resolveProjectScope" beats "what does resolveProjectScop").
 */
export function autoName(firstPrompt: string, max = 28): string {
  const t = firstPrompt.replace(/\s+/g, ' ').trim(); if (!t) return '';
  if (t.length <= max) return t.replace(/[\s.,;:!?…\-]+$/, '');
  let cut = t.slice(0, max); const sp = cut.lastIndexOf(' ');
  const wordEnd = t.indexOf(' ', max); const whole = wordEnd < 0 ? t.length : wordEnd;
  if (t[max] === ' ') cut = t.slice(0, max);
  else if (whole <= max + 10 && /^[A-Za-z0-9_]+$/.test(t.slice(sp + 1, whole)) && /[a-z][A-Z]|_|\d/.test(t.slice(sp + 1, whole))) cut = t.slice(0, whole); // a code identifier (camel/snake/digits), not a plain word or a path
  else if (sp >= max * 0.5) cut = cut.slice(0, sp);
  return cut.replace(/[\s.,;:!?…\-]+$/, '');
}
