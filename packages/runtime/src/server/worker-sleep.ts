/**
 * Workers go to sleep after work — and a sleeping worker owns no folder.
 *
 * A chat lead's CLI worker (Claude Code, Codex, … in a pane) that has sat idle for `sleepAfterMs` (10 min) is put to
 * sleep: its final answer, last screen and CLI session (transcript) are recorded, any uncommitted edits are committed
 * to its branch, its process is closed and its worktree DIRECTORY is removed. The branch keeps the work (deleted at
 * once when the worker changed nothing); the record keeps everything a human or the lead wants to read afterwards.
 * Wake recreates the worktree from the branch and resumes the same CLI session. So directories exist only for
 * workers that are awake — past sessions leave cheap branches, never piles of checkouts.
 *
 * Retention: an asleep worker's unmerged branch is deleted after `workerBranchRetentionDays` (settings.json, default
 * 30; 0 = keep). Only workers that have a record (spawned after this shipped) are ever touched — older orphan
 * worktrees are left exactly as they were.
 *
 * Records: <KORA_HOME>/workers/<recordId>.json. Swarm workers are excluded (their own lifecycle owns them).
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { koraHome } from '../protocol/types';
import { GIT_NO_FSMONITOR, gitEnv } from '../util/safe-path';

export type WorkerRecordStatus = 'awake' | 'asleep';

export interface WorkerRecord {
  recordId: string;
  /** The pane id it had while awake (changes on every wake). */
  paneId: string;
  /** Every earlier pane id, oldest first: a lead (or a notification) may still name the worker by one of them. */
  pastPaneIds?: string[];
  orchestratorId: string;
  agent: string;
  title: string;
  prompt: string | null;
  /** The launch argv Kora gave it (model, effort, permission, no-subagent flags) — reused on wake. */
  args: string[];
  cwd: string;
  worktree: { path: string; branch: string; mainRoot: string } | null;
  createdAt: number;
  status: WorkerRecordStatus;
  /** The CLI's own session: what Wake resumes and where the full transcript lives. */
  session: { id: string | null; transcriptPath: string | null };
  lastIdleAt: number | null;
  sleptAt: number | null;
  /** Its final answer (last assistant message), captured when it fell asleep. */
  finalReport: string | null;
  lastScreen: string | null;
  /** Its work: commits on its branch beyond main, and the files they touch. */
  changes: { ahead: number; files: string[]; autoCommitted: boolean } | null;
  /** The branch still exists (false once deleted: nothing changed, merged away, or past retention). */
  branchKept: boolean;
  wakes: number;
}

export interface SleeperPane {
  id: string;
  agent: string;
  name: string;
  state: string;
  exited: boolean;
  role?: string | null;
  orchestratorId?: string | null;
  cwd: string;
  worktree: { path: string; branch: string; mainRoot: string } | null;
  swarm?: unknown;
  createdAt: number;
  agentSessionId?: string | null;
  agentSessionPath?: string | null;
  /** Set while Kora itself closes the pane for sleep: its exit is not "the worker exited". */
  sleeping?: boolean;
  read(source: 'screen' | 'scrollback', format: 'text', lines?: number): string;
}

export interface SleeperHost {
  panes(): SleeperPane[];
  report(paneId: string): string;
  kill(paneId: string): void;
  spawn(params: { agent: string; cwd: string; name: string; orchestratorId: string; args: string[]; prompt?: string; reuseWorktree?: { path: string; branch: string; mainRoot: string } }): Promise<{ id: string }>;
  /** Resolves when a freshly resumed pane accepts typing (idle and quiet); best effort and bounded, never rejects. */
  ready?(paneId: string): Promise<void>;
  notify(method: string, params: unknown): void;
  log(msg: string): void;
}

export type GitRun = (cwd: string, args: string[], timeoutMs?: number) => Promise<{ ok: boolean; out: string }>;
export const gitAsync: GitRun = (cwd, args, timeoutMs = 60_000) => new Promise((resolve) => {
  execFile('git', [...GIT_NO_FSMONITOR, '-C', cwd, ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: gitEnv() }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: `${stdout ?? ''}${err ? stderr ?? '' : ''}`.trim() }));
});

