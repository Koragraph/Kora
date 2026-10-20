// The blob permission policy for tools the SDK would otherwise decide on its own (docs/bots/ARCH.md 2.2, risk R4).
//
// "Auto" for a blob: free inside its own workspace + blob home + scratch; asks before anything outside them and
// before anything that sends, posts, deletes in bulk, pays or signs in. Measured (ARCH R4): the SDK's own `auto` mode
// is only honoured on models that support it and, there, approves `curl` itself without calling canUseTool — so this
// policy runs in TWO places: a PreToolUse hook (decision `ask`, which the SDK routes to canUseTool even in auto mode)
// and canUseTool (where an in-bounds call is allowed outright for the models that fall back to `default`).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { sensitiveOverride, sensitiveVerdict } from './sensitive-guard';

export interface BlobPolicyContext {
  /** The blob's Finder workspace. */
  workspace: string;
  /** <KORA_HOME>/blobs/<id> (SOUL, skills). */
  blobHome: string;
  /** More folders that are in bounds (the attachments folder, the skills plugin dir). */
  extraDirs?: string[];
  /** Folders the blob may only READ (Kora reads her teammates' outputs); read live. Writes there still ask. */
  readDirs?: () => string[];
  /** The thread's posture right now ('approval-required' = the blob's "Ask"). */
  mode?: () => string | undefined;
  /** A standing "Always for this blob" answer covers this call (read live). */
  alwaysAllowed?: (toolName: string, input: Record<string, unknown>) => boolean;
}
export interface BlobPolicyVerdict { decision: 'allow' | 'ask'; reason: string }

/** Shell words that send data off the Mac, publish, or drive other apps. Matching one always asks (Auto, not Full). */
export const OUTBOUND_BASH = /(^|[\s;&|(`])(curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp|sendmail|mail|mutt|osascript|open|sudo|launchctl)(\s|$)|\bgit\s+push\b|(^|[\s;&|(`])gh\s|\bnpm\s+publish\b|\bpnpm\s+publish\b|\bdocker\s+push\b|\baws\s|\bgcloud\s|\bkubectl\s/;

/** The path tools that only look: allowed inside `readDirs` as well as inside the blob's own folders. */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);

const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS']);

