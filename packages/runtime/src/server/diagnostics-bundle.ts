// The diagnostics bundle — what "Export diagnostics" (Settings → Diagnostics) and `kora doctor --export` write: the
// health report, versions, a scrubbed config and the tails of Kora's own logs, as ONE redacted JSON file the user can
// attach to a bug report. Redaction runs over the whole serialized bundle, last, so nothing added later skips it.
// Everything is async and bounded (log tails read at most TAIL_BYTES from the end of each file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import type { HealthReport } from './health';

const TAIL_BYTES = 128 * 1024;
const TAIL_LINES = 300;
/** Kora's own logs, relative to KORA_HOME. Never anything under secrets/. */
export const BUNDLE_LOGS = ['server.log', 'app-launch.log', 'ingest.log'] as const;

const REDACTED = '<redacted>';

/**
 * Scrub secrets, tokens, emails, key-file paths and the home directory from free text. Deliberately greedy: a bundle
 * with a few extra `<redacted>` is fine, a leaked key is not. Git SHAs (pure 40-hex) survive — they help debugging.
 */
export function redactText(input: string, home: string = os.homedir()): string {
  let s = input;
  // Paths to credentials / key files (before the home rewrite, so both ~/… and /Users/… forms are caught).
  s = s.replace(/(?:~|\/)[^\s"'`,;()<>]*(?:\/secrets\/[^\s"'`,;()<>]*|\/\.ssh\/[^\s"'`,;()<>]*|\/auth\.json|\/\.credentials\.json|\/credentials(?:\.json)?|\/swarm\.json|\/id_(?:rsa|ed25519|ecdsa)[^\s"'`,;()<>]*|\.(?:pem|p12|key)(?![\w.-]))/g, '<key-file>');
  // Provider tokens with recognisable shapes.
  s = s.replace(/\bsk-(?:ant|or|proj)?[-_A-Za-z0-9]{16,}/g, REDACTED);
  s = s.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED);
  s = s.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED);
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED);
  s = s.replace(/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED);
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED); // JWT
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`);
  // key=value / "key": "value" pairs whose name says secret.
  s = s.replace(/((?:api[_-]?key|apikey|token|secret|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key|client[_-]?secret|cookie)["']?\s*[:=]\s*["']?)([^"'\s,;}&]{4,})/gi, `$1${REDACTED}`);
  // URL credentials and secret-looking query params.
  s = s.replace(/(\/\/)[^\s/:@]+:[^\s/@]+@/g, `$1${REDACTED}@`);
  s = s.replace(/([?&](?:key|token|sig|signature|code|access_token)=)[^&\s"']+/gi, `$1${REDACTED}`);
  // Emails.
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>');
  // Long opaque blobs: 32+ chars mixing upper, lower and digits (base64-ish). Hex SHAs and UUIDs are one case: kept.
  s = s.replace(/\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}/g, REDACTED);
  // The user's home directory (and so their username) → ~.
  // Windows: also its JSON-escaped (C:\\Users\\x) and forward-slash (C:/Users/x) forms; the escaped one first.
  const homeForms = home.includes('\\') ? [home.replace(/\\/g, '\\\\'), home, home.replace(/\\/g, '/')] : [home];
  if (home && home.length > 1) for (const h of homeForms) s = s.split(h).join('~');
  // …and the username wherever else it shows (encoded paths like -Users-<name>-Projects, temp dirs).
  const user = path.basename(home);
  if (user.length >= 3 && home.length > 1) s = s.replace(new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<user>');
  return s;
}

/** Drop values whose key names a secret; keep the shape so the bundle still shows which settings exist. */
export function scrubObject(v: unknown, depth = 0): unknown {
  if (depth > 8) return '<deep>';
  if (Array.isArray(v)) return v.map((x) => scrubObject(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = /key|token|secret|password|auth|credential|cookie/i.test(k) && x != null && typeof x !== 'boolean' && typeof x !== 'number' && typeof x !== 'object' ? REDACTED : scrubObject(x, depth + 1);
    }
    return out;
  }
  return v;
}

/** The last `maxLines` lines of a file, reading at most TAIL_BYTES from its end. null when it can't be read. */
export async function tailFile(file: string, maxLines = TAIL_LINES): Promise<string | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    const lines = text.split('\n');
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
  } catch { return null; } finally { await fh?.close().catch(() => {}); }
}

export interface DiagnosticsBundleInput {
  report: HealthReport;
  /** Kora config (scrubbed here); pass the loaded config object. */
  config?: unknown;
  home?: string;
  koraHome?: string;
}

/** Build the bundle text (JSON, already redacted). */
export async function buildDiagnosticsBundle(input: DiagnosticsBundleInput): Promise<string> {
  const home = input.home ?? os.homedir();
  const kh = input.koraHome ?? koraHome();
  const logs: Record<string, string | null> = {};
  for (const name of BUNDLE_LOGS) logs[name] = await tailFile(path.join(kh, name));
  const bundle = {
    kind: 'kora-diagnostics',
    version: 1,
    note: 'Redacted automatically: keys, tokens, emails, key-file paths and your home directory are removed. Read it before sharing.',
    kora: input.report.koraVersion,
    platform: input.report.platform,
    node: input.report.node,
    generatedAt: new Date(input.report.generatedAt).toISOString(),
    health: input.report,
    config: input.config === undefined ? null : scrubObject(input.config),
    logs,
  };
  return redactText(JSON.stringify(bundle, null, 2), home);
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Where an export may go: an existing directory the user owns inside their home (default ~/Downloads, else ~).
 * The HTTP route takes `dir` from the client, so anything else (system dirs, Kora's own secrets) is refused.
 */
export function resolveExportDir(dir: string | null | undefined, home: string = os.homedir()): string {
  const fallback = fs.existsSync(path.join(home, 'Downloads')) ? path.join(home, 'Downloads') : home;
  if (!dir) return fallback;
  const abs = path.resolve(dir.startsWith('~') ? path.join(home, dir.slice(1)) : dir);
  let real: string;
  try { real = fs.realpathSync(abs); } catch { throw new Error(`${abs} does not exist`); }
  let realHome = home;
  try { realHome = fs.realpathSync(home); } catch { /* keep */ }
  if (real !== realHome && !real.startsWith(realHome + path.sep)) throw new Error('Choose a folder inside your home folder.');
  if (!fs.statSync(real).isDirectory()) throw new Error(`${abs} is not a folder`);
  const kh = (() => { try { return fs.realpathSync(koraHome()); } catch { return koraHome(); } })();
  if (real === kh || real.startsWith(kh + path.sep) || /(^|\/)\.ssh(\/|$)/.test(real)) throw new Error('Choose a folder outside Kora\'s data and ~/.ssh.');
  return real;
}

/** Write the bundle to `dir` (see resolveExportDir) as kora-diagnostics-<stamp>.json, 0600, never overwriting. */
export async function writeDiagnosticsBundle(input: DiagnosticsBundleInput & { dir?: string | null; now?: number }): Promise<{ path: string; bytes: number }> {
  const home = input.home ?? os.homedir();
  const dir = resolveExportDir(input.dir, home);
  const text = await buildDiagnosticsBundle(input);
  const base = `kora-diagnostics-${stamp(input.now ?? Date.now())}`;
  for (let i = 0; i < 20; i++) {
    const file = path.join(dir, i ? `${base}-${i}.json` : `${base}.json`);
    try {
      await fs.promises.writeFile(file, text, { flag: 'wx', mode: 0o600 });
      return { path: file, bytes: Buffer.byteLength(text) };
    } catch (e: any) { if (e?.code !== 'EEXIST') throw e; }
  }
  throw new Error('could not pick a free file name');
}
