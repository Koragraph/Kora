// A Claude Code pane's input box shows greyed "prompt suggestion" text after the ❯ prompt when nobody is typing (the
// interactive CLI predicts the user's next message). A screen read for the lead (kora_read, kora_wait's "end of its
// screen") would report that text as if a human had typed it. The live input box is the LAST ❯ row near the bottom of
// the screen (a hint/status line or two may follow); older ❯ rows are submitted prompts echoed into the scrollback and
// stay as they are. Text on that last row is marked, not dropped: it may also be something kora_prompt typed but not
// yet submitted, and the lead should still be able to see that.
const INPUT_ROW = /^(\s*[│|]?\s*)❯(\s+)(\S.*?)(\s*[│|]?\s*)$/;
/** How many non-empty rows from the bottom can still hold the input box (box border, ❯ row, hint lines). */
const BOTTOM_ROWS = 6;

export function markUnsentInput(screen: string): string {
  const rows = screen.split('\n');
  let seen = 0;
  for (let i = rows.length - 1; i >= 0 && seen < BOTTOM_ROWS; i--) {
    if (!rows[i]!.trim()) continue;
    seen++;
    const m = INPUT_ROW.exec(rows[i]!);
    if (!m) continue;
    rows[i] = `${m[1]}❯${m[2]}⟨unsent input-box text, not a user message (usually Claude's prompt suggestion): ${m[3]}⟩${m[4]}`;
    break; // only the live input row
  }
  return rows.join('\n');
}