function real(p: string): string { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

/** realpath of the nearest existing ancestor + the not-yet-existing tail (so a new file in outputs/ resolves). */
function resolveLoose(p: string): string {
  let cur = path.resolve(p); const tail: string[] = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { tail.unshift(path.basename(cur)); cur = path.dirname(cur); }
  return path.join(real(cur), ...tail);
}

/**
 * A string that names a path the bounds check must see. Windows also: `C:\x`, `C:/x`, `\\server\share` and `..\x`
 * (with only the POSIX forms, `C:\Users\me\.ssh\id_rsa` was not a path and skipped the check). A lone `\word` is
 * not counted: document text (`\section`) would read as a path.
 */
export function looksLikePath(v: string, platform: NodeJS.Platform = process.platform): boolean {
  if (v.startsWith('/') || v.startsWith('~') || v === '..' || v.startsWith('../') || v.includes('/../')) return true;
  return platform === 'win32' && (/^[a-z]:[\\/]/i.test(v) || v.startsWith('\\\\') || /(^|[\\/])\.\.([\\/]|$)/.test(v));
}

export function inBounds(target: string, ctx: BlobPolicyContext): boolean {
  const t = resolveLoose(target);
  // `/tmp` on Windows resolves to `C:\tmp`, a folder anyone may own: only the real temp dir there.
  const roots = [ctx.workspace, ctx.blobHome, os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp', '/private/tmp']), ...(ctx.extraDirs ?? [])].map(real);
  return roots.some((r) => t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

function inRoots(target: string, roots: readonly string[]): boolean {
  const t = resolveLoose(target);
  return roots.map(real).some((r) => t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}


/** Plain commands that read or shuffle files and cannot reach the network or run other code on their own. */
const SAFE_SHELL_WORDS = new Set([
  'ls', 'pwd', 'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'sort', 'uniq', 'cut', 'tr', 'diff', 'file', 'stat', 'du', 'date',
  'basename', 'dirname', 'realpath', 'mkdir', 'touch', 'cp', 'mv', 'tee', 'jq', 'true', 'false', 'test', 'cd', 'tree', 'column', 'nl', 'seq',
]);
const INTERPRETERS = new Set(['python3', 'python', 'node']);
/** `git <sub>`: only subcommands that stay local. */
const SAFE_GIT = new Set(['status', 'diff', 'log', 'show', 'branch', 'add', 'commit', 'rev-parse', 'ls-files', 'blame', 'checkout', 'switch', 'restore']);

interface ShellWord { w: string; /** an unquoted `*`, `?` or `[`: the shell expands it */ glob: boolean; /** a `$` outside single quotes */ dollar: boolean }

/** Split a command line into words, honouring quotes. Returns null when it holds something we will not reason about. */
function shellWords(cmd: string): ShellWord[][] | null {
  if (/\$\(|`|<\(|>\(|<<|\\/.test(cmd.replace(/'[^']*'/g, "''"))) return null; // substitution, heredoc, escapes
  const segments: ShellWord[][] = [[]]; let cur = ''; let q: string | null = null; let have = false; let glob = false; let dollar = false;
  const push = () => { if (have) segments[segments.length - 1]!.push({ w: cur, glob, dollar }); cur = ''; have = false; glob = false; dollar = false; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q) { if (c === q) q = null; else { cur += c; if (c === '$' && q === '"') dollar = true; } continue; }
    if (c === "'" || c === '"') { q = c; have = true; continue; }
    if (c === ' ' || c === '\t') { push(); continue; }
    if (c === '\n' || c === ';' || c === '&' || c === '|') { push(); if (segments[segments.length - 1]!.length) segments.push([]); continue; }
    if (c === '*' || c === '?' || c === '[') glob = true;
    if (c === '$') dollar = true;
    cur += c; have = true;
  }
  if (q) return null;
  push();
  return segments.filter((x) => x.length);
}

/**
 * Kora's own document tools, exactly as the doc skills tell a blob to call them: `'<kora node>' '<kora.js>' blob-tools
 * <kind> <verb> --json '<input>'`. Matched on the exact bundled paths (never a generic `node`), so they run without a
 * card on Auto (pl6 S2-1: every spreadsheet took three "Allow once" clicks, and Always was never offered for node).
 */
let blobToolsCmd: { node: string; js: string } | null = null;
export function setBlobToolsCommand(node: string, js: string): void { blobToolsCmd = { node, js }; }
const DOC_VERBS: Record<string, ReadonlySet<string>> = {
  xlsx: new Set(['read', 'write', 'edit']), docx: new Set(['read', 'write', 'edit']), pptx: new Set(['read', 'write']), pdf: new Set(['read', 'info']),
};
/** null = an in-bounds doc-tool call; a string = why it is not one (the caller then applies the normal rules). */
function docToolReason(words: string[], ctx: BlobPolicyContext): string | null {
  if (!blobToolsCmd || words[0] !== blobToolsCmd.node || words[1] !== blobToolsCmd.js || words[2] !== 'blob-tools') return 'not a doc tool';
  const kind = words[3] ?? ''; const verb = words[4] ?? '';
  if (!DOC_VERBS[kind]?.has(verb)) return 'not a doc tool';
  const rest = words.slice(5);
  if (rest.length !== 2 || rest[0] !== '--json') return 'doc tool input must be --json';
  let input: unknown;
  try { input = JSON.parse(rest[1]!); } catch { return 'doc tool input is not JSON'; }
  // every path-looking string in the input must be inside the blob's folders (relative ones resolve against the workspace)
  const bad: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (!looksLikePath(v)) return;
      const abs = v.startsWith('~') ? v.replace(/^~/, os.homedir()) : path.isAbsolute(v) ? v : path.join(ctx.workspace, v);
      if (!inBounds(abs, ctx)) bad.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(input);
  return bad.length ? `the document tool touches ${bad[0]}, outside the blob's folders` : null;
}

/** Why this shell line must ask, or null when every part is a plain local command on in-bounds paths. */
export function shellUnsafeReason(cmd: string, ctx: BlobPolicyContext): string | null {
  const segs = shellWords(cmd);
  if (!segs) return 'this command uses substitution, a heredoc or an escape, which Kora cannot check';
  for (const seg of segs) {
    // A variable (`$HOME/…`, `"$PWD"/..`), a glob or `~user` can name any path; Kora cannot check where it lands.
    const opaque = seg.find((x) => x.dollar || x.glob || /^~[^/]/.test(x.w));
    if (opaque) return `${opaque.w} uses a variable, a glob or ~user, which Kora cannot check`;
    const words = seg.map((x) => x.w);
    const doc = docToolReason(words, ctx);
    if (doc === null) continue;
    if (doc.startsWith('the document tool')) return doc;
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++; // VAR=value prefix
    const head = words[i];
    if (!head) return 'this command only sets variables';
    const args = words.slice(i + 1);
    if (head === 'git') {
      const sub = args.find((a) => !a.startsWith('-'));
      if (!sub || !SAFE_GIT.has(sub) || args.some((a) => a === '-c' || a === '-C' || a.startsWith('--exec'))) return `git ${sub ?? ''} is not on the safe list`.replace('  ', ' ');
    } else if (INTERPRETERS.has(head)) {
      // Running the blob's own script file is how its skills build documents; inline code (-c/-e/stdin/-m) cannot be checked.
      const script = args.find((a) => !a.startsWith('-'));
      if (args.some((a) => /^-(c|e|p|m|i)$|^--(eval|print|command)/.test(a)) || !script || !/\.(py|js|mjs|cjs)$/.test(script)) return `${head} with inline code or no script file cannot be checked`;
      if (script.startsWith('/') || script.startsWith('~') || script.includes('..')) { /* path check below covers it */ }
    } else if (!SAFE_SHELL_WORDS.has(head)) {
      return `${head} is not on the safe command list`;
    }
    for (const a of args) {
      const p = /^(?:\d*>>?|<)?(.*)$/.exec(a)![1] ?? a; // `>/x`, `2>/x`, `</x` carry a path
      const looksPath = looksLikePath(p);
      // oxlint-disable-next-line kora/no-posix-only-paths -- a /dev/null redirect in the command text, which Git bash understands too
      if (!looksPath || p === '/dev/null') continue;
      const abs = p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p;
      if (!path.isAbsolute(abs) || !inBounds(abs, ctx)) return `touches ${p}, outside the blob's folders`;
    }
  }
  return null;
}

export function blobPolicy(toolName: string, input: Record<string, unknown>, ctx: BlobPolicyContext): BlobPolicyVerdict {
  const name = toolName.replace(/^mcp__[^_]+__/, '');
  // Keys and credentials ask first, before "Always for this blob" or any in-bounds answer (session/sensitive-guard.ts).
  if (!sensitiveOverride()) {
    const sv = sensitiveVerdict(toolName, input, ctx.workspace);
    if (sv.sensitive) return { decision: 'ask', reason: `${sv.reason}: keys and credentials always ask` };
  }
  if (ctx.alwaysAllowed?.(toolName, input)) return { decision: 'allow', reason: 'you chose "Always for this blob"' };
  if (PATH_TOOLS.has(name)) {
    const raw = input.file_path ?? input.path ?? input.notebook_path;
    // Glob/Grep with no path search the cwd (the workspace); that is in bounds.
    if (raw == null || raw === '') return { decision: 'allow', reason: 'workspace' };
    const target = String(raw).startsWith('~') ? String(raw).replace(/^~/, os.homedir()) : String(raw);
    const abs = path.isAbsolute(target) ? target : path.join(ctx.workspace, target);
    if (inBounds(abs, ctx)) return { decision: 'allow', reason: 'inside the blob\'s folders' };
    if (READ_ONLY_TOOLS.has(name) && inRoots(abs, ctx.readDirs?.() ?? [])) return { decision: 'allow', reason: 'a teammate\'s folder (read only)' };
    return { decision: 'ask', reason: `outside ${ctx.workspace}: ${abs}` };
  }
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') {
    const cmd = String(input.command ?? '');
    if (OUTBOUND_BASH.test(cmd)) return { decision: 'ask', reason: 'this command can send data out or act outside the workspace' };
    // Allowlist, not denylist: a regex of "bad words" is trivially dodged (/usr/bin/curl, bash -c, python -c, cat ~/.ssh/key).
    const unsafe = shellUnsafeReason(cmd, ctx);
    if (unsafe) return { decision: 'ask', reason: unsafe };
    // Ask means ask: Claude's own allowlist waves through "read-only" shell lines (echo, ls, uname), which an Ask blob must not.
    if (ctx.mode?.() === 'approval-required') return { decision: 'ask', reason: 'Ask: every shell command asks first' };
    return { decision: 'allow', reason: 'shell in the workspace' };
  }
  // WebSearch / WebFetch are research (read-only); the Skill, TodoWrite, image and kora tools are the blob's own.
  return { decision: 'allow', reason: 'built-in tool' };
}

/** The PreToolUse hook entry: `ask` when the policy says so, nothing otherwise. `skip()` = Full access (no policy). */
export function blobPreToolUseHooks(ctx: BlobPolicyContext, skip: () => boolean, halted: () => boolean = () => false): Record<string, unknown> {
  const hook = async (input: any) => {
    if (halted()) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'The turn was stopped by the user.' } };
    if (skip()) return {};
    const v = blobPolicy(String(input?.tool_name ?? ''), (input?.tool_input ?? {}) as Record<string, unknown>, ctx);
    if (v.decision === 'allow') return {};
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: v.reason } };
  };
  return { PreToolUse: [{ hooks: [hook] }] };
}
