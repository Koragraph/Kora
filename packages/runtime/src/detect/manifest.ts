// Manifest-driven agent state detection: pure functions that load TOML rule files from
// manifests/*.toml and evaluate them (priority-ordered gates over a region of the screen) against a snapshot.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { AgentState } from '../protocol/types';

export interface DetectionSnapshot { screen: string; oscTitle: string; oscProgress: string }
export interface Detection {
  state: AgentState;          // state of the matched rule (or fallback)
  blocker: string | null;     // relevant line when blocked
  ruleId: string | null;      // null when no rule matched
  matched: boolean;
  skipStateUpdate: boolean;   // matched rule says "do not touch the published state"
  visibleIdle: boolean; visibleBlocker: boolean; visibleWorking: boolean;
}

interface Gate { all: Gate[]; any: Gate[]; not: Gate[]; contains: string[]; regex: RegExp[]; lineRegex: RegExp[] }
export interface Rule {
  id: string; state: AgentState; priority: number; region: string;
  visibleIdle: boolean; visibleBlocker: boolean; visibleWorking: boolean; skipStateUpdate: boolean;
  gate: Gate; rawContains: string[];
}
export interface Manifest { id: string; version: string | null; aliases: string[]; rules: Rule[] }

// ---------- regex conversion (Rust regex syntax → JS) ----------
export function convertRegex(pattern: string): RegExp {
  let flags = 'u';
  let p = pattern;
  const m = /^\(\?([imsx]+)\)/.exec(p);
  if (m) { p = p.slice(m[0].length); for (const f of m[1]) if ('ims'.includes(f) && !flags.includes(f)) flags += f; }
  p = p.replace(/\\x\{([0-9a-fA-F]+)\}/g, (_, h) => `\\u{${h}}`);
  p = p.replace(/\\A/g, '^').replace(/\\z/g, '$');
  try { return new RegExp(p, flags); }
  catch { return new RegExp(p, flags.replace('u', '')); }
}

function toArr(v: unknown): string[] { return Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]; }
function compileGate(g: any): Gate {
  return {
    all: toArr2(g.all).map(compileGate), any: toArr2(g.any).map(compileGate), not: toArr2(g.not).map(compileGate),
    contains: toArr(g.contains).map((s) => s.toLowerCase()),
    regex: toArr(g.regex).map(convertRegex), lineRegex: toArr(g.line_regex).map(convertRegex),
  };
}
function toArr2(v: unknown): any[] { return Array.isArray(v) ? v : v == null ? [] : [v]; }

export function parseManifest(text: string): Manifest {
  const doc: any = parseToml(text);
  const rules: Rule[] = toArr2(doc.rules).map((r: any) => ({
    id: String(r.id), state: (r.state as AgentState) || 'unknown', priority: Number(r.priority ?? 0), region: String(r.region ?? 'whole_recent').trim(),
    visibleIdle: !!r.visible_idle, visibleBlocker: !!r.visible_blocker, visibleWorking: !!r.visible_working, skipStateUpdate: !!r.skip_state_update,
    gate: compileGate(r), rawContains: toArr(r.contains),
  }));
  return { id: String(doc.id), version: doc.version ? String(doc.version) : null, aliases: toArr(doc.aliases), rules };
}

export function manifestsDir(): string {
  const candidates = [path.resolve(__dirname, '../../manifests'), path.resolve(process.cwd(), 'manifests')];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'index.toml'))) return c;
  return candidates[0];
}

let cache: Map<string, Manifest> | null = null;
export function loadManifests(dir = manifestsDir()): Map<string, Manifest> {
  if (cache) return cache;
  const out = new Map<string, Manifest>();
  try {
    const index: any = parseToml(fs.readFileSync(path.join(dir, 'index.toml'), 'utf8'));
    for (const entry of toArr2(index.agents)) {
      try {
        const m = parseManifest(fs.readFileSync(path.join(dir, String(entry.path)), 'utf8'));
        out.set(String(entry.id), m);
        for (const a of m.aliases) if (!out.has(a)) out.set(a, m);
        if (!out.has(m.id)) out.set(m.id, m);
      } catch (e: any) { process.stderr.write(`kora: manifest ${entry.path}: ${e?.message || e}\n`); }
    }
  } catch (e: any) { process.stderr.write(`kora: manifests index: ${e?.message || e}\n`); }
  cache = out;
  return out;
}
export function manifestFor(agentId: string): Manifest | undefined { return loadManifests().get(agentId); }

