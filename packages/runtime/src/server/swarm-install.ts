// OpenCode detection + install (pinned GitHub release zip → ~/.kora/tools/opencode/<ver>/, `current` symlink).
//
// Install (R5, PLAN D-d): download https://github.com/anomalyco/opencode/releases/download/v<ver>/opencode-darwin-<arch>.zip
// → verify its sha256 against the digest pinned below BEFORE extracting → `/usr/bin/ditto -x -k` → `<bin> --version`
// → atomically re-point `current`. No shell-rc edits, no npm/brew, no sudo. A version without a pinned digest fails
// closed. Everything here is async (fetch streams, child processes) — the daemon's event loop carries the UI socket.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { koraHome } from '../protocol/types';
import type { SwarmInstallState, SwarmOpencodeSource } from '../protocol/types';
import { loadConfig } from '../config';
import { winCommand } from '../util/win-exec';

export const OPENCODE_MIN_VERSION = '1.18.0';
export const OPENCODE_PINNED_VERSION = '1.18.32';

/**
 * sha256 of each release asset, from the GitHub release API's asset `digest` field
 * (`gh api repos/anomalyco/opencode/releases/tags/v1.18.32`, read 2026-09-24; release published 2026-09-21).
 * Bump OPENCODE_PINNED_VERSION and this table together.
 */
const PINNED_SHA256: Record<string, Partial<Record<'arm64' | 'x64', string>>> = {
  '1.18.32': {
    arm64: 'fa643f93401c13508d8d513780e54ce9cc01203d501114be9b88d62408b8101f', // opencode-darwin-arm64.zip, 46299070 bytes
    x64: 'a24bf10499382f8855e19d2a081b8683e4ab99c7c2affb32dc89b17c8a00ccd6',   // opencode-darwin-x64.zip, 48490250 bytes
  },
};

/** The Windows assets of the same releases (`opencode-windows-<arch>.zip`, read 2026-10-15 from the same API). */
const PINNED_SHA256_WINDOWS: Record<string, Partial<Record<'arm64' | 'x64', string>>> = {
  '1.18.32': {
    arm64: '5c1c21e85b694ac3fedccff22f934484c29273d5b5780eff006960304108e124', // opencode-windows-arm64.zip, 60591906 bytes
    x64: '1483c72d5adced825590a0ecf8cc18b3e87e535960a125dbf539d33bce135d0f',   // opencode-windows-x64.zip, 62101772 bytes
  },
};

const releaseUrl = (version: string, arch: string, platform: string = process.platform) =>
  `https://github.com/anomalyco/opencode/releases/download/v${version}/opencode-${platform === 'win32' ? 'windows' : 'darwin'}-${arch}.zip`;
/** The binary's file name: `opencode.exe` on Windows. */
const BIN = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
const toolsRoot = () => path.join(koraHome(), 'tools', 'opencode');

// ---------------------------------------------------------------------------------------------------------------
// detection

/** Test seams for the search (defaults: the real config, homes, PATH and filesystem). */
interface ResolveDeps {
  opencodePath?: string | null;
  koraHome?: string;
  home?: string;
  pathEnv?: string;
  isExecutable?: (p: string) => boolean;
  /** The login-shell probe (`$SHELL -ilc 'command -v opencode'`), used by refreshOpencodeBinary only. */
  loginShell?: () => Promise<string | null>;
}

