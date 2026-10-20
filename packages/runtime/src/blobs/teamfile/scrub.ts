// The scrubber. A team file is shared with other people, so nothing secret-looking may leave: API keys and tokens, private
// keys, passwords in text, credentials inside URLs, and the personal identifiers that tend to sit next to them (emails,
// the user's home folder). It is heuristic on purpose - it errs toward removing - and it REPORTS what it removed so the
// export dialog can say "3 secrets removed from Popo's SOUL". Pure; also used on import (a file can carry secrets too).

export type ScrubKind = 'api-key' | 'token' | 'private-key' | 'password' | 'url-credentials' | 'email' | 'home-path' | 'long-secret';
export interface ScrubFinding { kind: ScrubKind; count: number }
export interface ScrubResult { text: string; findings: ScrubFinding[]; removed: number }

export const REDACTED = '[removed]';

interface Rule { kind: ScrubKind; re: RegExp; replace: string | ((m: string, ...g: string[]) => string) }

// Order matters: specific shapes first, the generic "looks random" rule last.
const RULES: Rule[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: '[private key removed]' },
  { kind: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, replace: (_m, scheme) => `${scheme}${REDACTED}@` },
  // vendor-shaped keys / tokens
  { kind: 'api-key', re: /\bsk-(?:ant-|proj-|live-|or-)?[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { kind: 'api-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  { kind: 'api-key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replace: REDACTED },
  { kind: 'api-key', re: /\b(?:pk|rk|sk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g, replace: REDACTED },
  { kind: 'api-key', re: /\bcmp_[A-Za-z0-9_-]{16,}\b/g, replace: REDACTED },
  { kind: 'token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, replace: REDACTED },
  { kind: 'token', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, replace: REDACTED },
  { kind: 'token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: REDACTED },
  { kind: 'token', re: /\bglpat-[A-Za-z0-9_-]{16,}\b/g, replace: REDACTED },
  { kind: 'token', re: /\bnpm_[A-Za-z0-9]{30,}\b/g, replace: REDACTED },
  { kind: 'token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, replace: REDACTED },   // JWT
  { kind: 'token', re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: (_m, scheme) => `${scheme} ${REDACTED}` },
  // "password: hunter2", "api_key = abc...", "token=..." (key names, then the value)
  { kind: 'password', re: /\b((?:pass(?:word|wd|phrase)?|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token|client[_-]?secret)["']?\s*[:=]\s*["']?)(?!\[removed\])[^\s"',;]{4,}/gi, replace: (_m, head) => `${head}${REDACTED}` },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, replace: '[email removed]' },
  { kind: 'home-path', re: /\/Users\/[^/\s"'`]+/g, replace: '~' },
  { kind: 'home-path', re: /\/home\/[^/\s"'`]+/g, replace: '~' },
  { kind: 'home-path', re: /\b[A-Z]:\\Users\\[^\\\s"'`]+/g, replace: '~' },
];

/** A token that "looks like a secret": 32+ chars, no spaces, mixes letters and digits (or is hex/base64), not a path or URL. */
const LONG_SECRET = /(?<![\w/.-])[A-Za-z0-9+/_=-]{32,}(?![\w/.-])/g;
function looksSecret(s: string): boolean {
  if (/^\[/.test(s) || /^https?:/i.test(s)) return false;
  const digits = (s.match(/\d/g) ?? []).length;
  const upper = (s.match(/[A-Z]/g) ?? []).length;
  const lower = (s.match(/[a-z]/g) ?? []).length;
  if (/^[0-9a-f]{32,}$/i.test(s)) return true;                                   // hex digest / key
  if (digits < 3 || (upper + lower) < 3) return false;                           // prose-like words and long numbers stay
  if (/^[a-z]+(?:-[a-z]+){3,}$/.test(s)) return false;                           // kebab-case-names-like-this
  return digits >= 3 && (upper > 0 && lower > 0 || /[+/=_]/.test(s));
}

export function scrubText(input: string): ScrubResult {
  let text = input;
  const counts = new Map<ScrubKind, number>();
  const bump = (k: ScrubKind) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args) => {
      const m = args[0] as string;
      // the replace callbacks take the captures positionally
      const groups = args.slice(1, -2).filter((x) => typeof x === 'string') as string[];
      bump(rule.kind);
      return typeof rule.replace === 'string' ? rule.replace : rule.replace(m, ...groups);
    });
  }
  text = text.replace(LONG_SECRET, (m) => { if (!looksSecret(m)) return m; bump('long-secret'); return REDACTED; });
  const findings = [...counts].map(([kind, count]) => ({ kind, count }));
  return { text, findings, removed: findings.reduce((n, f) => n + f.count, 0) };
}

/** Merge findings lists (per field -> per file). */
export function mergeFindings(...lists: ScrubFinding[][]): ScrubFinding[] {
  const m = new Map<ScrubKind, number>();
  for (const l of lists) for (const f of l) m.set(f.kind, (m.get(f.kind) ?? 0) + f.count);
  return [...m].map(([kind, count]) => ({ kind, count }));
}

export const SCRUB_LABEL: Record<ScrubKind, string> = {
  'api-key': 'API keys', token: 'tokens', 'private-key': 'private keys', password: 'passwords', 'url-credentials': 'logins inside links',
  email: 'email addresses', 'home-path': 'your home folder path', 'long-secret': 'secret-looking strings',
};

/** Control and direction-override characters that make text read differently from what it says. */
export function cleanText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, '');
}
