// The blob browser engine: Chrome-for-Testing's `chrome-headless-shell`, downloaded on first use (never bundled in
// Kora.app: ad-hoc-signed Mach-Os would break notarization and add ~100 MB to every update), SHA-256 + size
// verified, cached under ~/Library/Application Support/Kora/browser[-Dev], one process per blob, pids recorded so a
// crashed daemon's browsers are swept on the next start. Never pattern-kills: only recorded pids whose command line
// still names our binary and that blob's profile are ever signalled.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { koraHome } from '../../protocol/types';
import { killChild, killPid } from '../../util/kill-child';

export interface EngineBuild { url: string; sha256: string; size: number; dirName: string; binRel: string }
export interface EngineSource { version: string; build: EngineBuild }

/** Pinned Chrome-for-Testing release. Bump together with the hashes (`shasum -a 256` of the zip). */
export const ENGINE_VERSION = '155.0.8059.39';
const CFT = 'https://storage.googleapis.com/chrome-for-testing-public';
const BUILDS: Record<string, EngineBuild> = {
  'darwin-arm64': {
    url: `${CFT}/${ENGINE_VERSION}/mac-arm64/chrome-headless-shell-mac-arm64.zip`,
    sha256: 'b3e093c06001c41e68decbc8dd4a62f9efe4bf4e4dd247a686ea531863448d75', size: 102_429_510,
    dirName: 'chrome-headless-shell-mac-arm64', binRel: 'chrome-headless-shell',
  },
  'darwin-x64': {
    url: `${CFT}/${ENGINE_VERSION}/mac-x64/chrome-headless-shell-mac-x64.zip`,
    sha256: '6338a784c691f42dd1ed6aeeef650171c7d72cf74bdb8450d0079864e72a8074', size: 107_758_350,
    dirName: 'chrome-headless-shell-mac-x64', binRel: 'chrome-headless-shell',
  },
};

/**
 * QA seam: `KORA_BROWSER_TEST_SOURCE` = JSON `{version,url,sha256,size,dirName,binRel}` swaps the pinned build for one served from
 * THIS machine (http://127.0.0.1 only), so a spec can drive the real install button end to end without a 98 MB download.
 * Anything else (another host, bad JSON) is ignored: the pinned, hash-checked Chrome-for-Testing build stays in force.
 */
export function testEngineSource(raw = process.env.KORA_BROWSER_TEST_SOURCE): EngineSource | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    const ok = typeof j?.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\//.test(j.url) && /^[0-9a-f]{64}$/.test(String(j.sha256)) && Number.isInteger(j.size) && j.size > 0
      && /^\d+\.\d+\.\d+\.\d+$/.test(String(j.version)) && /^[\w.-]+$/.test(String(j.dirName)) && /^[\w.-]+$/.test(String(j.binRel));
    return ok ? { version: j.version, build: { url: j.url, sha256: j.sha256, size: j.size, dirName: j.dirName, binRel: j.binRel } } : null;
  } catch { return null; }
}

export function pinnedEngine(): EngineSource | null {
  const fake = testEngineSource();
  if (fake) return fake;
  const build = BUILDS[`${process.platform}-${process.arch}`];
  return build ? { version: ENGINE_VERSION, build } : null;
}

export type InstallPhase = 'download' | 'verify' | 'extract' | 'warm' | 'done';
export interface InstallProgress { phase: InstallPhase; received: number; total: number; fraction: number }
export interface InstalledEngine { bin: string; version: string; dir: string }

/** `~/Library/Application Support/Kora/browser`, with a `-Dev` / `-QA` suffix in a flavored home. KORA_BROWSER_DIR wins. */
export function browserCacheDir(): string {
  const env = process.env.KORA_BROWSER_DIR?.trim();
  if (env) return path.resolve(env.replace(/^~(?=$|\/)/, os.homedir()));
  const home = path.basename(koraHome());
  const suffix = home === '.kora-dev' ? '-Dev' : home === '.kora-qa' ? '-QA' : '';
  return path.join(os.homedir(), 'Library', 'Application Support', 'Kora', `browser${suffix}`);
}

const versionDir = (dir: string, src: EngineSource) => path.join(dir, `${src.version}-${process.arch}`);

