import type { LedgerSummary } from '../ledger/transcript';
// One pane = one pty + one headless xterm mirror + agent state detection.
import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { AgentId, AgentState, Cell, PaneInfo, PaneGraphInfo, ScreenSnapshot, SwarmWorkerMeta } from '../protocol/types';
import { StateTracker, DetectionSnapshot, agentFromTitle, isKnownAgent } from '../detect';
import { log } from './log';
import { PROMPT_LINE, promptLineWithoutGhost } from './ghost-text';
import { sandboxedEngineFor, withBrowserGuard, wrapReadDeny } from '../session/os-sandbox';
import { killTreeWindows, winCommand } from '../util/win-exec';

export const DETECTION_LINES = 40;
const DETECT_DEBOUNCE_MS = 120;
// Coalesce PTY output into ~one frame per animation frame before emitting to clients. A redraw-heavy TUI (Claude
// Code) emits hundreds of tiny writes per second; one socket frame + one renderer term.write per chunk is what
// makes it lag in the GUI vs a native terminal reading the PTY directly. 8ms batching is imperceptible and collapses
// a burst into a single frame. The headless term + detection still see every chunk immediately (order preserved).
const OUTPUT_COALESCE_MS = 8;

export interface PaneOptions {
  id: string; workspaceId: string; name: string; command: string; args: string[]; cwd: string;
  agent: AgentId; env: Record<string, string>; cols: number; rows: number; agentSessionId?: string | null;
  userArgs?: string[];             // args as given, before the enforcer's additions (restart/persist reuse these)
}

