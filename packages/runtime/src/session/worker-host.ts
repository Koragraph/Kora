// The SessionManager behind a DriverPane (server/driver-pane.ts): each GUI worker is a hidden chat thread
// (`workerPaneId` on its head — never listed, never in the sidebar) running on the same drivers as the chat.
import type { AgentId } from '../protocol/types';
import type { WorkerDriverHost } from '../server/driver-pane';
import type { SessionManager } from './session-manager';

/** Engines whose chat driver runs a worker headless. OpenCode stays a PTY swarm worker (its failover lives there). */
const NATIVE: ReadonlySet<string> = new Set(['claude', 'codex', 'antigravity']);

export function sessionWorkerHost(sm: SessionManager, opts: { isAcp?: (agent: AgentId) => boolean } = {}): WorkerDriverHost {
  return {
    supports: (agent) => NATIVE.has(agent) || !!opts.isAcp?.(agent),
    reportsToolStart: (agent) => { try { return sm.driverCapabilities(agent).reportsToolStart === true; } catch { return false; } },
    async start(p) {
      const meta = sm.createWorker({ paneId: p.paneId, agent: p.agent, cwd: p.cwd, account: p.account, title: p.title, runtimeMode: p.runtimeMode, ...(p.model ? { model: { model: p.model, ...(p.effort ? { effort: p.effort } : {}) } } : {}) });
      try { await sm.start(meta.id); }
      catch (e) { await sm.delete(meta.id).catch(() => {}); throw e; }
      return meta.id;
    },
    async send(threadId, text, origin) { await sm.sendTurn({ threadId, text, origin }); },
    async interrupt(threadId, turnId) { await sm.interrupt(threadId, turnId); },
    async respondApproval(threadId, requestId, decision) { await sm.respondApproval(threadId, requestId, decision); },
    async respondUserInput(threadId, requestId, answers) { await sm.respondUserInput(threadId, requestId, answers); },
    async dispose(threadId) { await sm.delete(threadId); },
    subscribe: (threadId, cb) => sm.subscribeThread(threadId, cb),
  };
}