/** The installed engine under `dir` (default: this flavor's cache), or null. Cheap: one stat + one small read. */
export async function findInstalledEngine(dir = browserCacheDir(), source: EngineSource | null = pinnedEngine()): Promise<InstalledEngine | null> {
  if (!source) return null;
  const root = versionDir(dir, source);
  const bin = path.join(root, source.build.binRel);
  try {
    const ready = JSON.parse(await fsp.readFile(path.join(root, 'ready.json'), 'utf8'));
    if (ready.version !== source.version) return null;
    await fsp.access(bin, fs.constants.X_OK);
    return { bin, version: source.version, dir };
  } catch { return null; }
}

export interface EngineStatus { supported: boolean; installed: boolean; version: string | null; downloadBytes: number | null; dir: string }
export async function engineStatus(dir = browserCacheDir()): Promise<EngineStatus> {
  const src = pinnedEngine();
  const inst = await findInstalledEngine(dir, src);
  return { supported: !!src, installed: !!inst, version: src?.version ?? null, downloadBytes: src?.build.size ?? null, dir };
}

export interface EnsureOptions {
  dir?: string;
  onProgress?(p: InstallProgress): void;
  /** Test seam: a different zip (served from http://127.0.0.1) with its own hash/size. */
  source?: EngineSource;
  signal?: AbortSignal;
}

const installing = new Map<string, Promise<InstalledEngine>>();

/** Install the engine if missing (downloads ~100 MB once), else return it. Concurrent callers share one install. */
export function ensureEngine(opts: EnsureOptions = {}): Promise<InstalledEngine> {
  const dir = opts.dir ?? browserCacheDir();
  const source = opts.source ?? pinnedEngine();
  if (!source) return Promise.reject(new Error(`the blob browser is not available on ${process.platform}-${process.arch}`));
  const key = `${dir}\0${source.version}`;
  let p = installing.get(key);
  if (!p) {
    p = (async () => (await findInstalledEngine(dir, source)) ?? install(dir, source, opts))().finally(() => installing.delete(key));
    installing.set(key, p);
  }
  return p;
}

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => (err ? reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(0, 300)}`)) : resolve(String(stdout))));
  });
}

async function install(dir: string, src: EngineSource, opts: EnsureOptions): Promise<InstalledEngine> {
  const report = (phase: InstallPhase, received: number, total: number) => { try { opts.onProgress?.({ phase, received, total, fraction: total ? Math.min(1, received / total) : 0 }); } catch { /* progress is advisory */ } };
  await fsp.mkdir(dir, { recursive: true });
  const tmp = await fsp.mkdtemp(path.join(dir, '.install-'));
  try {
    const zip = path.join(tmp, 'engine.zip');
    // download, hashing as we go
    const res = await fetch(src.build.url, { signal: opts.signal });
    if (!res.ok || !res.body) throw new Error(`engine download failed: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared && declared !== src.build.size) throw new Error(`engine download has an unexpected size (${declared}, expected ${src.build.size})`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(zip, { mode: 0o600 });
    let received = 0, lastReport = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length;
      if (received > src.build.size) throw new Error('engine download is larger than expected');
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
      const now = Date.now();
      if (now - lastReport > 200) { lastReport = now; report('download', received, src.build.size); }
    }
    out.end(); await once(out, 'finish');
    report('download', received, src.build.size);
    report('verify', received, src.build.size);
    if (received !== src.build.size) throw new Error(`engine download is truncated (${received} of ${src.build.size} bytes)`);
    const digest = hash.digest('hex');
    if (digest !== src.build.sha256) throw new Error('engine download failed its SHA-256 check; refusing to install it');
    // extract with the system `ditto` (keeps modes and symlinks; async, so the event loop is never blocked)
    report('extract', received, src.build.size);
    const ex = path.join(tmp, 'x');
    await fsp.mkdir(ex);
    await run('/usr/bin/ditto', ['-x', '-k', zip, ex]);
    const root = path.join(ex, src.build.dirName);
    const bin = path.join(root, src.build.binRel);
    await fsp.chmod(bin, 0o755);
    await fsp.rm(zip, { force: true });
    // The first exec of a new binary pays a Gatekeeper/XProtect scan (~3 s): pay it here, not on the first task.
    report('warm', received, src.build.size);
    await run(bin, ['--version'], 60_000);
    await fsp.writeFile(path.join(root, 'ready.json'), JSON.stringify({ version: src.version, sha256: digest, installedAt: Date.now() }));
    const target = versionDir(dir, src);
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(root, target);
    // older versions are dead weight (216 MB each)
    for (const e of await fsp.readdir(dir)) if (/^\d+\.\d+\.\d+\.\d+-/.test(e) && path.join(dir, e) !== target) await fsp.rm(path.join(dir, e), { recursive: true, force: true }).catch(() => {});
    report('done', received, src.build.size);
    return { bin: path.join(target, src.build.binRel), version: src.version, dir };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- pid registry + orphan sweep

