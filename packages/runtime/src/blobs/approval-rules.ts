// "Always for this blob": the standing answers a user gives on an approval card. A rule is narrow on purpose:
//
//   command  one program ("echo", "git status"); never a chained / redirected / substituted line, never anything that sends
//            data out (the Auto-mode outbound list), never an interpreter or a destructive program
//   path     one folder outside the blob's own (reads and edits under it)
//   app      one connected-app action (GMAIL_SEND_EMAIL)
//
// Rules live on the profile (`toolGrants.approvals`) so Profile > Permissions can list and remove them. Pure functions:
// the runtime persists, the Claude driver asks `matchesRule` before it raises a card.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { OUTBOUND_BASH } from '../session/blob-policy';
import { pathDepth, windowsSystemRoots } from '../util/os-roots';

export type ApprovalRuleKind = 'command' | 'path' | 'app';
export interface ApprovalRule { id: string; kind: ApprovalRuleKind; match: string; label: string; at: number }

const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS']);
const COMPOUND = /[;&|`\n<>]|\$\(|\$\{/;
/** Programs that run arbitrary code or destroy things: a standing yes would be a blank cheque. */
const NEVER_REMEMBER = new Set(['rm', 'rmdir', 'mv', 'dd', 'chmod', 'chown', 'kill', 'killall', 'pkill', 'shutdown', 'reboot', 'mkfs', 'diskutil', 'sh', 'bash', 'zsh', 'fish', 'dash', 'python', 'python2', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'eval', 'exec', 'env', 'xargs', 'nohup', 'time', 'watch', 'trash', 'source', 'sudo', 'su', 'find', 'tee', 'truncate', 'shred', 'crontab', 'defaults', 'tccutil', 'security']);
const TWO_WORD = new Set(['git', 'npm', 'pnpm', 'yarn', 'cargo', 'docker', 'brew', 'pip', 'pip3', 'go', 'make']);
const SYSTEM_DIRS = ['/etc', '/usr', '/bin', '/sbin', '/System', '/Library', '/var', '/dev', '/opt', '/cores', '/private/etc', '/private/var'];
const SENSITIVE_UNDER_HOME = ['.ssh', '.aws', '.gnupg', '.config', '.kube', '.docker', 'Library', '.kora', '.kora-dev', '.claude', '.codex', '.npmrc', '.netrc'];

const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

function loosePath(p: string): string {
  let cur = path.resolve(p); const tail: string[] = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { tail.unshift(path.basename(cur)); cur = path.dirname(cur); }
  return path.join(real(cur), ...tail);
}

const tilde = (p: string): string => { const h = os.homedir(); return p === h ? '~' : p.startsWith(h + path.sep) ? `~${p.slice(h.length)}` : p; };

/** The program (and for git/npm/... the subcommand) of a simple, single shell command; null when no standing yes is safe. */
export function commandKey(cmd: string): string | null {
  const c = cmd.trim();
  if (!c || c.length > 400 || COMPOUND.test(c) || OUTBOUND_BASH.test(c)) return null;
  const toks = c.split(/\s+/);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]!)) return null; // FOO=bar cmd
  const prog = path.basename(toks[0]!);
  if (!/^[A-Za-z0-9._+-]+$/.test(prog) || NEVER_REMEMBER.has(prog)) return null;
  if (TWO_WORD.has(prog)) {
    const sub = toks.slice(1).find((t) => !t.startsWith('-'));
    if (!sub || !/^[a-z][a-z0-9-]*$/.test(sub)) return null;
    return `${prog} ${sub}`;
  }
  return prog;
}

function pathTarget(toolName: string, input: Record<string, unknown>): string | null {
  const raw = input.file_path ?? input.path ?? input.notebook_path;
  if (raw == null || raw === '') return null;
  const t = String(raw).startsWith('~') ? String(raw).replace(/^~/, os.homedir()) : String(raw);
  void toolName;
  return path.isAbsolute(t) ? t : null;
}

/** The folder an "Always" on a path tool would cover, or null when the place is too broad or too sensitive. */
export function pathScope(target: string): string | null {
  const t = loosePath(target);
  let dir: string;
  try { dir = fs.existsSync(t) && fs.statSync(t).isDirectory() ? t : path.dirname(t); } catch { dir = path.dirname(t); }
  dir = path.resolve(dir);
  const win = process.platform === 'win32';
  const f = (p: string) => (win ? p.toLowerCase() : p); // NTFS is case-insensitive
  const home = real(os.homedir());
  if (pathDepth(dir) === 0 || f(dir) === f(home)) return null;
  if ((win ? windowsSystemRoots() : SYSTEM_DIRS).some((s) => f(dir) === f(s) || f(dir).startsWith(f(s) + path.sep))) return null;
  if (f(dir).startsWith(f(home) + path.sep)) {
    const first = dir.slice(home.length + 1).split(path.sep)[0]!;
    if (SENSITIVE_UNDER_HOME.some((n) => f(n) === f(first)) || (win && f(first) === 'appdata')) return null;
    return dir;
  }
  return pathDepth(dir) >= 2 ? dir : null;
}

const rid = (): string => `rule_${crypto.randomBytes(4).toString('hex')}`;

/** The rule an "Always" click would add for this tool call, or null (the card then offers Allow once / Deny only). */
export function ruleFor(toolName: string, input: Record<string, unknown>, now = Date.now()): ApprovalRule | null {
  const name = toolName.replace(/^mcp__[^_]+__/, '');
  if (name === 'Bash') {
    const key = commandKey(String(input.command ?? ''));
    return key ? { id: rid(), kind: 'command', match: key, label: `Run ${key}`, at: now } : null;
  }
  if (PATH_TOOLS.has(name)) {
    const t = pathTarget(name, input);
    const dir = t ? pathScope(t) : null;
    return dir ? { id: rid(), kind: 'path', match: dir, label: `Files in ${tilde(dir)}`, at: now } : null;
  }
  return null;
}

export function appRule(toolSlug: string, label: string, now = Date.now()): ApprovalRule | null {
  const slug = toolSlug.trim();
  return slug ? { id: rid(), kind: 'app', match: slug.toUpperCase(), label: label.slice(0, 120), at: now } : null;
}

export function matchesRule(rules: readonly ApprovalRule[] | undefined, toolName: string, input: Record<string, unknown>): boolean {
  if (!rules || rules.length === 0) return false;
  const name = toolName.replace(/^mcp__[^_]+__/, '');
  if (name === 'Bash') {
    const key = commandKey(String(input.command ?? ''));
    return !!key && rules.some((r) => r.kind === 'command' && r.match === key);
  }
  if (PATH_TOOLS.has(name)) {
    const t = pathTarget(name, input);
    if (!t) return false;
    const abs = loosePath(t);
    return rules.some((r) => r.kind === 'path' && (abs === r.match || abs.startsWith(r.match + path.sep)));
  }
  return false;
}

export const matchesAppRule = (rules: readonly ApprovalRule[] | undefined, toolSlug: string): boolean => !!rules?.some((r) => r.kind === 'app' && r.match === toolSlug.trim().toUpperCase());

/** `rules` plus `rule`, unless an equal one is there; capped so a profile never grows without bound. */
export function addRule(rules: readonly ApprovalRule[] | undefined, rule: ApprovalRule): ApprovalRule[] {
  const cur = rules ?? [];
  if (cur.some((r) => r.kind === rule.kind && r.match === rule.match)) return [...cur];
  return [...cur, rule].slice(-60);
}

/** Tolerant read of whatever `toolGrants.approvals` holds on disk. */
export function readRules(v: unknown): ApprovalRule[] {
  if (!Array.isArray(v)) return [];
  const out: ApprovalRule[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if ((o.kind === 'command' || o.kind === 'path' || o.kind === 'app') && typeof o.match === 'string' && o.match && typeof o.id === 'string') {
      out.push({ id: o.id, kind: o.kind, match: o.match, label: typeof o.label === 'string' ? o.label : o.match, at: typeof o.at === 'number' ? o.at : 0 });
    }
  }
  return out;
}
