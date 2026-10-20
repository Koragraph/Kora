// Koragent install + version gate (swarm.workerBackend = 'koragent').
//
// Install (`kora swarm install --backend koragent`): copy a built binary into $KORAGENT_HOME/bin/koragent (default
// ~/.koragent/bin/koragent), pinned by sha256. The source is, in order: `--from <path|url>`, $KORAGENT_BUILD_PATH, or
// `--build <koragent checkout>` (runs its `script/build.ts --single` and takes `dist/koragent-darwin-<arch>/bin/koragent`).
// A URL needs `--sha256` (fail closed); a local file is hashed and the copy re-hashed. The copy must answer
// `--version` at or above KORAGENT_MIN_VERSION before it is renamed into place. The pin goes next to it
// (`koragent.sha256`, `koragent.install.json`); readiness re-hashes the binary when its size/mtime changes and blocks on a
// mismatch (a binary swapped behind Kora's back is not the one it installed).
//
// Version gate: `koragent --version` → `koragent-too-old` below KORAGENT_MIN_VERSION. Dev builds (`local` from a
// source run, `0.0.0-<channel>-<stamp>` from a preview build) pass: they come from a checkout the user chose.
// Everything is async (child processes, streams): the daemon's event loop carries the UI websocket.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compareOpencodeVersions } from './swarm-install';

/** The fork base: the first Koragent with the Kora contract (TaskSpec, event stream, task_report). */
export const KORAGENT_MIN_VERSION = '1.18.32';

export function koragentHome(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.KORAGENT_HOME?.trim();
  return h ? path.resolve(h.startsWith('~/') ? path.join(os.homedir(), h.slice(2)) : h) : path.join(os.homedir(), '.koragent');
}
export function koragentInstallPath(env: NodeJS.ProcessEnv = process.env): string { return path.join(koragentHome(env), 'bin', 'koragent'); }
const pinFile = (bin: string) => path.join(path.dirname(bin), 'koragent.sha256');
const infoFile = (bin: string) => path.join(path.dirname(bin), 'koragent.install.json');

// ── version ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A dev build: `local` (bun run from source) or a preview build's `0.0.0-<channel>-<stamp>`. */
export function isDevKoragentVersion(v: string): boolean { return v === 'local' || /^0\.0\.0-/.test(v); }

/** Meets KORAGENT_MIN_VERSION (dev builds pass; null = it did not answer --version = not ok). */
export function koragentVersionOk(v: string | null, min = KORAGENT_MIN_VERSION): boolean {
  if (!v) return false;
  if (isDevKoragentVersion(v)) return true;
  return compareOpencodeVersions(v, min) >= 0;
}

function versionOnce(bin: string, timeoutMs: number): Promise<{ version: string | null; timedOut: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
      const m = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(out);
      if (m) return resolve({ version: m[1], timedOut: false, detail: '' });
      if (!err && /^local$/i.test(out)) return resolve({ version: 'local', timedOut: false, detail: '' });
      const timedOut = !!(err as any)?.killed;
      resolve({ version: null, timedOut, detail: (String(stderr || '').trim() || (err ? (timedOut ? `timed out after ${timeoutMs / 1000} s` : err.message) : `no version in "${out.slice(0, 80)}"`)).slice(0, 300) });
    }).stdin?.end();
  });
}

/** `koragent --version` (15 s, one 30 s retry after a timeout: a fresh binary's first exec can sit in assessment). */
export async function koragentVersionDetail(bin: string): Promise<{ version: string | null; detail: string }> {
  let r = await versionOnce(bin, 15_000);
  if (r.timedOut) r = await versionOnce(bin, 30_000);
  return { version: r.version, detail: r.detail };
}
export async function koragentVersion(bin: string): Promise<string | null> { return (await koragentVersionDetail(bin)).version; }

// ── sha256 pin ──────────────────────────────────────────────────────────────────────────────────────────────────

export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h, ...(signal ? [{ signal }] as [{ signal: AbortSignal }] : []));
  return h.digest('hex');
}

/** The pinned sha256 of an installed binary (written by installKoragent); null = not installed by Kora (no pin). */
export function readKoragentPin(bin: string): string | null {
  try { const m = /^([0-9a-f]{64})\b/.exec(fs.readFileSync(pinFile(bin), 'utf8').trim()); return m ? m[1] : null; } catch { return null; }
}

