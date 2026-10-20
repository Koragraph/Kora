import { collectPromptInlineTokens } from "./promptInlineTokens.ts";

/**
 * Turns the composer's agent-neutral `$skill` mentions into the form each agent actually acts on.
 *
 *  - Claude Code only runs a skill from a message that STARTS with `/name`; a `$name` anywhere is prose it
 *    ignores. A leading mention becomes the slash command; a mention further in becomes plain words that
 *    steer the model to its own Skill tool.
 *  - Codex resolves `$name` in the prompt text itself, so its text is left alone.
 *  - Any other driver gets the text untouched (the mention still reads as a plain instruction).
 *
 * Only names in `known` are rewritten, so `$HOME` or `$PATH` in a pasted command stays exactly as typed.
 */
export function rewriteSkillMentions(
  text: string,
  driver: string,
  known: ReadonlyArray<{ readonly name: string }>,
): string {
  if (driver !== "claude" || known.length === 0 || !text.includes("$")) return text;
  const names = new Set(known.map((skill) => skill.name.trim().toLowerCase()));
  // The token grammar wants whitespace after a mention, but a sent message is trimmed: "$name" alone has none.
  const padded = `${text} `;
  const tokens = collectPromptInlineTokens(padded).filter(
    (token) => token.type === "skill" && names.has(token.value.toLowerCase()),
  );
  if (tokens.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const token of tokens) {
    out += padded.slice(cursor, token.start);
    const leading = padded.slice(0, token.start).trim().length === 0;
    out += leading ? `/${token.value}` : `the ${token.value} skill`;
    cursor = token.end;
  }
  return (out + padded.slice(cursor)).slice(0, -1);
}