function isExecutableFile(p: string): boolean {
  if (process.platform === 'win32') { try { return fs.statSync(p).isFile() && /\.(exe|cmd|bat|com)$/i.test(p); } catch { return false; } }
  try { if (!fs.statSync(p).isFile()) return false; fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

let resolveCache: { at: number; value: { path: string | null; source: SwarmOpencodeSource | null } } | null = null;
/** What the last async login-shell probe found (the daemon's own PATH may be thin — ref-runtime B10). */
let loginShellHit: string | null = null;
const RESOLVE_TTL_MS = 60_000;

/** The candidate list, in search order. Pure (given deps) so tests can drive it with a fake filesystem. */
function candidates(deps: ResolveDeps): { path: string; source: SwarmOpencodeSource }[] {
  const home = deps.home ?? os.homedir();
  const out: { path: string; source: SwarmOpencodeSource }[] = [];
  let configured: string | null = null;
  if (deps.opencodePath !== undefined) configured = deps.opencodePath;
  else { try { configured = loadConfig().swarm.opencodePath; } catch { configured = null; } }
  if (configured) out.push({ path: configured.startsWith('~/') ? path.join(home, configured.slice(2)) : configured, source: 'config' });
  out.push({ path: path.join(deps.koraHome ?? koraHome(), 'tools', 'opencode', 'current', BIN), source: 'kora' });
  for (const dir of (deps.pathEnv ?? process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && path.isAbsolute(dir)) {
      out.push({ path: path.join(dir, BIN), source: 'path' });
      if (process.platform === 'win32') out.push({ path: path.join(dir, 'opencode.cmd'), source: 'path' });   // npm's shim
    }
  }
  out.push({ path: path.join(home, '.opencode', 'bin', BIN), source: 'opencode-home' });
  if (process.platform === 'win32') out.push({ path: path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', 'opencode.cmd'), source: 'path' });
  out.push({ path: '/opt/homebrew/bin/opencode', source: 'homebrew' });
  out.push({ path: '/usr/local/bin/opencode', source: 'homebrew' });
  out.push({ path: path.join(home, '.bun', 'bin', 'opencode'), source: 'bun' });
  out.push({ path: path.join(home, '.local', 'bin', 'opencode'), source: 'local' });
  return out;
}

/**
 * config swarm.opencodePath → ~/.kora/tools/opencode/current → the daemon's PATH → ~/.opencode/bin → /opt/homebrew/bin
 * → /usr/local/bin → ~/.bun/bin → ~/.local/bin → (last) what the async login-shell probe found. Cached 60 s.
 * Synchronous and cheap (stat only); the login-shell probe itself runs in refreshOpencodeBinary().
 */
export function resolveOpencodeBinary(deps?: ResolveDeps): { path: string | null; source: SwarmOpencodeSource | null } {
  if (!deps && resolveCache && Date.now() - resolveCache.at < RESOLVE_TTL_MS) return resolveCache.value;
  const isExec = deps?.isExecutable ?? isExecutableFile;
  let value: { path: string | null; source: SwarmOpencodeSource | null } = { path: null, source: null };
  for (const c of candidates(deps ?? {})) if (isExec(c.path)) { value = { path: c.path, source: c.source }; break; }
  if (!value.path && loginShellHit && isExec(loginShellHit)) value = { path: loginShellHit, source: 'path' };
  if (!deps) resolveCache = { at: Date.now(), value };
  return value;
}

/** Ask the user's login shell where opencode is (PATH set in .zshrc / .zprofile). 5 s cap; never throws. */
function probeLoginShell(): Promise<string | null> {
  if (process.platform === 'win32') return Promise.resolve(null);   // no login shell; PATH comes from the registry
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', 'command -v opencode'], { timeout: 5000, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' } }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const hit = String(stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/') && l.endsWith('/opencode')).pop();
      resolve(hit ?? null);
    }).stdin?.end();
  });
}

/**
 * Drop the cache and search again; when the fixed search finds nothing, run the (async) login-shell probe and
 * search once more. `getStatus({probe:true})` ("Check again") calls this.
 */
export async function refreshOpencodeBinary(deps?: ResolveDeps): Promise<{ path: string | null; source: SwarmOpencodeSource | null }> {
  resolveCache = null;
  const first = resolveOpencodeBinary(deps);
  if (first.path) return first;
  const hit = await (deps?.loginShell ?? probeLoginShell)();
  const isExec = deps?.isExecutable ?? isExecutableFile;
  if (hit && isExec(hit)) {
    if (!deps) loginShellHit = hit;
    const value = { path: hit, source: 'path' as const };
    if (!deps) resolveCache = { at: Date.now(), value };
    return value;
  }
  return first;
}

