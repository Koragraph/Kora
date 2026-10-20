// Child-process ledger for crash recovery. A pane's agent (an OpenCode worker, a Claude/Codex pane) runs in its own
// pty session, and a daemon that is SIGKILLed or crashes never gets to dispose it: the pty's SIGHUP ends most agents,
// but a TUI that ignores it (or the helpers it started) keeps running with nobody to talk to — measured cost of one
// stranded OpenCode worker: ~300 MB RSS and a model session. Every live pane's process group is recorded here with
// its start time; the next daemon kills the groups whose leader is still the same process (pid + start time match,
// so a recycled pid is never touched).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { log } from './log';
import { killTreeWindows } from '../util/win-exec';
import { listWindowsProcesses } from '../util/win-procs';

export interface ChildRecord { pid: number; startedAt: string; what: string }

/** `ps -o lstart=` for a pid: its start time as ps prints it, or null when the pid is gone. */
export function processStart(pid: number): Promise<string | null> {
  // Windows has no ps: the start time from the CIM process query (same contract: null when the pid is gone).
  if (process.platform === 'win32') return windowsStarts([pid]).then((m) => m.get(pid) ?? null);
  return new Promise((resolve) => execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 3000, encoding: 'utf8' }, (err, out) => {
    const s = String(out || '').trim(); resolve(err || !s ? null : s);
  }));
}

/** Start times of several pids in ONE Windows process query (PowerShell costs ~0.5 s a start); gone pids are absent. */
export async function windowsStarts(pids: readonly number[], list: typeof listWindowsProcesses = listWindowsProcesses): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  if (!pids.length) return m;
  for (const p of (await list(pids)) ?? []) if (p.startedAt) m.set(p.pid, p.startedAt);
  return m;
}

export class ChildLedger {
  private rows = new Map<number, ChildRecord>();
  private timer: NodeJS.Timeout | null = null;
  constructor(readonly file: string) {}

  /** Record a live child (its start time is looked up asynchronously; never blocks the caller). */
  add(pid: number | null | undefined, what: string): void {
    if (!pid) return;
    processStart(pid).then((startedAt) => { if (startedAt) { this.rows.set(pid, { pid, startedAt, what }); this.save(); } }, () => {});
  }
  remove(pid: number | null | undefined): void { if (pid && this.rows.delete(pid)) this.save(); }
  list(): ChildRecord[] { return [...this.rows.values()]; }

  private save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 500); this.timer.unref();
  }
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ children: this.list() }));
      fs.renameSync(tmp, this.file);
    } catch (e) { log('children ledger not written', e); }
  }

  /**
   * At daemon start, before any pane spawns: kill the process groups the previous daemon left behind (SIGTERM, then
   * SIGKILL after `graceMs` for any that stayed). Only a pid whose start time still matches the record. Resets the file.
   */
  async reapOrphans(graceMs = 2000): Promise<ChildRecord[]> {
    let prev: ChildRecord[] = [];
    try { prev = (JSON.parse(fs.readFileSync(this.file, 'utf8')).children ?? []).filter((r: ChildRecord) => r && Number.isInteger(r.pid) && r.pid > 1 && typeof r.startedAt === 'string'); } catch { prev = []; }
    const reaped: ChildRecord[] = [];
    // Windows: every record's start time in one query instead of a PowerShell per pid. Elsewhere `ps` per pid, as before.
    const winStarts = process.platform === 'win32' ? await windowsStarts(prev.map((r) => r.pid)) : null;
    const startOf = async (pid: number) => (winStarts ? winStarts.get(pid) ?? null : processStart(pid));
    for (const r of prev) {
      if (r.pid === process.pid) continue;
      if ((await startOf(r.pid)) !== r.startedAt) continue; // gone, or the pid now belongs to someone else
      reaped.push(r);
      signalGroup(r.pid, 'SIGTERM');
    }
    if (reaped.length) {
      if (!winStarts) {   // Windows: signalGroup already ended each tree with taskkill /T /F; no second pass
        await new Promise((res) => setTimeout(res, graceMs));
        for (const r of reaped) if ((await processStart(r.pid)) === r.startedAt) signalGroup(r.pid, 'SIGKILL');
      }
      log(`reaped ${reaped.length} orphaned child process group(s) from the previous daemon: ${reaped.map((r) => `${r.what} (pid ${r.pid})`).join(', ')}`);
    }
    this.flush();
    return reaped;
  }
}

/** Signal a process group (a pty child leads its own session/group), falling back to the process alone. */
export function signalGroup(pid: number, sig: NodeJS.Signals): void {
  if (process.platform === 'win32') { killTreeWindows(pid); return; }   // no groups or SIGTERM there: end the tree
  try { process.kill(-pid, sig); return; } catch { /* not a group leader */ }
  try { process.kill(pid, sig); } catch { /* gone */ }
}

// ── chat-lane children ────────────────────────────────────────────────────────────────────────────────────────────────
// The chat drivers (ACP agents such as `gemini --acp`, Antigravity, Codex, OpenCode) spawn their CLI outside any pane, so
// the pane ledger above never saw them: a daemon that was SIGKILLed or crashed left a 24 h-old `gemini --acp` behind
// (aud1 S3-6). They register in the same ledger, so the next daemon start reaps them the same way.
let sharedLedger: ChildLedger | null = null;
export function setSharedChildLedger(l: ChildLedger | null): void { sharedLedger = l; }
/** Record a freshly spawned chat-lane child; it is dropped again when it exits. A no-op before a daemon owns a ledger. */
export function trackChild<T extends { pid?: number; once(event: 'exit', fn: () => void): unknown }>(child: T, what: string): T {
  const ledger = sharedLedger; const pid = child.pid;
  if (ledger && pid) { ledger.add(pid, what); child.once('exit', () => ledger.remove(pid)); }
  return child;
}