export const DEFAULT_SLEEP_AFTER_MS = 10 * 60_000;
export const DEFAULT_BRANCH_RETENTION_DAYS = 30;
const DAY = 86_400_000;

/** Days an asleep worker's unmerged branch is kept (settings.json `workerBranchRetentionDays`; 0 = forever). */
export function branchRetentionDays(home: string = koraHome()): number {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'))?.workerBranchRetentionDays;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  } catch { /* default */ }
  return DEFAULT_BRANCH_RETENTION_DAYS;
}

/** Find a Codex CLI session log by its working folder (Codex writes `session_meta.cwd` as the first line). */
/** A worker record id is one safe file-name segment (minted as `w_<base36>`). */
const SAFE_RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function findCodexSession(cwd: string, since: number, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): { id: string; path: string } | null {
  const root = path.join(home, 'sessions');
  const want = (() => { try { return fs.realpathSync(cwd); } catch { return cwd; } })();
  const days = new Set<string>();
  for (const t of [since, Date.now()]) {
    const d = new Date(t);
    days.add(path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  let best: { id: string; path: string; mtime: number } | null = null;
  for (const dir of days) {
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs < since - 60_000) continue;
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(16 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const first = JSON.parse(buf.subarray(0, n).toString('utf8').split('\n')[0]!);
        const meta = first?.payload ?? {};
        const c = String(meta.cwd ?? '');
        const real = (() => { try { return fs.realpathSync(c); } catch { return c; } })();
        if (real !== want) continue;
        const id = String(meta.session_id ?? meta.id ?? '');
        if (id && (!best || st.mtimeMs > best.mtime)) best = { id, path: file, mtime: st.mtimeMs };
      } catch { /* skip */ }
    }
  }
  return best ? { id: best.id, path: best.path } : null;
}

/** The argv that resumes a CLI session, in front of the launch flags. */
export function resumeArgs(agent: string, sessionId: string | null): string[] {
  if (!sessionId) return [];
  if (agent === 'claude') return ['--resume', sessionId];
  if (agent === 'codex') return ['resume', sessionId];
  return [];
}

/** What a wake did, for the lead's note: the session really resumed, or a fresh one was started (with the brief re-sent). */
export interface WakeResult { paneId: string; resumed: boolean; rebriefed: boolean }

/** The brief a fresh (not resumed) session starts with: the original task, and where the earlier work is. */
export function rebriefPrompt(r: Pick<WorkerRecord, 'prompt' | 'worktree' | 'branchKept'>): string | null {
  if (!r.prompt) return null;
  const where = r.worktree && r.branchKept ? ` Its earlier work is committed on branch ${r.worktree.branch}, checked out here.` : '';
  return `[kora] Your previous session could not be resumed, so this is a fresh session.${where} Your original brief was:\n\n${r.prompt}\n\nYour next instructions follow separately.`;
}

/** Can this record's CLI session really be resumed? A session id alone is not enough: `claude --resume` of an id with no
 *  transcript on disk starts nothing (or a blank session) while the lead is told it resumed. */
export function canResumeSession(r: Pick<WorkerRecord, 'agent' | 'session'>, findTranscript?: (sessionId: string) => string | null): boolean {
  if (!r.session.id || resumeArgs(r.agent, r.session.id).length === 0) return false;
  if (r.agent !== 'claude') return true;
  try {
    if (r.session.transcriptPath && fs.existsSync(r.session.transcriptPath)) return true;
    const find = findTranscript ?? ((id: string) => (require('../ledger/transcript') as typeof import('../ledger/transcript')).findTranscript(id));
    return !!find(r.session.id);
  } catch { return false; }
}

export class WorkerSleeper {
  private readonly dir: string;
  private readonly idleSince = new Map<string, number>();
  private readonly byPane = new Map<string, string>();
  private readonly busy = new Set<string>();
  private lastRetention = 0;