/** Forget the cached search (after an install). */
export function invalidateOpencodeBinary(): void { resolveCache = null; }

function runVersion(bin: string): Promise<{ version: string | null; detail: string }> {
  // A freshly written binary's FIRST exec can sit in macOS's exec assessment for well over 15 s on a loaded machine
  // (measured: the install happy path timed out under the parallel test suite). A timeout is not a verdict: one retry
  // with a longer budget — the second exec of the same file is fast once assessed.
  return runVersionOnce(bin, 15_000).then((r) => (r.timedOut ? runVersionOnce(bin, 30_000) : r)).then(({ version, detail }) => ({ version, detail }));
}
function runVersionOnce(bin: string, timeoutMs: number): Promise<{ version: string | null; detail: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const w = winCommand(bin, ['--version']); // an npm opencode.cmd on Windows
    execFile(w.command, w.args, { timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1', NO_COLOR: '1' }, windowsHide: true, windowsVerbatimArguments: w.windowsVerbatimArguments }, (err, stdout, stderr) => {
      const m = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(String(stdout || ''));
      if (m) return resolve({ version: m[1], detail: '', timedOut: false });
      const timedOut = !!(err as any)?.killed;
      const detail = (String(stderr || '').trim() || (err ? String(timedOut ? `timed out after ${timeoutMs / 1000} s` : err.message) : 'no version in the output')).slice(0, 400);
      resolve({ version: null, detail, timedOut });
    }).stdin?.end();
  });
}

/** `<path> --version` (15 s, one 30 s retry after a timeout); null when it fails. */
export async function opencodeVersion(binPath: string): Promise<string | null> {
  return (await runVersion(binPath)).version;
}