const pinCache = new Map<string, { sig: string; ok: boolean; actual: string }>();
/**
 * Does the binary still match its pin? `null` = no pin (KORAGENT_BIN / PATH / hand-placed: not Kora's to police).
 * Re-hashed only when size/mtime changed.
 */
export async function checkKoragentPin(bin: string): Promise<{ pinned: string; actual: string; ok: boolean } | null> {
  const pinned = readKoragentPin(bin);
  if (!pinned) return null;
  let sig = '';
  try { const st = fs.statSync(bin); sig = `${st.size}:${st.mtimeMs}`; } catch { return { pinned, actual: '', ok: false }; }
  const c = pinCache.get(bin);
  if (c && c.sig === sig) return { pinned, actual: c.actual, ok: c.actual === pinned };
  const actual = await sha256File(bin).catch(() => '');
  pinCache.set(bin, { sig, ok: actual === pinned, actual });
  return { pinned, actual, ok: actual === pinned };
}

// ── install ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface KoragentInstallResult {
  ok: boolean;
  path: string;
  version: string | null;
  sha256: string | null;
  source: string | null;
  message: string;
}

export interface KoragentInstallOptions {
  /** A local binary (or a directory holding bin/koragent / a build's dist), or an http(s) URL. */
  from?: string | null;
  /** Expected sha256 of the source (required for a URL). */
  sha256?: string | null;
  /** A koragent checkout to build from (packages/koragent/script/build.ts --single). */
  build?: string | null;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
  /** Test seams. */
  deps?: {
    download?: (url: string, dest: string, signal: AbortSignal) => Promise<void>;
    runBuild?: (checkout: string, signal: AbortSignal) => Promise<void>;
    arch?: string;
    platform?: string;
  };
}

class InstallError extends Error {}