  constructor(
    private readonly host: SleeperHost,
    private readonly opts: { home?: string; sleepAfterMs?: number; git?: GitRun; now?: () => number; findTranscript?: (sessionId: string) => string | null } = {},
  ) {
    this.dir = path.join(opts.home ?? koraHome(), 'workers');
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.json')) continue;
        const r = this.load(f.slice(0, -5));
        if (r?.status === 'awake') this.byPane.set(r.paneId, r.recordId);
      }
    } catch { /* no records yet */ }
  }

  private get git(): GitRun { return this.opts.git ?? gitAsync; }
  private now(): number { return (this.opts.now ?? Date.now)(); }
  private file(id: string): string { return path.join(this.dir, `${id}.json`); }
  load(id: string): WorkerRecord | null {
    // The id arrives from HTTP (`/api/workers/transcript|wake?recordId=`) and from a lead's tool call: a `../` id read
    // any *.json on disk as a record — and wake() spawns the agent/args/cwd that record names. Ids are `w_<base36>`.
    if (!SAFE_RECORD_ID.test(id)) return null;
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as WorkerRecord; } catch { return null; }
  }
  private save(r: WorkerRecord): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file(r.recordId)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
    fs.renameSync(tmp, this.file(r.recordId));
  }
  list(orchestratorId?: string): WorkerRecord[] {
    let files: string[] = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    return files.map((f) => this.load(f.slice(0, -5))).filter((r): r is WorkerRecord => !!r && (!orchestratorId || r.orchestratorId === orchestratorId))
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  recordForPane(paneId: string): WorkerRecord | null {
    const id = this.byPane.get(paneId);
    return id ? this.load(id) : null;
  }
  /** The record a lead means by a pane id it used before the worker slept (the newest one with that id). */
  findByLastPane(orchestratorId: string, paneId: string): WorkerRecord | null {
    return this.list(orchestratorId).filter((r) => r.paneId === paneId || r.pastPaneIds?.includes(paneId)).at(-1) ?? null;
  }
  /** The live pane of an AWAKE worker that once had `paneId` (woken since — from the app's Wake button, say),
   *  or null. Pane ids restart at p1 per daemon, so only records of this daemon's awake workers count. */
  wokenPaneFor(paneId: string): string | null {
    for (const rid of new Set(this.byPane.values())) {
      const r = this.load(rid);
      if (r?.status === 'awake' && r.paneId !== paneId && r.pastPaneIds?.includes(paneId)) return r.paneId;
    }
    return null;
  }

  canResume(r: WorkerRecord): boolean { return canResumeSession(r, this.opts.findTranscript); }

  /** Spawns that are a wake (their record exists; track() must not start a second one). */
  private readonly waking = new Set<string>();

  /** A chat lead's CLI worker just spawned: start its record. */
  track(pane: SleeperPane, spawn: { prompt?: string | null; args?: string[] }): WorkerRecord | null {
    if (!pane.orchestratorId?.startsWith('chat:') || pane.swarm) return null;
    if (this.waking.has(`${pane.orchestratorId}|${pane.name}`)) return null;
    const r: WorkerRecord = {
      recordId: `w_${this.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      paneId: pane.id, orchestratorId: pane.orchestratorId, agent: pane.agent, title: pane.name, prompt: spawn.prompt ?? null,
      args: spawn.args ?? [], cwd: pane.cwd, worktree: pane.worktree ? { ...pane.worktree } : null, createdAt: this.now(),
      status: 'awake', session: { id: pane.agentSessionId ?? null, transcriptPath: pane.agentSessionPath ?? null },
      lastIdleAt: null, sleptAt: null, finalReport: null, lastScreen: null, changes: null, branchKept: !!pane.worktree, wakes: 0,
    };
    this.save(r);
    this.byPane.set(pane.id, r.recordId);
    return r;
  }

  private refreshSession(recordId: string, p: SleeperPane): void {
    if (!p.agentSessionId) return;
    const r = this.load(recordId);
    if (!r || (r.session.id === p.agentSessionId && r.session.transcriptPath === (p.agentSessionPath ?? r.session.transcriptPath))) return;
    r.session = { id: p.agentSessionId, transcriptPath: p.agentSessionPath ?? r.session.transcriptPath };
    this.save(r);
  }

  /** One pass (every ~30 s): idle clocks, sleep the ones idle long enough (or exited), branch retention hourly. */
  async tick(): Promise<void> {
    const now = this.now();
    const live = new Set<string>();
    for (const p of this.host.panes()) {
      const rid = this.byPane.get(p.id);
      if (!rid) continue;
      live.add(p.id);
      if (p.exited) { await this.sleep(p.id, 'exited'); continue; }
      // Remember the CLI's session while it is alive: a worker that is killed (exit 143) or reaped before its next
      // look must still be resumable, and the id only arrives after the record was made.
      this.refreshSession(rid, p);
      if (p.state === 'idle') {
        if (!this.idleSince.has(p.id)) this.idleSince.set(p.id, now);
        if (now - this.idleSince.get(p.id)! >= (this.opts.sleepAfterMs ?? DEFAULT_SLEEP_AFTER_MS)) await this.sleep(p.id, 'idle');
      } else this.idleSince.delete(p.id);
    }
    // A tracked pane that vanished: a daemon restart re-spawned it under a new id (same worktree) → adopt that pane;
    // otherwise it was reaped before we saw it exit → settle its record from what we have. Never remove a folder a
    // live pane is using.
    const panes = this.host.panes();
    for (const [paneId, rid] of [...this.byPane]) {
      if (live.has(paneId)) continue;
      const r = this.load(rid);
      const heir = r?.worktree ? panes.find((p) => !p.exited && p.worktree?.path === r.worktree!.path) : undefined;
      if (r && heir) {
        this.byPane.delete(paneId);
        this.byPane.set(heir.id, rid);
        r.paneId = heir.id;
        this.save(r);
        continue;
      }
      await this.sleep(paneId, 'gone');
    }
    if (now - this.lastRetention > 3_600_000) { this.lastRetention = now; await this.retention(); }
  }

  /** Put one worker to sleep. Safe to call twice; never throws. */
  async sleep(paneId: string, why: 'idle' | 'exited' | 'gone' | 'manual'): Promise<WorkerRecord | null> {
    const rid = this.byPane.get(paneId);
    if (!rid || this.busy.has(rid)) return null;
    this.busy.add(rid);
    try {
      const r = this.load(rid);
      if (!r || r.status !== 'awake') { this.byPane.delete(paneId); return r; }
      const pane = this.host.panes().find((p) => p.id === paneId) ?? null;
      // 1. What it said and where its transcript is — before the process goes.
      if (pane) {
        try { r.finalReport = this.host.report(paneId) || r.finalReport; } catch { /* none */ }
        try { r.lastScreen = pane.read('scrollback', 'text', 400); } catch { /* gone */ }
        r.session = { id: pane.agentSessionId ?? r.session.id, transcriptPath: pane.agentSessionPath ?? r.session.transcriptPath };
      }
      if (r.agent === 'codex' && !r.session.id) {
        const s = findCodexSession(r.worktree?.path ?? r.cwd, r.createdAt);
        if (s) r.session = { id: s.id, transcriptPath: s.path };
      }
      // 2. Close it (Kora's own close: no "worker exited" note for the lead).
      if (pane && !pane.exited) { pane.sleeping = true; try { this.host.kill(paneId); } catch { /* already gone */ } }
      // 3. Save its edits on its branch, then drop the folder (and the branch when it changed nothing) — unless another
      //    live pane works in it.
      const shared = r.worktree ? this.host.panes().some((p) => p.id !== paneId && !p.exited && p.worktree?.path === r.worktree!.path) : false;
      if (r.worktree && !shared && fs.existsSync(r.worktree.path)) {
        const wt = r.worktree;
        // The worker's own edits only — never Kora's onboarding files (CLAUDE.md block, .mcp.json, …, `isManaged`).
        const { isManaged } = require('./worktree') as typeof import('./worktree');
        const status = await this.git(wt.path, ['status', '--porcelain', '--untracked-files=all']);
        const mine = status.out.split('\n').filter((l) => l.trim()).map((l) => l.slice(3).trim().replace(/^.* -> /, '').replace(/^"|"$/g, ''))
          .filter((f) => f && !isManaged(f) && !f.startsWith('.kora/'));
        let autoCommitted = false;
        if (mine.length > 0) {
          await this.git(wt.path, ['add', '-A', '--', ...mine]);
          const c = await this.git(wt.path, ['-c', 'user.name=Kora', '-c', 'user.email=kora@localhost', 'commit', '-q', '--no-verify', '-m', `kora: ${r.title} (saved when the worker went to sleep)`, '--', ...mine]);
          autoCommitted = c.ok;
        }
        const ahead = Number((await this.git(wt.mainRoot, ['rev-list', '--count', `HEAD..${wt.branch}`])).out) || 0;
        const files = ahead > 0 ? (await this.git(wt.mainRoot, ['diff', '--name-only', `HEAD...${wt.branch}`])).out.split('\n').filter(Boolean).slice(0, 200) : [];
        r.changes = { ahead, files, autoCommitted };
        const rm = await this.git(wt.mainRoot, ['worktree', 'remove', '--force', wt.path]);
        if (!rm.ok) { try { fs.rmSync(wt.path, { recursive: true, force: true }); } catch { /* best effort */ } await this.git(wt.mainRoot, ['worktree', 'prune']); }
        if (ahead === 0) { await this.git(wt.mainRoot, ['branch', '-D', wt.branch]); r.branchKept = false; }
      }
      r.status = 'asleep';
      r.sleptAt = this.now();
      r.lastIdleAt = this.idleSince.get(paneId) ?? r.sleptAt;
      this.save(r);
      this.byPane.delete(paneId);
      this.idleSince.delete(paneId);
      this.host.log(`worker ${paneId} (${r.agent} "${r.title}") asleep [${why}]: ${r.changes ? `${r.changes.ahead} commit(s) on ${r.worktree?.branch}${r.changes.autoCommitted ? ', edits auto-committed' : ''}, folder removed` : 'no worktree'}${r.session.id ? `, session ${r.session.id}` : ''}`);
      this.host.notify('worker.slept', { orchestratorId: r.orchestratorId, recordId: r.recordId, paneId });
      return r;
    } catch (e: any) {
      this.host.log(`worker ${paneId}: sleep failed: ${e?.message ?? e}`);
      return null;
    } finally { this.busy.delete(rid); }
  }

  /** Wake a sleeping worker: its worktree back from its branch, the same CLI session resumed. Returns the new pane id. */
  async wake(recordId: string): Promise<WakeResult> {
    const r = this.load(recordId);
    if (!r) throw new Error(`no worker record ${recordId}`);
    if (r.status === 'awake') return { paneId: r.paneId, resumed: true, rebriefed: false };
    if (this.busy.has(recordId)) throw new Error(`worker ${recordId} is busy`);
    this.busy.add(recordId);
    try {
      let reuse: { path: string; branch: string; mainRoot: string } | undefined;
      if (r.worktree && r.branchKept) {
        const wt = r.worktree;
        if (!fs.existsSync(wt.path)) {
          const add = await this.git(wt.mainRoot, ['worktree', 'add', wt.path, wt.branch], 120_000);
          if (!add.ok) throw new Error(`could not restore ${wt.branch}: ${add.out}`);
        }
        reuse = wt;
      }
      const wakeKey = `${r.orchestratorId}|${r.title}`;
      this.waking.add(wakeKey);
      // Resume only a session that can be resumed; otherwise start fresh and hand it its original brief again.
      const resumed = this.canResume(r);
      const rebrief = resumed ? null : rebriefPrompt(r);
      const info = await this.host.spawn({
        agent: r.agent, cwd: reuse?.path ?? r.cwd, name: r.title, orchestratorId: r.orchestratorId,
        args: [...(resumed ? resumeArgs(r.agent, r.session.id) : []), ...r.args], ...(rebrief ? { prompt: rebrief } : {}), ...(reuse ? { reuseWorktree: reuse } : {}),
      }).finally(() => this.waking.delete(wakeKey));
      r.status = 'awake';
      if (r.paneId !== info.id) r.pastPaneIds = [...(r.pastPaneIds ?? []), r.paneId];
      r.paneId = info.id;
      r.wakes += 1;
      this.save(r);
      this.byPane.set(info.id, r.recordId);
      this.host.log(`worker ${r.recordId} woke as ${info.id}${resumed ? ` (resumed ${r.session.id})` : rebrief ? ' (session not resumable: fresh session, brief re-sent)' : ' (session not resumable: fresh session, no brief on record)'}`);
      this.host.notify('worker.woke', { orchestratorId: r.orchestratorId, recordId: r.recordId, paneId: info.id });
      // The resumed TUI draws its history and loads MCP servers before it takes input: let it settle so the first
      // kora_prompt is typed into a live box, not a half-drawn one.
      if (this.host.ready) await this.host.ready(info.id).catch(() => undefined);
      return { paneId: info.id, resumed, rebriefed: !!rebrief };
    } finally { this.busy.delete(recordId); }
  }

  /** Asleep workers' unmerged branches older than the retention window are deleted (the record stays readable). */
  async retention(): Promise<number> {
    const days = branchRetentionDays(this.opts.home);
    if (days <= 0) return 0;
    const cutoff = this.now() - days * DAY;
    let n = 0;
    for (const r of this.list()) {
      if (r.status !== 'asleep' || !r.branchKept || !r.worktree || (r.sleptAt ?? 0) > cutoff) continue;
      const del = await this.git(r.worktree.mainRoot, ['branch', '-D', r.worktree.branch]);
      if (del.ok || /not found/i.test(del.out)) { r.branchKept = false; this.save(r); n++; this.host.log(`worker ${r.recordId}: branch ${r.worktree.branch} deleted (asleep > ${days} days)`); }
    }
    return n;
  }
}

/** A readable transcript from a CLI session log (Claude Code / Codex JSONL): who said what, and the tools it ran. */
export interface TranscriptEntry { role: 'user' | 'assistant' | 'tool'; text: string; at?: string }
export function readTranscript(file: string | null, max = 400): TranscriptEntry[] {
  if (!file) return [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: TranscriptEntry[] = [];
  const text = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c)
    ? c.map((x: any) => x?.text ?? (x?.type === 'tool_use' ? '' : '')).filter(Boolean).join('\n') : '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    // Claude Code: {type:'user'|'assistant', message:{content}}
    if ((d.type === 'user' || d.type === 'assistant') && d.message) {
      const c = d.message.content;
      if (Array.isArray(c)) {
        for (const x of c) {
          if (x?.type === 'text' && x.text?.trim()) out.push({ role: d.type, text: x.text, at: d.timestamp });
          else if (x?.type === 'tool_use') out.push({ role: 'tool', text: `${x.name} ${JSON.stringify(x.input ?? {}).slice(0, 300)}`, at: d.timestamp });
        }
      } else if (typeof c === 'string' && c.trim() && !c.startsWith('<')) out.push({ role: d.type, text: c, at: d.timestamp });
      continue;
    }
    // Codex: {type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}
    const p = d.payload;
    if (d.type === 'response_item' && p?.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const t = text(p.content).trim();
      if (t && !t.startsWith('<')) out.push({ role: p.role, text: t, at: d.timestamp });
    } else if (d.type === 'response_item' && (p?.type === 'function_call' || p?.type === 'custom_tool_call' || p?.type === 'local_shell_call')) {
      out.push({ role: 'tool', text: `${p.name ?? p.type} ${String(p.arguments ?? p.input ?? JSON.stringify(p.action ?? '')).slice(0, 300)}`, at: d.timestamp });
    }
  }
  return out.slice(-max);
}