/** Numeric x.y.z comparison (a pre-release suffix sorts before its release). */
export function compareOpencodeVersions(a: string, b: string): number {
  const parse = (v: string) => { const [core, pre] = v.replace(/^v/, '').split('-', 2); return { n: core.split('.').map((x) => Number(x) || 0), pre: pre ?? null }; };
  const x = parse(a); const y = parse(b);
  for (let i = 0; i < 3; i++) { const d = (x.n[i] ?? 0) - (y.n[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  if (x.pre === y.pre) return 0;
  return x.pre == null ? 1 : y.pre == null ? -1 : x.pre < y.pre ? -1 : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// install

/** Test seams (a fake downloader, a temp root, a fake platform and pinned-digest table). */
interface InstallDeps {
  root?: string;                     // default ~/.kora/tools/opencode
  platform?: string;                 // default process.platform
  arch?: string;                     // default process.arch
  checksums?: Record<string, Partial<Record<'arm64' | 'x64', string>>>;
  operationId?: string;
  download?: (url: string, dest: string, o: { signal: AbortSignal; onBytes: (downloaded: number, total: number | null) => void }) => Promise<void>;
  extract?: (zip: string, dest: string, signal: AbortSignal) => Promise<void>;
}

type FailKind = 'network' | 'unsupported-platform' | 'checksum-unavailable' | 'checksum-mismatch' | 'verify-failed' | 'cancelled';
class InstallFailure extends Error { constructor(readonly kind: FailKind, message: string) { super(message); } }

async function defaultDownload(url: string, dest: string, o: { signal: AbortSignal; onBytes: (d: number, t: number | null) => void }): Promise<void> {
  let res: Response;
  try { res = await fetch(url, { signal: o.signal, redirect: 'follow' }); }
  catch (e: any) {
    if (o.signal.aborted) throw new InstallFailure('cancelled', 'cancelled');
    throw new InstallFailure('network', `network error: ${e?.cause?.code || e?.message || e}`);
  }
  if (!res.ok || !res.body) throw new InstallFailure('network', `network error: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || null;
  let got = 0;
  const body = Readable.fromWeb(res.body as any);
  body.on('data', (chunk: Buffer) => { got += chunk.length; o.onBytes(got, total); });
  try { await pipeline(body, fs.createWriteStream(dest, { mode: 0o600 }), { signal: o.signal }); }
  catch (e: any) {
    if (o.signal.aborted) throw new InstallFailure('cancelled', 'cancelled');
    throw new InstallFailure('network', `network error: ${e?.code || e?.message || e}`);
  }
}

/** Windows' own bsdtar (Windows 10 1803+), never whatever `tar` PATH finds first. */
export function windowsTar(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe');
}

function defaultExtract(zip: string, dest: string, signal: AbortSignal): Promise<void> {
  // macOS: ditto. Windows 10+: System32's bsdtar reads zip archives. Named by full path: a `tar` earlier on PATH (Git for
  // Windows' usr/bin, MSYS2, Cygwin) is GNU tar, which cannot read a zip.
  const [cmd, args] = process.platform === 'win32' ? [windowsTar(), ['-xf', zip, '-C', dest]] : ['/usr/bin/ditto', ['-x', '-k', zip, dest]];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000, signal, windowsHide: true }, (err, _out, stderr) => {
      if (err) return reject(signal.aborted ? new InstallFailure('cancelled', 'cancelled') : new InstallFailure('verify-failed', `verify failed: could not extract the archive (${String(stderr || err.message).trim().slice(0, 300)})`));
      resolve();
    });
  });
}

async function sha256File(file: string, signal: AbortSignal): Promise<string> {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h, { signal });
  return h.digest('hex');
}

/** The extracted `opencode` binary: at the archive root, or one directory down. */
async function findBinary(dir: string): Promise<string | null> {
  const direct = path.join(dir, BIN);
  if (isExecutableFile(direct) || fs.existsSync(direct)) return direct;
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === '__MACOSX') continue;
    const p = path.join(dir, e.name, BIN);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Download → sha256 → extract → `--version` → `current` symlink. Resolves with the final state (succeeded, failed or
 * cancelled — it does not throw); `onProgress` sees every phase. `signal` cancels at any point.
 */
export async function installOpencode(opts: {
  version?: string;
  signal?: AbortSignal;
  onProgress?: (state: SwarmInstallState) => void;
  deps?: InstallDeps;
}): Promise<SwarmInstallState> {
  const deps = opts.deps ?? {};
  const version = (opts.version ?? OPENCODE_PINNED_VERSION).replace(/^v/, '');
  const ac = new AbortController();
  if (opts.signal) { if (opts.signal.aborted) ac.abort(); else opts.signal.addEventListener('abort', () => ac.abort(), { once: true }); }
  const signal = ac.signal;
  let state: SwarmInstallState = {
    operationId: deps.operationId ?? crypto.randomUUID(), phase: 'downloading', downloadedBytes: 0, totalBytes: null,
    version, installedVersion: null, message: null,
  };
  const set = (patch: Partial<SwarmInstallState>) => { state = { ...state, ...patch }; try { opts.onProgress?.(state); } catch { /* listener */ } };
  const checkCancel = () => { if (signal.aborted) throw new InstallFailure('cancelled', 'cancelled'); };

  const root = deps.root ?? toolsRoot();
  const work = path.join(root, `.partial-${state.operationId}`);
  try {
    set({});
    const platform = deps.platform ?? process.platform;
    const arch = deps.arch ?? process.arch;
    if ((platform !== 'darwin' && platform !== 'win32') || (arch !== 'arm64' && arch !== 'x64')) {
      throw new InstallFailure('unsupported-platform', `unsupported platform: Kora installs OpenCode on macOS and Windows (arm64/x64) only, not ${platform}-${arch}. Install it yourself and press Check again.`);
    }
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new InstallFailure('verify-failed', `verify failed: "${version}" is not a release version`);
    const expected = (deps.checksums ?? (platform === 'win32' ? PINNED_SHA256_WINDOWS : PINNED_SHA256))[version]?.[arch as 'arm64' | 'x64'];
    if (!expected) {
      throw new InstallFailure('checksum-unavailable', `checksum unavailable: Kora has no pinned sha256 for OpenCode v${version} (${arch}), so it will not install it. Kora can install v${OPENCODE_PINNED_VERSION}; for another version install it yourself (brew, the official script or npm) and press Check again.`);
    }
    await fs.promises.mkdir(work, { recursive: true });
    const zip = path.join(work, 'opencode.zip');
    let lastEmit = 0;
    await (deps.download ?? defaultDownload)(releaseUrl(version, arch, platform), zip, {
      signal,
      onBytes: (downloaded, total) => {
        state = { ...state, downloadedBytes: downloaded, totalBytes: total };
        const now = Date.now();
        if (now - lastEmit >= 150 || (total != null && downloaded >= total)) { lastEmit = now; set({}); }
      },
    });
    checkCancel();
    const size = (await fs.promises.stat(zip)).size;
    set({ phase: 'verifying', downloadedBytes: size, totalBytes: state.totalBytes ?? size, message: 'checking the sha256' });
    const actual = await sha256File(zip, signal).catch((e) => { checkCancel(); throw e; });
    if (actual !== expected) {
      throw new InstallFailure('checksum-mismatch', `checksum mismatch: the download's sha256 is ${actual}, the pinned value is ${expected}. Nothing was installed.`);
    }
    checkCancel();
    set({ phase: 'extracting', message: null });
    const out = path.join(work, 'x');
    await fs.promises.mkdir(out, { recursive: true });
    await (deps.extract ?? defaultExtract)(zip, out, signal);
    checkCancel();
    const extracted = await findBinary(out);
    if (!extracted) throw new InstallFailure('verify-failed', 'verify failed: the archive has no opencode binary');
    await fs.promises.chmod(extracted, 0o755);
    set({ phase: 'verifying', message: 'running opencode --version' });
    const v = await runVersion(extracted);
    checkCancel();
    if (!v.version) throw new InstallFailure('verify-failed', `verify failed: opencode --version did not work (${v.detail})`);
    if (compareOpencodeVersions(v.version, version) !== 0) throw new InstallFailure('verify-failed', `verify failed: expected v${version}, the binary reports ${v.version}`);

    // Move into place: <root>/<ver>/opencode, then re-point `current` with a rename (atomic on one filesystem).
    const staged = path.join(work, 'final');
    await fs.promises.mkdir(staged, { recursive: true });
    await fs.promises.rename(extracted, path.join(staged, BIN));
    const finalDir = path.join(root, version);
    const old = path.join(root, `.old-${state.operationId}`);
    let hadOld = false;
    try { await fs.promises.rename(finalDir, old); hadOld = true; } catch { /* first install of this version */ }
    await fs.promises.rename(staged, finalDir);
    const link = path.join(root, `.current-${state.operationId}`);
    await fs.promises.rm(link, { force: true });
    if (process.platform === 'win32') {
      // Symlinks need admin or Developer Mode on Windows; a junction does not (absolute target), but cannot be renamed
      // over an existing one, so the old `current` goes first.
      await fs.promises.symlink(finalDir, link, 'junction');
      await fs.promises.rm(path.join(root, 'current'), { recursive: false, force: true }).catch(() => fs.promises.rmdir(path.join(root, 'current')).catch(() => {}));
    } else await fs.promises.symlink(version, link);
    await fs.promises.rename(link, path.join(root, 'current'));
    if (hadOld) await fs.promises.rm(old, { recursive: true, force: true }).catch(() => {});
    invalidateOpencodeBinary();
    set({ phase: 'succeeded', installedVersion: v.version, message: `installed OpenCode ${v.version} in ${finalDir}` });
  } catch (e: any) {
    const f: InstallFailure = e instanceof InstallFailure ? e
      : signal.aborted ? new InstallFailure('cancelled', 'cancelled')
      : new InstallFailure('network', `install failed: ${e?.message || e}`);
    set(f.kind === 'cancelled' ? { phase: 'cancelled', message: 'cancelled' } : { phase: 'failed', message: f.message });
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  }
  return state;
}
