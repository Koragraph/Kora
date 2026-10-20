// Persisted server state: ~/.kora/state.json. Panes are re-spawned on restart (the original
// processes do not survive a server stop); agents with a reported session id are resumed.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentId } from '../protocol/types';
import { koraHome } from '../protocol/types';
import { log } from './log';

export interface PersistedPane { id: string; name: string; command: string; args: string[]; cwd: string; agent: AgentId; agentSessionId: string | null; cols: number; rows: number; worktree?: { path: string; branch: string; mainRoot: string } | null; budgetUsd?: number | null; agentSessionPath?: string | null;
  /** Fleet links (D18): a restored worker still belongs to its orchestrator; a promoted pane is still one. */
  role?: 'orchestrator' | 'worker' | null; orchestratorId?: string | null }
export interface PersistedWorkspace { id: string; name: string; cwd: string; activePaneId: string | null; panes: PersistedPane[] }
export interface PersistedState { version: 1; savedAt: number; activeWorkspaceId: string | null; workspaces: PersistedWorkspace[] }

export function statePath(): string { return path.join(koraHome(), 'state.json'); }
/**
 * One state file PER RUNTIME. Two runtimes share this home (the mux daemon on kora.sock and the desktop chat's
 * fleet runtime on chat-fleet.sock); both writing `state.json` meant each restart of one re-spawned the OTHER's
 * panes — a chat-daemon restart brought back 12 stale worker agents (real `claude --resume` processes) and the mux
 * workspace's own layout was overwritten. The default socket keeps the historical file name.
 */
export function stateFileFor(socketPath: string): string {
  const { defaultSocketPath } = require('../protocol/types') as typeof import('../protocol/types');
  if (!socketPath || socketPath === defaultSocketPath()) return statePath();
  const key = require('node:crypto').createHash('sha1').update(socketPath).digest('hex').slice(0, 10);
  return path.join(koraHome(), `state-${key}.json`);
}

export function loadState(file = statePath()): PersistedState | null {
  try {
    const raw = fs.readFileSync(file, 'utf8'); const s = JSON.parse(raw);
    if (s && s.version === 1 && Array.isArray(s.workspaces)) return s as PersistedState;
  } catch (e: any) { if (e?.code !== 'ENOENT') log('state: load failed', e); }
  return null;
}

let pending: NodeJS.Timeout | null = null; let latest: PersistedState | null = null; let latestFile = statePath();
export function saveState(s: PersistedState, immediate = false, file = statePath()): void {
  latest = s; latestFile = file;
  if (immediate) { flush(); return; }
  if (pending) return;
  pending = setTimeout(flush, 200);
}
export function flush(): void {
  if (pending) { clearTimeout(pending); pending = null; }
  if (!latest) return;
  try {
    // Owner-only: the home holds chat transcripts, the UI secret and logs; state.json names every pane's command line.
    fs.mkdirSync(koraHome(), { recursive: true, mode: 0o700 });
    const tmp = latestFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(latest, null, 2), { mode: 0o600 }); fs.renameSync(tmp, latestFile);
  } catch (e) { log('state: save failed', e); }
}
export function clearState(file = statePath()): void { try { fs.unlinkSync(file); } catch { /* ignore */ } }

/** Remove any resume/continue flags so a session is NOT resumed (cheap/fresh restarts, persistence of the user's own args). */
export function stripResume(agent: AgentId, args: string[]): string[] {
  if (agent === 'claude') return args.filter((a, i, arr) => !(a === '--resume' || a === '-r' || arr[i - 1] === '--resume' || arr[i - 1] === '-r' || a === '--continue' || a === '-c'));
  if (agent === 'codex') return args.filter((a, i, arr) => !(a === 'resume' || arr[i - 1] === 'resume'));
  // Koragent / OpenCode take their first message as `--prompt <text>`: a restored pane must come back idle, not re-run
  // it (found live: a restart re-sent a Koragent lead its whole job).
  if (agent === 'koragent' || agent === 'opencode') return args.filter((a, i, arr) => !(a === '--prompt' || arr[i - 1] === '--prompt' || a.startsWith('--prompt=')));
  return args;
}
/** Command line to use when restoring a pane: resume the agent session when we know it. */
export function restoreCommand(p: PersistedPane): { command: string; args: string[] } {
  if (p.agentSessionId) {
    if (p.agent === 'claude') return { command: p.command, args: ['--resume', p.agentSessionId, ...p.args.filter((a, i, arr) => !(a === '--resume' || a === '-r' || arr[i - 1] === '--resume' || arr[i - 1] === '-r' || a === '--continue' || a === '-c'))] };
    if (p.agent === 'codex') return { command: p.command, args: ['resume', p.agentSessionId, ...p.args.filter((a, i, arr) => !(a === 'resume' || arr[i - 1] === 'resume'))] };
  }
  return { command: p.command, args: p.args };
}