// ---------- gates ----------
function gateMatches(g: Gate, text: string, lower: string, lines: string[]): boolean {
  if (!g.contains.every((n) => lower.includes(n))) return false;
  if (!g.regex.every((r) => { r.lastIndex = 0; return r.test(text); })) return false;
  if (!g.lineRegex.every((r) => lines.some((l) => { r.lastIndex = 0; return r.test(l); }))) return false;
  if (!g.all.every((n) => gateMatches(n, text, lower, lines))) return false;
  if (g.any.length && !g.any.some((n) => gateMatches(n, text, lower, lines))) return false;
  if (g.not.some((n) => gateMatches(n, text, lower, lines))) return false;
  return true;
}

// ---------- regions (Rust str::lines semantics: split on \n, strip trailing \r, no trailing empty) ----------
export function splitLines(s: string): string[] {
  if (s === '') return [];
  const ls = s.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  return ls.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}
const join = (ls: string[]) => ls.join('\n');
function isHorizontalRule(line: string): boolean {
  const t = line.trim(); if (!t) return false;
  let n = 0; for (const ch of t) { if (ch === '─') n++; else break; }
  if (n === 0) return false;
  const suffix = Array.from(t).slice(n).join('').trimStart();
  return suffix === '' || n >= 3;
}
const codexPromptLine = (l: string) => l === '›' || l.startsWith('› ');
const codexBlockMarker = (l: string) => /^[•■✗✓]/.test(l);
function currentCodexPromptIndex(lines: string[]): number | null {
  let idx = -1; for (let i = lines.length - 1; i >= 0; i--) if (codexPromptLine(lines[i])) { idx = i; break; }
  if (idx < 0) return null;
  for (let i = idx + 1; i < lines.length; i++) if (codexBlockMarker(lines[i])) return null;
  return idx;
}
function promptBoxTop(lines: string[]): number | null {
  let c = 0; for (let i = lines.length - 1; i >= 0; i--) if (isHorizontalRule(lines[i])) { c++; if (c === 2) return i; }
  return null;
}
function bottomNonEmpty(lines: string[], n: number): string[] {
  let seen = 0, start = -1;
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { seen++; start = i; if (seen === n) break; } }
  return start < 0 ? [] : lines.slice(start);
}
function topNonEmpty(lines: string[], n: number): string[] {
  let seen = 0, end = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].trim()) { seen++; end = i; if (seen === n) break; } }
  return end < 0 ? [] : lines.slice(0, end + 1);
}
export function regionText(input: DetectionSnapshot, spec: string): string {
  const s = spec.trim();
  if (s === 'osc_title') return input.oscTitle;
  if (s === 'osc_progress') return input.oscProgress;
  const content = input.screen; const lines = splitLines(content);
  switch (s) {
    case 'whole_recent': return content;
    case 'after_last_prompt_marker': { let i = -1; for (let k = lines.length - 1; k >= 0; k--) if (codexPromptLine(lines[k])) { i = k; break; } return i < 0 ? content : join(lines.slice(i + 1)); }
    case 'before_current_prompt_marker': { const i = currentCodexPromptIndex(lines); return i == null ? content : join(lines.slice(0, i)); }
    case 'whole_recent_without_current_prompt_marker': return currentCodexPromptIndex(lines) == null ? content : '';
    case 'current_prompt_block_marker': { const i = currentCodexPromptIndex(lines); if (i == null) return ''; for (let k = i - 1; k >= 0; k--) if (codexBlockMarker(lines[k])) return lines[k]; return ''; }
    case 'after_current_prompt_block_marker': { const i = currentCodexPromptIndex(lines); if (i == null) return ''; for (let k = i - 1; k >= 0; k--) if (codexBlockMarker(lines[k])) return join(lines.slice(k)); return ''; }
    case 'prompt_box_body': { const top = promptBoxTop(lines); if (top == null) return ''; let end = lines.length; for (let k = top + 1; k < lines.length; k++) if (isHorizontalRule(lines[k])) { end = k; break; } return join(lines.slice(top + 1, end)); }
    case 'above_prompt_box': { const top = promptBoxTop(lines); return top == null ? content : join(lines.slice(0, top)); }
    case 'last_non_empty_above_prompt_box': { const top = promptBoxTop(lines); const above = top == null ? lines : lines.slice(0, top); for (let k = above.length - 1; k >= 0; k--) if (above[k].trim()) return above[k]; return ''; }
    case 'after_last_horizontal_rule': { let i = -1; for (let k = lines.length - 1; k >= 0; k--) if (isHorizontalRule(lines[k])) { i = k; break; } return i < 0 ? content : join(lines.slice(i + 1)); }
  }
  let m = /^bottom_lines\((\d+)\)$/.exec(s); if (m) return join(lines.slice(Math.max(0, lines.length - Number(m[1]))));
  m = /^bottom_non_empty_lines\((\d+)\)$/.exec(s); if (m) return join(bottomNonEmpty(lines, Number(m[1])));
  m = /^top_non_empty_lines\((\d+)\)$/.exec(s); if (m) return join(topNonEmpty(lines, Number(m[1])));
  return '';
}

