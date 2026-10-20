// @mention parsing for group messages. Names are matched against the GROUP'S members only (never the whole team), the
// longest name first, case-insensitively, and only at a word start ("a@popo.com" is not a mention). Code spans and
// fences are ignored so pasting `@Popo` in a snippet does not summon anyone.

export interface MentionTarget { id: string; name: string }

export interface ParsedMentions {
  /** Distinct addressed member ids, in order of first appearance. `@all` expands to every member except `exclude`. */
  ids: string[];
  /** `@all` / `@everyone` / `@team` / `@group` was used. */
  all: boolean;
  /** True when any mention (name or @all) was found. */
  any: boolean;
}

export const ALL_WORDS = ['all', 'everyone', 'team', 'group', 'everybody'] as const;

/** Blank out fenced and inline code (same length, so offsets stay put). */
export function maskCode(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return text.replace(/```[\s\S]*?(```|$)/g, blank).replace(/`[^`\n]*`/g, blank);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseMentions(text: string, members: readonly MentionTarget[], opts: { exclude?: string } = {}): ParsedMentions {
  const body = maskCode(text);
  const byLongest = [...members].sort((a, b) => b.name.length - a.name.length);
  const names = byLongest.map((m) => escapeRe(m.name.trim())).filter(Boolean);
  const alts = [...names.map((n) => `(?:${n.replace(/\s+/g, '\\s+')})`), ...ALL_WORDS.map(escapeRe)];
  if (!alts.length) return { ids: [], all: false, any: false };
  const re = new RegExp(`(^|[^\\w@.])@(${alts.join('|')})(?![\\w])`, 'gi');
  const found: string[] = [];
  let all = false;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const word = m[2].replace(/\s+/g, ' ').toLowerCase();
    const member = byLongest.find((x) => x.name.trim().replace(/\s+/g, ' ').toLowerCase() === word);
    if (member) found.push(member.id);          // a member literally named "Team" still wins over the keyword
    else { all = true; for (const x of members) found.push(x.id); }
  }
  const ids = [...new Set(found)].filter((id) => id !== opts.exclude);
  return { ids, all, any: found.length > 0 };
}

/** "Popo", "Popo and Junip", "Popo, Junip and Wobbo". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
