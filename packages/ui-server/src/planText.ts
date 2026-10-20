// A plan-mode turn of a harness without a plan tool (Codex, OpenCode, Antigravity) ends with its answer, and that answer
// is the plan card. A clarifying question is not a plan: the card (Implement / Implement in a new thread) is only for a
// reply that reads as one.

/** A heading, a bullet or a numbered step in the reply, and not a short question back to the user. */
export function looksLikePlan(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const structured = /^\s{0,3}(?:#{1,6}\s+\S|[-*+]\s+\S|\d+[.)]\s+\S)/m.test(t);
  const askingBack = t.length < 400 && /\?\s*$/.test(t);
  return structured && !askingBack;
}