// ---------- blocker text ----------
function collectLineRegex(g: Gate, out: RegExp[]) { out.push(...g.lineRegex); for (const n of [...g.all, ...g.any]) collectLineRegex(n, out); }
function collectContains(g: Gate, out: string[]) { out.push(...g.contains); for (const n of [...g.all, ...g.any]) collectContains(n, out); }
export function blockerText(rule: Rule, region: string): string | null {
  const lines = splitLines(region).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const lrs: RegExp[] = []; collectLineRegex(rule.gate, lrs);
  const needles: string[] = []; collectContains(rule.gate, needles);
  let best = lines[lines.length - 1], bestScore = -Infinity;
  for (const l of lines) {
    const lower = l.toLowerCase(); let score = 0;
    const hint = /\b(esc|enter|tab|arrow|ctrl|↑|↓|y\/n)\b.*\bto\b|\bto (navigate|select|confirm|cancel|accept|continue|submit|toggle)\b/i.test(l);
    if (l.includes('?')) score += 4;                       // the question is what the human needs to see
    if (needles.some((n) => lower.includes(n)) && !hint) score += 3;
    if (lrs.some((r) => { r.lastIndex = 0; return r.test(l); })) score += 2;
    if (hint) score -= 3;                                  // "Enter to confirm · Esc to cancel" is not the blocker
    if (/^[│╭╰─┃┏┗━╮╯\s]+$/.test(l)) score -= 5;
    if (/^❯\s+(?!\d+\.)/.test(l) && l.length > 24) score -= 4; // the user's own prompt echo, not the question
    if (score > bestScore) { bestScore = score; best = l; }
  }
  const cleaned = best.replace(/^[│┃]\s*/, '').replace(/\s*[│┃]$/, '').replace(/\s+/g, ' ').trim();
  return cleaned.length > 80 ? cleaned.slice(0, 77) + '…' : cleaned;
}

// ---------- main entry ----------
const NONE: Detection = { state: 'unknown', blocker: null, ruleId: null, matched: false, skipStateUpdate: false, visibleIdle: false, visibleBlocker: false, visibleWorking: false };
export function detect(snapshot: DetectionSnapshot, agentId: string): Detection {
  const m = manifestFor(agentId);
  if (!m) return NONE;
  let best: Rule | null = null; let bestRegion = '';
  for (const rule of m.rules) {
    if (best && best.priority >= rule.priority) continue;
    const region = regionText(snapshot, rule.region);
    const lines = splitLines(region);
    if (gateMatches(rule.gate, region, region.toLowerCase(), lines)) { best = rule; bestRegion = region; }
  }
  if (!best) return NONE;
  const state = best.state;
  return {
    state, ruleId: best.id, matched: true, skipStateUpdate: best.skipStateUpdate,
    blocker: state === 'blocked' ? blockerText(best, bestRegion) : null,
    visibleIdle: best.visibleIdle && state === 'idle', visibleBlocker: best.visibleBlocker && state === 'blocked', visibleWorking: best.visibleWorking && state === 'working',
  };
}
