// Auto-answer known-safe Claude Code dialogs. Pure: screen text + pane facts in, a key plan out. The Runtime
// executes the plan (400 ms between keys) and logs it. Never answers Bash/Edit/Write permission prompts —
// those are the agent asking whether it may change the world; these three are the runtime asking about itself.
import path from 'node:path';
import { expandTilde } from '../util/os-roots';

export type AutoAnswerKind = 'trustFolder' | 'mcpFound' | 'readOutsideWorktree';
export interface AutoAnswerPolicy { trustFolder: boolean; mcpFound: boolean; readOutsideWorktree: boolean }
export interface AutoAnswerInput {
  screen: string;                 // pane.read source 'detection'
  cwd: string;                    // the pane's cwd
  mainRoot: string | null;        // the pane's worktree main checkout, if any
  trustedRoots: string[];
  policy: AutoAnswerPolicy;
}
export interface AutoAnswerPlan { kind: AutoAnswerKind; keys: string[]; detail: string }

export const KEY_UP = '\x1b[A', KEY_DOWN = '\x1b[B', KEY_ENTER = '\r';

export function isUnder(p: string, root: string): boolean {
  const a = path.resolve(p), r = path.resolve(root);
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}
const underAny = (p: string, roots: string[]) => roots.some((r) => r && isUnder(p, r));

interface Option { index: number; text: string; selected: boolean }
/**
 * Parse a Claude Code selection dialog's options, in the order shown, with the ❯-marked one flagged selected.
 * Two shapes are handled:
 *   1. Numbered   — "❯ 1. Yes, I trust this folder" / "  2. No, exit"
 *   2. Bare arrow — "❯ No, exit" / "  Yes, I trust this folder"  (current trust / MCP dialogs; NOT numbered, and the
 *      default is often the SAFE option, so a blind Enter would exit — we must count moves to the wanted option).
 * For the bare shape the option block is the contiguous run of non-empty lines containing the ❯ line, bounded by
 * blank lines and the "Enter to confirm …" footer / separators.
 */
export function parseOptions(screen: string): Option[] {
  const clean = screen.split('\n').map((r) => r.replace(/[│┃|]/g, ' ')); // drop box borders, keep indentation
  // 1. numbered
  const numbered: Option[] = [];
  for (const raw of clean) {
    const line = raw.trim();
    const m = /^(❯)?\s*(\d+)\.\s+(.*\S)$/.exec(line); if (!m) continue;
    numbered.push({ index: numbered.length, text: m[3].trim(), selected: !!m[1] });
  }
  if (numbered.length) return numbered;
  // 2. bare arrow-marked
  const isBlank = (l: string) => !l.trim();
  const isFooterOrSep = (l: string) => /enter to (?:confirm|select)|esc to|to cancel|↑\/?↓|press enter/i.test(l) || /^[─—–-]+$/.test(l.trim());
  const sel = clean.findIndex((l) => l.includes('❯'));
  if (sel < 0) return [];
  let lo = sel, hi = sel;
  while (lo - 1 >= 0 && !isBlank(clean[lo - 1]) && !isFooterOrSep(clean[lo - 1])) lo--;
  while (hi + 1 < clean.length && !isBlank(clean[hi + 1]) && !isFooterOrSep(clean[hi + 1])) hi++;
  const out: Option[] = [];
  for (let i = lo; i <= hi; i++) {
    const text = clean[i].replace('❯', '').trim();
    if (!text) continue;
    // A narrow pane wraps an option ("Yes, I trust this" / "folder"): a line with no ❯ that starts lowercase is the
    // tail of the previous option, not an option of its own — counting it would put the cursor one row off.
    if (out.length && !clean[i].includes('❯') && /^[a-z]/.test(text)) { out[out.length - 1].text += ' ' + text; continue; }
    out.push({ index: out.length, text, selected: clean[i].includes('❯') });
  }
  return out;
}
/** Keys that move from the current selection to the option matching `want`, then confirm. null when it is not on screen. */
export function selectOption(options: Option[], want: RegExp): { keys: string[]; text: string } | null {
  const target = options.find((o) => want.test(o.text)); if (!target) return null;
  const cur = options.find((o) => o.selected)?.index ?? 0;
  const delta = target.index - cur;
  const moves = delta > 0 ? Array(delta).fill(KEY_DOWN) : Array(-delta).fill(KEY_UP);
  return { keys: [...moves, KEY_ENTER], text: target.text };
}

const BASH_OR_EDIT = /\bbash command\b|\bbash\(|\bedit\(|\bwrite\(|\bmultiedit\(|\bnotebookedit\(|tab to amend|ctrl\+e to explain/i;

export function planAutoAnswer(i: AutoAnswerInput): AutoAnswerPlan | null {
  const s = i.screen; const lower = s.toLowerCase();
  if (BASH_OR_EDIT.test(s)) return null;
  const options = parseOptions(s);
  // The phrase tests run on whitespace-collapsed text: in a narrow pane Claude wraps "Do you trust the files in this
  // folder?" across lines and a line-based match misses the dialog entirely (measured: a 22-column pane sat blocked).
  const flat = s.replace(/[│┃|]/g, ' ').replace(/\s+/g, ' ');
  // 1. trust dialog — only when the cwd is under a configured trusted root
  if (i.policy.trustFolder && /is this a project you created or one you trust|do you trust the files in this folder/i.test(flat)) {
    if (!underAny(i.cwd, i.trustedRoots)) return null;
    const sel = selectOption(options, /^yes\b/i); if (!sel) return null;
    return { kind: 'trustFolder', keys: sel.keys, detail: `${sel.text} — ${i.cwd}` };
  }
  // 2. new MCP server found — pick "Use this MCP server" (not "all future"), never "continue without"
  if (i.policy.mcpFound && lower.includes('new mcp server found')) {
    // A project's .mcp.json names a command to run. Only under a root the user has declared trusted.
    if (!underAny(i.cwd, i.trustedRoots)) return null;
    const sel = selectOption(options, /^use this mcp server\b/i); if (!sel) return null;
    const name = /new mcp server found[^:\n]*:\s*([^\n]+)/i.exec(s)?.[1]?.trim() ?? '';
    return { kind: 'mcpFound', keys: sel.keys, detail: `${sel.text}${name ? ` — ${name}` : ''}` };
  }
  // 3. read outside the working directory — only when the target is the main checkout or a trusted root
  if (i.policy.readOutsideWorktree && /read outside|outside (?:of )?(?:the )?working director/i.test(flat) && /\bread\(/i.test(flat)) {
    const m = /Read\(([^)\n]+)\)/.exec(flat); if (!m) return null;
    const target = path.resolve(i.cwd, expandTilde(m[1].trim()));
    const roots = [...i.trustedRoots, ...(i.mainRoot ? [i.mainRoot] : [])];
    if (!underAny(target, roots)) return null;
    const sel = selectOption(options, /^yes\b/i); if (!sel) return null;
    return { kind: 'readOutsideWorktree', keys: sel.keys, detail: `${sel.text} — ${m[1].trim()}` };
  }
  return null;
}