async function defaultDownload(url: string, dest: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal, redirect: 'follow' }).catch((e: any) => { throw new InstallError(`download failed: ${e?.cause?.code || e?.message || e}`); });
  if (!res.ok || !res.body) throw new InstallError(`download failed: HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(dest, { mode: 0o600 }), { signal });
}

function platformName(platform: string, arch: string): string { return `koragent-${platform}-${arch === 'x64' ? 'x64' : arch}`; }

/** The koragent binary in a build dir / checkout / bin dir; null when none. */
export function findKoragentBinary(dir: string, platform: string = process.platform, arch: string = process.arch): string | null {
  const name = platformName(platform, arch);
  const cands = [
    path.join(dir, 'koragent'),
    path.join(dir, 'bin', 'koragent'),
    path.join(dir, name, 'bin', 'koragent'),
    path.join(dir, 'dist', name, 'bin', 'koragent'),
    path.join(dir, 'packages', 'koragent', 'dist', name, 'bin', 'koragent'),
  ];
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
  return null;
}

function defaultRunBuild(checkout: string, signal: AbortSignal): Promise<void> {
  const pkg = fs.existsSync(path.join(checkout, 'packages', 'koragent', 'script', 'build.ts')) ? path.join(checkout, 'packages', 'koragent') : checkout;
  if (!fs.existsSync(path.join(pkg, 'script', 'build.ts'))) return Promise.reject(new InstallError(`${checkout} is not a koragent checkout (no packages/koragent/script/build.ts)`));
  const bun = [process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', 'bun') : '', path.join(os.homedir(), '.bun', 'bin', 'bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun'].find((b) => b && fs.existsSync(b)) ?? 'bun';
  return new Promise((resolve, reject) => {
    execFile(bun, ['run', 'script/build.ts', '--single', '--skip-install'], { cwd: pkg, signal, timeout: 15 * 60_000, maxBuffer: 64 << 20 }, (err, _o, stderr) => {
      if (err) return reject(new InstallError(`the koragent build failed: ${String(stderr || err.message).trim().split('\n').slice(-6).join(' | ').slice(0, 600)}`));
      resolve();
    });
  });
}

/**
 * Install Koragent into $KORAGENT_HOME/bin/koragent, pinned by sha256. Never throws: the result says what happened.
 * Nothing is replaced unless the new binary verified (hash + --version gate).
 */
export async function installKoragent(opts: KoragentInstallOptions = {}): Promise<KoragentInstallResult> {
  const env = opts.env ?? process.env;
  const target = koragentInstallPath(env);
  const ac = new AbortController();
  if (opts.signal) { if (opts.signal.aborted) ac.abort(); else opts.signal.addEventListener('abort', () => ac.abort(), { once: true }); }
  const say = (m: string) => { try { opts.onProgress?.(m); } catch { /* listener */ } };
  const platform = opts.deps?.platform ?? process.platform;
  const arch = opts.deps?.arch ?? process.arch;
  const op = crypto.randomBytes(6).toString('hex');
  const binDir = path.dirname(target);
  const work = path.join(binDir, `.partial-${op}`);
  let source: string | null = null;
  try {
    const want = opts.sha256?.trim().toLowerCase() || null;
    if (want && !/^[0-9a-f]{64}$/.test(want)) throw new InstallError(`--sha256 must be 64 hex characters`);
    await fs.promises.mkdir(work, { recursive: true, mode: 0o700 });
    let from = opts.from?.trim() || env.KORAGENT_BUILD_PATH?.trim() || null;
    if (!from && opts.build) {
      say(`building koragent in ${opts.build} (script/build.ts --single)…`);
      await (opts.deps?.runBuild ?? defaultRunBuild)(opts.build, ac.signal);
      from = opts.build;
    }
    if (!from) throw new InstallError('no source: pass --from <binary|dir|url>, set KORAGENT_BUILD_PATH, or --build <koragent checkout>');
    let file: string;
    if (/^https?:\/\//i.test(from)) {
      if (!want) throw new InstallError('a URL install needs the expected --sha256 (Kora will not run an unpinned download)');
      source = from;
      say(`downloading ${from}…`);
      file = path.join(work, 'download');
      await (opts.deps?.download ?? defaultDownload)(from, file, ac.signal);
    } else {
      const abs = path.resolve(from.startsWith('~/') ? path.join(os.homedir(), from.slice(2)) : from);
      let st: fs.Stats;
      try { st = fs.statSync(abs); } catch { throw new InstallError(`not found: ${abs}`); }
      const found = st.isDirectory() ? findKoragentBinary(abs, platform, arch) : abs;
      if (!found) throw new InstallError(`no koragent binary under ${abs} (looked for koragent, bin/koragent, dist/${platformName(platform, arch)}/bin/koragent)`);
      if (path.resolve(found) === path.resolve(target)) throw new InstallError(`${found} is already the install target`);
      source = found;
      file = found;
    }
    say('checking the sha256…');
    const srcHash = await sha256File(file, ac.signal);
    if (want && srcHash !== want) throw new InstallError(`checksum mismatch: the source's sha256 is ${srcHash}, expected ${want}. Nothing was installed.`);
    const staged = path.join(work, 'koragent');
    await fs.promises.copyFile(file, staged);
    await fs.promises.chmod(staged, 0o755);
    const copyHash = await sha256File(staged, ac.signal);
    if (copyHash !== srcHash) throw new InstallError('the copy does not match its source (sha256 changed while copying); nothing was installed');
    say('running koragent --version…');
    const v = await koragentVersionDetail(staged);
    if (!v.version) throw new InstallError(`koragent --version did not work (${v.detail}); nothing was installed`);
    if (!koragentVersionOk(v.version)) throw new InstallError(`koragent ${v.version} is older than ${KORAGENT_MIN_VERSION}; nothing was installed`);
    // Into place: the binary by rename (atomic on one filesystem), then its pin.
    await fs.promises.rename(staged, target);
    await fs.promises.writeFile(pinFile(target), `${copyHash}  koragent\n`, { mode: 0o644 });
    await fs.promises.writeFile(infoFile(target), JSON.stringify({ version: v.version, sha256: copyHash, source, installedAt: Date.now() }, null, 2) + '\n', { mode: 0o644 });
    pinCache.delete(target);
    return { ok: true, path: target, version: v.version, sha256: copyHash, source, message: `installed koragent ${v.version} at ${target} (sha256 ${copyHash.slice(0, 12)}…)` };
  } catch (e: any) {
    const msg = e instanceof InstallError ? e.message : ac.signal.aborted ? 'cancelled' : `install failed: ${e?.message || e}`;
    return { ok: false, path: target, version: null, sha256: null, source, message: msg };
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
