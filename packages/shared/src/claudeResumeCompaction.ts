/**
 * Copy for Claude's resume compaction dialog, shared by the server adapter
 * (which asks the question) and the web client (which recognizes the
 * question and its "never" answer in resolved user-input activities to
 * mirror the dismissal). Both sides must agree on these strings, so they
 * live here: reword the question or the answer label in this file only.
 */
export const CLAUDE_RESUME_COMPACTION_NEVER_ANSWER = "Don't ask again";

const AGE = String.raw`(?:\d+h \d+m|\d+m)`;
const TOKEN_COUNT = String.raw`\d{1,3}(?:,\d{3})*`;
const QUESTION_SHAPE = new RegExp(
  `^This session is ${AGE} old and uses ${TOKEN_COUNT} tokens\\. Compact it before continuing\\?$`,
  "u",
);

export function isClaudeResumeCompactionQuestion(question: string): boolean {
  return QUESTION_SHAPE.test(question);
}