interface PidEntry { profileDir: string; bin: string; ownerPid: number; startedAt: number }
const registryFile = (dir: string) => path.join(dir, 'pids.json');
let registryChain: Promise<unknown> = Promise.resolve();

/** Serialized read-modify-write of <dir>/pids.json (small, async, atomic rename). */
function editRegistry<T>(dir: string, fn: (reg: Record<string, PidEntry>) => T): Promise<T> {
  const next = registryChain.then(async () => {
    let reg: Record<string, PidEntry> = {};
    try { reg = JSON.parse(await fsp.readFile(registryFile(dir), 'utf8')); } catch { /* none yet */ }
    const out = fn(reg);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${registryFile(dir)}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(reg), { mode: 0o600 });
    await fsp.rename(tmp, registryFile(dir));
    return out;
  });
  registryChain = next.catch(() => {});
  return next;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** A process's command line, '' when unknown. Windows has no ps: CIM's Win32_Process.CommandLine (UTF-8 out). */
async function commandOf(pid: number): Promise<string> {
  if (process.platform === 'win32') {
    if (!Number.isInteger(pid) || pid <= 0) return '';
    const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`;
    try { return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 15_000)).trim(); } catch { return ''; }
  }
  try { return (await run('/bin/ps', ['-p', String(pid), '-o', 'command='], 5_000)).trim(); } catch { return ''; }
}

/** A Windows command line split the way the C runtime does (CommandLineToArgvW): quotes group, `\"` is a literal quote. */
export function splitWindowsCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inArg = false, quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\') {
      let n = 0; while (line[i] === '\\') { n++; i++; }
      if (line[i] === '"') { cur += '\\'.repeat(n >> 1); if (n & 1) cur += '"'; else quoted = !quoted; }
      else { cur += '\\'.repeat(n); i--; }
      inArg = true;
    } else if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
      inArg = true;
    } else if ((c === ' ' || c === '\t') && !quoted) {
      if (inArg) { out.push(cur); cur = ''; inArg = false; }
    } else { cur += c; inArg = true; }
  }
  if (inArg) out.push(cur);
  return out;
}

/**
 * Is `cmd` our headless shell running on `profileDir`? macOS/Linux: the command text names the shell and the flag
 * (ps prints argv unquoted). Windows: one argument must be exactly `--user-data-dir=<profileDir>` (case-folded: NTFS),
 * so `…\profile-2` never matches `…\profile`.
 */
export function isOrphanBrowser(cmd: string, profileDir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!cmd.includes('chrome-headless-shell')) return false;
  if (platform !== 'win32') return cmd.includes(`--user-data-dir=${profileDir}`);
  const want = `--user-data-dir=${profileDir}`.toLowerCase();
  return splitWindowsCommandLine(cmd).some((a) => a.toLowerCase() === want);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Remove Chromium's profile singleton files when the pid they name is dead (a crashed/killed run leaves them). */
export async function clearStaleProfileLocks(profileDir: string): Promise<void> {
  try {
    const target = await fsp.readlink(path.join(profileDir, 'SingletonLock'));
    const pid = Number(target.split('-').pop());
    if (pidAlive(pid)) return;
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) await fsp.rm(path.join(profileDir, f), { force: true });
  } catch { /* no lock */ }
}

export interface SweepResult { killed: number[]; cleared: number[]; skipped: number[] }

/**
 * Kill browsers left behind by a daemon that died without closing them. Run once at daemon start. An entry is
 * touched only if its owner process is gone, and a live pid is signalled only when its command line still names
 * our headless shell and that blob's profile dir (pid reuse can never make this kill an innocent process).
 */
