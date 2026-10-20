// Programmatic entry: run a server in-process or talk to one.
export { createServer, runForeground, startDetached, ensureServer, isSocketAlive } from './server/daemon';
export type { ServerHandle } from './server/daemon';
export { startUiServer, uiBundlePath } from './server/ui';
export type { UiHost, UiServerHandle } from './server/ui';
export { Runtime } from './server/workspace';
export { makeFleetOps, toWorkerInfo } from './server/fleet-ops';
export type { FleetOps, WorkerInfo } from './server/fleet-ops';
export { proxyPaneId } from './session/drivers/claude-driver';
// Chat (structured) lane surface. The daemon owns the one SessionManager; the chat UI server runs inside it
// (server/ui.ts) and receives these objects directly — nothing loads this entry to build a second runtime.
export { SessionManager } from './session/session-manager';
export { listClaudeModels } from './session/list-models';
export type { ClaudeModelInfo } from './session/list-models';
export type { ManagerRuntime } from './session/session-manager';
export { ChatThreadStore } from './session/store';
export type { ThreadMeta } from './session/store';
export type { ChatEvent, ChatThreadInfo, ThreadId, ModelChoice, ApprovalAnswer } from './session/events';
export { KoraClient, callOnce } from './protocol/client';
export * from './protocol/types';
export { detect, loadManifests, StateTracker, agentFromArgv } from './detect';