export class Pane extends EventEmitter {
  readonly id: string; workspaceId: string; name: string;
  readonly command: string; readonly args: string[]; readonly cwd: string; readonly userArgs: string[];
  agent: AgentId;                  // declared (spawn param / argv) or detected from foreground process
  readonly declaredAgent: AgentId;
  pid: number | null = null;
  exited = false; exitCode: number | null = null;
  readonly createdAt = Date.now(); lastOutputAt = Date.now();
  cols: number; rows: number;
  title = ''; oscProgress = '';
  /** The task a lead spawned this worker with (the box's first bubble). */
  initialTask: string | null = null;
  agentSessionId: string | null; agentSessionPath: string | null = null;
  ledger: LedgerSummary | null = null;
  worktree: PaneInfo['worktree'] = null;
  launched = false;
  sizeOwnerConnId: string | null = null; // set by pane.focus; gates pane.resize (multi-frontend size ownership)
  // runtime intelligence (owned by the Runtime; carried on PaneInfo)
  budgetUsd: number | null = null; budgetState: PaneInfo['budgetState'] = null;
  budgetOverSent = false; budgetOverPending = false; budgetWarned = false;
  lastCompactAt: number | null = null;
  autoNamed = false;                        // pane.name came from ledger.firstPrompt (a user rename clears this)
  lastAutoAnswer: { blocker: string | null; at: number } | null = null;
  liveCwd: string | null = null;            // the process's current directory (foreground watcher), null until known
  // ---- orchestration (fleet) ----
  role: PaneInfo['role'] = null;            // 'orchestrator' (promoted) | 'worker' (spawned by one) | null
  account: string | null = null;           // credential profile the agent runs under
  orchestratorId: string | null = null;    // the orchestrator pane that owns this worker
  steeredAt: number | null = null;         // epoch ms of the last unsolicited human steer
  errorStall: PaneInfo['errorStall'] = null; // stopped on a transient API error (server/error-stall.ts)
  errorRetries = 0;                         // "continue"s kora sent this worker after such errors (capped)
  humanInputBuf = '';                       // accumulates human keystrokes to detect a submitted steer line (transient)
  steerQueue: string[] = [];                // orchestrator: steer notes waiting for the next idle turn
  // ---- swarm ----
  /** Set by SwarmService on a swarm worker (agent 'opencode'); null otherwise. Serialized on PaneInfo.swarm. */
  swarm: SwarmWorkerMeta | null = null;
  /** Kora is closing this worker to put it to sleep (server/worker-sleep.ts): its exit is not "the worker exited". */
  sleeping = false;
  /** Kora closed this swarm worker after its branch was merged (its job is over; an idle OpenCode holds ~800 MB). */
  retired = false;
  /** Its worktree branch has landed in the main checkout (kora_merge, or a merge by hand the status poll saw). */
  branchMerged = false;
  /** The human stopped this worker (fleet.kill): its exit is their decision, not "finished". */
  stoppedByUser = false;
  /** The worker box's feed (server/worker-feed.ts): a DriverPane always has one; a swarm/Koragent worker once its
   *  agent reports steps. Null = terminal only. */
  feed: import('./worker-feed').WorkerFeed | null = null;
  ensureFeed(): import('./worker-feed').WorkerFeed {
    if (!this.feed) { const { WorkerFeed } = require('./worker-feed') as typeof import('./worker-feed'); this.feed = new WorkerFeed(); this.feed.on('item', (i) => this.emit('feed', i)); }
    return this.feed;
  }
  graph: PaneGraphInfo = { repoRoot: null, indexed: false, nodes: 0, edges: 0, lastIngestAt: null, enforced: false, toolCalls: 0 };
  cursorVisible = true;
  private term: Terminal; private serializer: SerializeAddon;
  private pty: IPty | null = null;
  private env: Record<string, string>;
  /** One variable of the environment the pane's process was started with (e.g. CLAUDE_CONFIG_DIR). */
  envVar(name: string): string | undefined { return this.env[name]; }
  protected tracker = new StateTracker();
  /** Serialises Runtime.prompt() per pane: two concurrent prompts (an auto-compact and a budget notice landed on
   *  ONE line, submitted as a single garbled instruction) must queue, never interleave keystrokes. */
  promptLock: Promise<unknown> = Promise.resolve();
  /** True from spawn until the initial prompt has been typed and submitted: the agent's start-up "idle" (banner up,
   *  prompt not yet delivered) must not satisfy a wait — an orchestrator read "both idle already" 2 s after spawning.
   *  A swarm worker's prompt rides in argv (`--prompt`), so SwarmService holds this until its first working state
   *  (or the plugin's `busy`), capped at 60 s. */
  promptPending = false;
  // ---- event-driven agents (Koragent) ----
  /** True for a pane whose agent reports its own state on an event stream (Koragent): its screen is never scraped for
   *  state (runDetect is a no-op) and `hint()` is authoritative, including `blocked`. */
  eventDriven = false;
  /** `~/.kora/panes/<id>.sock` — the event stream the agent listens on (set at spawn for eventDriven panes). */
  eventSocketPath: string | null = null;
  /** Set while the event stream is attached: text for this pane goes to the agent as a `steer` message, not keystrokes
   *  (Runtime.prompt). Human typing (humanWrite) always stays PTY input. */
  steerSink: ((text: string, source: 'human' | 'leader' | 'kora', delivery: 'steer' | 'queue') => Promise<void>) | null = null;
  private detectTimer: NodeJS.Timeout | null = null;
  private osc: { active: boolean; buf: string; esc: boolean } = { active: false, buf: '', esc: false };

  constructor(o: PaneOptions) {
    super();
    this.id = o.id; this.workspaceId = o.workspaceId; this.name = o.name; this.command = o.command; this.args = o.args; this.cwd = o.cwd; this.userArgs = o.userArgs ?? o.args;
    this.agent = o.agent; this.declaredAgent = o.agent; this.env = o.env; this.cols = o.cols; this.rows = o.rows; this.agentSessionId = o.agentSessionId ?? null;
    this.term = new Terminal({ cols: o.cols, rows: o.rows, scrollback: 5000, allowProposedApi: true });
    this.serializer = new SerializeAddon(); this.term.loadAddon(this.serializer);
  }

  get state(): AgentState { return this.tracker.state; }
  get blocker(): string | null { return this.tracker.blocker; }
  get altScreen(): boolean { return this.term.buffer.active.type === 'alternate'; }