export async function sweepOrphans(opts: { dir?: string; log?(m: string): void } = {}): Promise<SweepResult> {
  const dir = opts.dir ?? browserCacheDir();
  const res: SweepResult = { killed: [], cleared: [], skipped: [] };
  let reg: Record<string, PidEntry> = {};
  try { reg = JSON.parse(await fsp.readFile(registryFile(dir), 'utf8')); } catch { return res; }
  const drop: string[] = [];
  for (const [key, e] of Object.entries(reg)) {
    const pid = Number(key);
    if (pidAlive(e.ownerPid)) { res.skipped.push(pid); continue; } // owned by a live daemon (possibly this one)
    if (pidAlive(pid)) {
      const cmd = await commandOf(pid);
      if (isOrphanBrowser(cmd, e.profileDir)) {
        opts.log?.(`browser sweep: stopping orphan pid ${pid}`);
        try { killPid(pid); } catch { /* raced */ }
        for (let i = 0; i < 40 && pidAlive(pid); i++) await sleep(100);
        if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* raced */ } for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(100); }
        res.killed.push(pid);
      }
    }
    await clearStaleProfileLocks(e.profileDir);
    res.cleared.push(pid); drop.push(key);
  }
  if (drop.length) await editRegistry(dir, (r) => { for (const k of drop) delete r[k]; });
  return res;
}

// ---------------------------------------------------------------- launch

export interface LaunchOptions {
  bin: string;
  profileDir: string;
  /** Where pids.json lives (the engine cache dir). */
  registryDir: string;
  viewport?: { width: number; height: number };
  startTimeoutMs?: number;
  /** Test seam: the pid recorded as this browser's owner (default: this process). */
  ownerPid?: number;
  /** Extra Chromium flags (tests: --host-resolver-rules). */
  extraArgs?: string[];
}

export interface EngineProcess {
  pid: number;
  wsUrl: string;
  startMs: number;
  proc: ChildProcess;
  /** Resolves with the exit code once the process is gone. */
  exited: Promise<number | null>;
  hasExited(): boolean;
}

const live = new Set<ChildProcess>();
let exitHooked = false;
function hookExit(): void {
  if (exitHooked) return; exitHooked = true;
  // Last resort when the daemon itself exits without a graceful close: take our browsers with us.
  process.once('exit', () => { for (const p of live) { try { killChild(p); } catch { /* gone */ } } });
}

export async function launchEngine(o: LaunchOptions): Promise<EngineProcess> {
  hookExit();
  await fsp.mkdir(o.profileDir, { recursive: true, mode: 0o700 });
  await clearStaleProfileLocks(o.profileDir);
  const vp = o.viewport ?? { width: 1280, height: 800 };
  const args = [
    '--remote-debugging-port=0', `--user-data-dir=${o.profileDir}`, '--no-first-run', '--no-default-browser-check',
    '--mute-audio', '--disable-background-networking', `--window-size=${vp.width},${vp.height}`,
    ...(o.extraArgs ?? []),
  ];
  const t0 = performance.now();
  const proc = spawn(o.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (!proc.pid) throw new Error('could not start the blob browser (spawn failed)');
  live.add(proc);
  const pid = proc.pid;
  let exitedFlag = false;
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => { exitedFlag = true; live.delete(proc); void editRegistry(o.registryDir, (r) => { delete r[String(pid)]; }).catch(() => {}); resolve(code); }));
  await editRegistry(o.registryDir, (r) => { r[String(pid)] = { profileDir: o.profileDir, bin: o.bin, ownerPid: o.ownerPid ?? process.pid, startedAt: Date.now() }; });
  let tail = '';
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } reject(new Error(`the blob browser did not start in time\n${tail.slice(-400)}`)); }, o.startTimeoutMs ?? 20_000);
    proc.stderr!.on('data', (d: Buffer) => {
      tail = (tail + d.toString('utf8')).slice(-2000); // keep draining so the pipe never blocks the browser
      const m = tail.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    void exited.then((code) => { clearTimeout(timer); reject(new Error(`the blob browser exited at start (code ${code})\n${tail.slice(-400)}`)); });
  });
  return { pid, wsUrl, startMs: Math.round(performance.now() - t0), proc, exited, hasExited: () => exitedFlag };
}