  spawn(): void {
    const pty: typeof import('node-pty') = require('node-pty');
    ensureSpawnHelperExecutable();
    try {
      // Worker panes of engines without tool hooks run under the OS read-deny for credential paths (session/os-sandbox.ts).
      const eng = sandboxedEngineFor(this.declaredAgent);
      const w = eng ? wrapReadDeny(eng, this.command, this.args) : winCommand(this.command, this.args);
      const env = eng === 'antigravity' || eng === 'gemini' ? withBrowserGuard(this.env) : this.env;
      // node-pty on Windows takes a pre-built command line as a string (cmd.exe's own quoting, util/win-exec.ts).
      this.pty = pty.spawn(w.command, w.windowsVerbatimArguments ? w.args.join(' ') : w.args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env });
    } catch (e: any) {
      log(`pane ${this.id}: spawn failed: ${e?.message || e}`);
      this.exited = true; this.exitCode = 127;
      this.term.write(`kora: failed to spawn ${this.command}: ${e?.message || e}\r\n`);
      setImmediate(() => this.emit('exit', 127));
      return;
    }
    this.pid = this.pty.pid;
    this.pty.onData((d) => this.onOutput(d));
    this.pty.onExit(({ exitCode }) => {
      this.exited = true; this.exitCode = exitCode; this.pid = null;
      if (this.detectTimer) { clearTimeout(this.detectTimer); this.detectTimer = null; }
      this.flushOutput(); // deliver any buffered output before the exit notice / exit event
      this.term.write(`\r\n[process exited with code ${exitCode}]\r\n`);
      const prev = this.tracker.state; const r = this.tracker.update(this.detectionSnapshot(), this.agent, Date.now(), this.lastOutputAt, true);
      if (r.changed) this.emit('state', r.state, r.blocker, prev);
      this.emit('exit', exitCode);
    });
  }

  /** Text kora itself shows in the pane (progress bar, notices) — into the screen and out to clients, no pty. */
  writeLocal(data: string) { this.mirrorChars += data.length; this.term.write(data); this.lastOutputAt = Date.now(); this.queueOutput(data); }
  private onOutput(data: string) {
    this.lastOutputAt = Date.now();
    this.scanControl(data);
    this.mirrorChars += data.length;
    this.term.write(data);
    this.queueOutput(data);
    this.scheduleDetect(DETECT_DEBOUNCE_MS);
  }
  // ── output coalescing: buffer chunks, emit one 'output' per frame (see OUTPUT_COALESCE_MS) ──
  private outBuf = '';
  private outTimer: ReturnType<typeof setTimeout> | null = null;
  /** UTF-16 units handed to the screen mirror / to output listeners; both count the same stream. */
  private mirrorChars = 0;
  private emittedChars = 0;
  private queueOutput(data: string) {
    this.outBuf += data;
    if (!this.outTimer) this.outTimer = setTimeout(() => this.flushOutput(), OUTPUT_COALESCE_MS);
  }
  /** Emit whatever output has accumulated as a single frame. Called on the coalesce timer and before exit. */
  flushOutput() {
    if (this.outTimer) { clearTimeout(this.outTimer); this.outTimer = null; }
    if (!this.outBuf) return;
    const d = this.outBuf; this.outBuf = '';
    this.emittedChars += d.length;
    this.emit('output', d, this.emittedChars);
  }

  /**
   * Serializes the screen mirror at a point that is exact in stream offsets. The mirror parses asynchronously, so a
   * plain `read()` can lag output that listeners already received (lost) or lead output still buffered (duplicated);
   * `at` is the number of stream chars the returned history contains.
   */
  snapshotAt(lines: number): Promise<{ history: string; at: number; cols: number; rows: number }> {
    const at = this.mirrorChars;
    return new Promise((resolve) => {
      this.term.write('', () => {
        let history = '';
        try { history = this.read('scrollback', 'ansi', lines); } catch { history = ''; }
        resolve({ history, at, cols: this.cols, rows: this.rows });
      });
    });
  }

  /** Track OSC 0/2 titles, OSC 9;4 progress and DECTCEM cursor visibility from the raw stream. */
  private scanControl(data: string) {
    let i = 0; const n = data.length;
    while (i < n) {
      if (this.osc.active) {
        const ch = data[i];
        if (ch === '\x07') { this.finishOsc(); i++; continue; }
        if (this.osc.esc) { this.osc.esc = false; if (ch === '\\') { this.finishOsc(); i++; continue; } this.osc.buf += '\x1b' + ch; i++; continue; }
        if (ch === '\x1b') { this.osc.esc = true; i++; continue; }
        if (this.osc.buf.length < 4096) this.osc.buf += ch; else this.osc.active = false;
        i++; continue;
      }
      const esc = data.indexOf('\x1b', i);
      if (esc < 0) break;
      const next = data[esc + 1];
      if (next === ']') { this.osc = { active: true, buf: '', esc: false }; i = esc + 2; continue; }
      if (next === '[' && data.startsWith('?25', esc + 2)) { const m = data[esc + 5]; if (m === 'l') this.cursorVisible = false; else if (m === 'h') this.cursorVisible = true; }
      i = esc + 1;
    }
  }
  private finishOsc() {
    const s = this.osc.buf; this.osc.active = false; this.osc.buf = '';
    const semi = s.indexOf(';'); if (semi < 0) return;
    const code = s.slice(0, semi), payload = s.slice(semi + 1);
    if (code === '0' || code === '2') {
      if (payload !== this.title) { this.title = payload; this.emit('title', payload); }
    } else if (code === '9' && payload.startsWith('4;')) {
      this.oscProgress = payload; // "4;<state>;<progress>"
    }
  }

  scheduleDetect(ms: number) {
    if (this.exited) return;
    if (this.detectTimer) clearTimeout(this.detectTimer);
    this.detectTimer = setTimeout(() => { this.detectTimer = null; this.runDetect(); }, ms);
  }
  runDetect() {
    if (this.exited || this.eventDriven) return;
    const prev = this.tracker.state;
    let r;
    try { r = this.tracker.update(this.detectionSnapshot(), this.agent, Date.now(), this.lastOutputAt); }
    catch (e) { log(`pane ${this.id}: detect error`, e); return; }
    if (r.changed) this.emit('state', r.state, r.blocker, prev);
    if (r.recheckInMs != null && r.recheckInMs > 0) this.scheduleDetect(Math.min(r.recheckInMs, 30_000));
  }
  resetDetection() { this.tracker.reset(); this.scheduleDetect(10); }
  /** The agent reported its own turn state through a hook (see StateTracker): fold it in right away. */
  hint(state: 'working' | 'idle' | 'blocked', blocker: string | null = null) {
    if (this.exited) return;
    this.hintedAt = Date.now();
    // An event-driven agent's own state IS the state: no screen rule, confirmation delay or TTL applies.
    if (this.eventDriven) {
      const prev = this.tracker.state;
      const r = this.tracker.force(state, state === 'blocked' ? blocker : null);
      if (r.changed) this.emit('state', r.state, r.blocker, prev);
      return;
    }
    if (state === 'blocked') return; // only the screen can raise blocked for a scraped agent
    this.tracker.hint(state, this.hintedAt); this.scheduleDetect(0);
  }
  /** When the agent last reported its own turn state through a hook (0 = never). A `working` hint after a prompt
   *  was typed is the one proof the prompt was ACCEPTED — the screen can look busy from our own echo. */
  hintedAt = 0;
  get hinted(): 'working' | 'idle' | null { return this.tracker.hinted; }

  /** Called by the foreground-process watcher; returns true if the identity changed. */
  setDetectedAgent(agent: AgentId | null): boolean {
    const next: AgentId = agent ?? (isKnownAgent(this.declaredAgent) ? this.declaredAgent : this.declaredAgent);
    if (next === this.agent) return false;
    log(`pane ${this.id}: agent ${this.agent} → ${next}`);
    this.agent = next; this.resetDetection();
    return true;
  }
  titleAgentHint(): AgentId | null { return this.title ? agentFromTitle(this.title) : null; }

  // ---- terminal access ----
  private bufferLines(count: number, trimRight = true): string[] {
    const b = this.term.buffer.active; const out: string[] = [];
    const end = b.length; const start = Math.max(0, end - count);
    for (let i = start; i < end; i++) { const l = b.getLine(i); out.push(l ? l.translateToString(trimRight) : ''); }
    return out;
  }
  private viewportLines(trimRight = true): string[] {
    const b = this.term.buffer.active; const out: string[] = [];
    for (let i = 0; i < this.term.rows; i++) { const l = b.getLine(b.viewportY + i); out.push(l ? l.translateToString(trimRight) : ''); }
    return out;
  }
  /** Bottom ~40 non-empty lines of the active buffer (blank lines between them kept). */
  detectionText(): string {
    const b = this.term.buffer.active; const lines: string[] = []; let nonEmpty = 0;
    for (let i = b.length - 1; i >= 0 && nonEmpty < DETECTION_LINES; i--) {
      const l = b.getLine(i); const s = l ? l.translateToString(true) : '';
      if (s.trim()) nonEmpty++; else if (nonEmpty === 0) continue;
      lines.push(s);
    }
    return lines.reverse().join('\n');
  }
  detectionSnapshot(): DetectionSnapshot { return { screen: this.detectionText(), oscTitle: this.title, oscProgress: this.oscProgress }; }

  read(source: 'screen' | 'detection' | 'scrollback' = 'screen', format: 'text' | 'ansi' = 'text', lines?: number): string {
    if (format === 'ansi') {
      // SerializeAddon emits the viewport plus `scrollback` lines above it, ending with cursor position + modes.
      const scrollback = source === 'screen' ? 0 : Math.max(0, (lines ?? (source === 'detection' ? DETECTION_LINES : 200)) - this.term.rows);
      return this.serializer.serialize({ scrollback });
    }
    if (source === 'detection') return this.detectionText();
    if (source === 'scrollback') return this.bufferLines(lines ?? 200).join('\n');
    const v = this.viewportLines().map((l, y) => (PROMPT_LINE.test(l) ? promptLineWithoutGhost(this.rowCells(y)) ?? l : l));
    return (lines ? v.slice(-lines) : v).join('\n');
  }
  /** One viewport row as cells (what snapshot() sends), for attribute-aware reads such as dropping ghost text. */
  private rowCells(y: number): Cell[] {
    const b = this.term.buffer.active; const line = b.getLine(b.viewportY + y); const cell = b.getNullCell(); const row: Cell[] = [];
    for (let x = 0; x < this.term.cols; x++) {
      const c = line?.getCell(x, cell); if (!c) { row.push({ ch: ' ', fg: -1, bg: -1, attrs: 0 }); continue; }
      const w = c.getWidth(); if (w === 0) continue; // trailing half of a wide char
      const attrs = (c.isBold() ? 1 : 0) | (c.isItalic() ? 2 : 0) | (c.isUnderline() ? 4 : 0) | (c.isInverse() ? 8 : 0) | (c.isDim() ? 16 : 0);
      const out: Cell = { ch: c.getChars() || ' ', fg: packColor(c.getFgColorMode(), c.getFgColor()), bg: packColor(c.getBgColorMode(), c.getBgColor()), attrs };
      if (w === 2) out.wide = true;
      row.push(out);
    }
    return row;
  }

  snapshot(): ScreenSnapshot {
    const b = this.term.buffer.active; const rows: Cell[][] = [];
    for (let y = 0; y < this.term.rows; y++) rows.push(this.rowCells(y));
    return { paneId: this.id, cols: this.term.cols, rows: this.term.rows, cursorX: b.cursorX, cursorY: b.cursorY, cursorVisible: this.cursorVisible, lines: rows, altScreen: this.altScreen };
  }

  write(data: string | Buffer) { if (this.pty && !this.exited) this.pty.write(typeof data === 'string' ? data : data.toString('utf8')); }
  resize(cols: number, rows: number) {
    cols = Math.max(2, Math.min(500, cols | 0)); rows = Math.max(1, Math.min(300, rows | 0));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols; this.rows = rows;
    try { this.term.resize(cols, rows); } catch (e) { log(`pane ${this.id}: term resize`, e); }
    try { this.pty?.resize(cols, rows); } catch (e) { log(`pane ${this.id}: pty resize`, e); }
    this.emit('resize', cols, rows);
    this.scheduleDetect(DETECT_DEBOUNCE_MS);
  }
  kill(signal = 'SIGTERM') {
    // Windows' node-pty takes no signal: it queues the call until the terminal is up, then THROWS on a signal outside any
    // try (an uncaught exception in the daemon). It ends the process tree itself.
    if (this.pty && !this.exited) { try { if (process.platform === 'win32') this.pty.kill(); else this.pty.kill(signal as any); } catch (e) { log(`pane ${this.id}: kill`, e); } }
  }
  dispose() {
    if (this.detectTimer) clearTimeout(this.detectTimer); if (this.outTimer) clearTimeout(this.outTimer);
    // The whole process group while its leader is still ours: an agent's helpers (LSP servers, MCP children, a shell
    // job) otherwise outlive the pane. Never after exit — the pid (and so the group id) may already be recycled.
    if (this.pty && !this.exited && this.pid) { if (process.platform === 'win32') killTreeWindows(this.pid); else try { process.kill(-this.pid, 'SIGKILL'); } catch { /* not a group leader */ } }
    this.kill('SIGKILL');
    try { this.term.dispose(); } catch { /* ignore */ }
  }

  info(): PaneInfo {
    return {
      id: this.id, workspaceId: this.workspaceId, name: this.name, command: this.command, args: this.args, cwd: this.cwd, pid: this.pid,
      agent: this.agent, state: this.state, blocker: this.blocker, exited: this.exited, exitCode: this.exitCode, createdAt: this.createdAt, lastOutputAt: this.lastOutputAt,
      cols: this.cols, rows: this.rows, title: this.title, agentSessionId: this.agentSessionId, graph: { ...this.graph }, ledger: this.ledger, worktree: this.worktree, launched: this.launched,
      budgetUsd: this.budgetUsd, budgetState: this.budgetUsd ? this.budgetState ?? 'ok' : null, lastCompactAt: this.lastCompactAt,
      liveCwd: this.liveCwd,
      sizeOwnerConnId: this.sizeOwnerConnId,
      role: this.role, account: this.account, orchestratorId: this.orchestratorId, steeredAt: this.steeredAt,
      errorStall: this.errorStall ? { ...this.errorStall } : null,
      swarm: this.swarm,
      ...(this.feed ? { surface: 'gui' as const } : {}),
    };
  }
}

// npm sometimes drops the exec bit on node-pty's prebuilt spawn-helper → "posix_spawnp failed". Fix it once.
let helperChecked = false;
function ensureSpawnHelperExecutable() {
  if (helperChecked) return; helperChecked = true;
  try {
    const fs = require('node:fs') as typeof import('node:fs'); const path = require('node:path') as typeof import('node:path');
    const dir = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`);
    for (const f of ['spawn-helper']) {
      const p = path.join(dir, f); if (!fs.existsSync(p)) continue;
      const mode = fs.statSync(p).mode; if (!(mode & 0o111)) { fs.chmodSync(p, mode | 0o755); log(`made ${p} executable`); }
    }
  } catch (e) { log('spawn-helper check failed', e); }
}

// xterm colour modes: 0 default, 0x1000000 p16, 0x2000000 p256, 0x3000000 rgb
function packColor(mode: number, color: number): number {
  if (mode === 0) return -1;
  if (mode === 0x3000000) return 0x1000000 | (color & 0xffffff);
  return color & 0xff;
}
