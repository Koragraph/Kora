// The chat UI server, in-process. `kora server run` serves the unix socket (CLI, hooks, fleet workers, TUI) AND —
// when the UI bundle is installed — the desktop chat client's API on http://127.0.0.1:<uiPort> (`/ws` RPC + `/api/*`).
// Both faces drive the SAME Runtime and the SAME SessionManager (one ChatThreadStore writer, one pane table).
//
// The bundle (`ui/ui-server.cjs`) is the protocol layer the React client speaks (Effect RpcServer over a websocket,
// JSON framing; ChatEvent → ThreadEvent projection; fleet/terminal read models). Its source lives next to the
// client and its wire schema in this pnpm workspace (`packages/ui-server`, typed against `@kora/contracts`)
// and is built there with `vp pack` into this repo as ONE self-contained CommonJS file (Effect + contracts inlined),
// so kora itself builds with plain tsc and installs standalone: no bundle ⇒ no UI server, the socket is unaffected.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config';
import { log } from './log';
import { setDesktopClientProbe } from './desktop-clients';
import { koraHome } from '../protocol/types';
import { makeFleetOps } from './fleet-ops';
import { proxyPaneId } from '../session/drivers/claude-driver';
import { version } from '../../package.json';
import type { ServerHandle } from './daemon';
import type { HealthCheckId, HealthReport } from './health';

export interface UiServerHandle { port: number; close(): Promise<void>; /** Desktop windows connected (older bundles: absent). */ desktopClients?(): number }

/** What the bundle's `startUiServer` receives: the daemon's own objects, never copies. */
export interface UiHost {
  runtime: ServerHandle['runtime'];
  sessions: ServerHandle['sessions'];
  managerRuntime: ServerHandle['managerRuntime'];
  makeFleetOps: typeof makeFleetOps;
  proxyPaneId: typeof proxyPaneId;
  /** The Claude model catalog from the SDK (session/list-models.ts), or null — the UI keeps its static list. */
  listClaudeModels: (timeoutMs?: number) => Promise<unknown[] | null>;
  /** The account's plan windows for Settings → Usage, read through the provider's own CLI (session/plan-usage.ts). */
  readUsageLimits: (provider: 'claude' | 'codex') => Promise<import('../session/events').UsageLimitsReport | null>;
  version: string;
  log: (...parts: unknown[]) => void;
  /** Swarm setup (the ui-server's `KoraSwarmLike`): `runtime.swarmSetup`. */
  swarm: ServerHandle['runtime']['swarmSetup'];
  /** Health checks + the redacted diagnostics bundle (Settings → Diagnostics; the ui-server's `KoraDoctorLike`). */
  doctor: UiDoctor;
  /** "Kora saved you" in the context popover (ledger/savings.ts). */
  savings: (threadId: string | null) => unknown;
  /** "Log in to Claude" (claude-login.ts): runs `claude auth login` (CLI or Kora's bundled copy) for the app. */
  claudeLogin: import('./claude-login').ClaudeLogin;
  /** Phase 7 engines (server/engines.ts): the ui-server's Settings > Engines, routing and provider list. */
  engines: import('./engines').Engines;
  /** The Blobs runtime (blobs/runtime.ts); the ui-server sees it through `KoraBlobsLike` (host.ts). */
  blobs: import('../blobs/runtime').BlobRuntimeImpl;
  /** The Kora surface switch (edition.ts): 'coming-soon' gates every blob RPC and the boot-time blob wiring. */
  koraSurface: () => 'coming-soon' | 'on';
  /** Folder trust (trust/store.ts): the ui-server's `trust.*` RPCs. */ trust: import('../trust/store').TrustHostApi;
  /** Extensions (extensions/host.ts): the ui-server's `extensions.*` RPCs. */ extensions: import('../extensions/host').ExtensionsHostApi;
  /** "Remove project": take Kora's managed blocks/hooks and the folder trust out of the repo (enforce/repo-footprint.ts). */ removeRepoFootprint: (cwd: string) => Promise<{ root: string; removed: string[]; trustRevoked: boolean }>;
  /** The graph store opened with the daemon's own better-sqlite3 (the graph workers' SQLite copy), read-only by pragma. */
  openGraphDb: (file: string) => unknown;
}

/** One SQLite copy per process on graph.db: two copies unlink each other's -wal/-shm and freeze the reader (pl3 S1-1). */
export function openGraphDbReadOnly(file: string): unknown {
  const Database = require('better-sqlite3');
  const db = new Database(file, { timeout: 4000 });
  try { db.pragma('query_only = ON'); } catch { /* best effort */ }
  return db;
}

export interface UiDoctor {
  run(opts: { cwd?: string | null; only?: HealthCheckId[]; probe?: boolean }): Promise<HealthReport>;
  exportBundle(opts: { cwd?: string | null; dir?: string | null }): Promise<{ path: string; bytes: number }>;
}

/** The in-daemon doctor: the daemon row describes this process; Swarm uses the live setup (and re-tests providers). */
export function makeUiDoctor(handle: ServerHandle): UiDoctor {
  const deps = (probe: boolean) => {
    return {
      version,
      inDaemon: true,
      uiPort: loadConfig().uiPort,
      daemon: async () => ({ running: true, version, pid: process.pid, uptimeMs: Date.now() - handle.runtime.startedAt }),
      graphStatus: (cwd: string) => handle.runtime.graph.status(cwd),
      swarmStatus: async () => {
        const setup = handle.runtime.swarmSetup;
        if (probe) {
          const before = await setup.getStatus();
          await Promise.allSettled(before.providers.filter((p) => p.enabled && (p.provider === 'zen' || p.hasKey)).map((p) => setup.testProvider({ provider: p.provider })));
        }
        return setup.getStatus();
      },
    };
  };
  return {
    run: (opts) => {
      const { runHealthChecks } = require('./health') as typeof import('./health');
      return runHealthChecks({ cwd: opts.cwd ?? null, ...(opts.only ? { only: opts.only } : {}) }, deps(opts.probe !== false));
    },
    exportBundle: async (opts) => {
      const { runHealthChecks } = require('./health') as typeof import('./health');
      const { writeDiagnosticsBundle } = require('./diagnostics-bundle') as typeof import('./diagnostics-bundle');
      const report = await runHealthChecks({ cwd: opts.cwd ?? null }, deps(false));
      return writeDiagnosticsBundle({ report, config: loadConfig(), dir: opts.dir ?? null });
    },
  };
}

/** The daemon's one login runner: the `claude` CLI when installed, else the copy bundled with the Agent SDK. */
export function makeDaemonClaudeLogin(): import('./claude-login').ClaudeLogin {
  const { makeClaudeLogin } = require('./claude-login') as typeof import('./claude-login');
  const { findOnSearchPath, findBundledClaude } = require('./health') as typeof import('./health');
  return makeClaudeLogin({
    resolveBinary: async () => {
      const cli = await findOnSearchPath('claude');
      if (cli) return { bin: cli, via: 'cli' };
      const bundled = findBundledClaude();
      return bundled ? { bin: bundled, via: 'bundled' } : null;
    },
  });
}

/** `KORA_UI_BUNDLE` overrides (a dev build of the client protocol layer); default: the installed `ui/ui-server.cjs`. */
export function uiBundlePath(): string {
  return process.env.KORA_UI_BUNDLE || path.resolve(__dirname, '..', '..', 'ui', 'ui-server.cjs');
}

function claudeModels(timeoutMs?: number): Promise<unknown[] | null> {
  try { return require('../session/list-models').listClaudeModels(timeoutMs); } catch { return Promise.resolve(null); }
}

function usageLimitsReader(handle: ServerHandle): UiHost['readUsageLimits'] {
  return async (provider) => {
    const probes = require('../session/plan-usage') as typeof import('../session/plan-usage');
    if (provider === 'codex') return probes.probeCodexPlanUsage();
    // A running chat session answers without starting a process; otherwise a short idle probe.
    const live = await handle.sessions.readLivePlanUsage().catch(() => null);
    return live ?? probes.probeClaudePlanUsage();
  };
}

export async function startUiServer(handle: ServerHandle, opts: { port?: number; bundle?: string } = {}): Promise<UiServerHandle | null> {
  const port = opts.port ?? loadConfig().uiPort;
  if (!port) { log('ui: off (uiPort = 0)'); return null; }
  const file = opts.bundle ?? uiBundlePath();
  if (!fs.existsSync(file)) { log(`ui: no bundle at ${file} — chat UI server not started (the socket is unaffected)`); return null; }
  const mod = require(file) as { startUiServer?: (host: UiHost, o: { host: string; port: number; koraHome: string }) => Promise<UiServerHandle> };
  if (typeof mod.startUiServer !== 'function') { log(`ui: ${file} does not export startUiServer`); return null; }
  const host: UiHost = {
    runtime: handle.runtime, sessions: handle.sessions, managerRuntime: handle.managerRuntime,
    makeFleetOps, proxyPaneId, listClaudeModels: claudeModels, readUsageLimits: usageLimitsReader(handle), version, log,
    swarm: handle.runtime.swarmSetup,
    blobs: handle.blobs,
    koraSurface: () => (require('../edition') as typeof import('../edition')).koraSurface(),
    engines: handle.managerRuntime.engines as import('./engines').Engines,
    doctor: makeUiDoctor(handle),
    savings: (threadId) => (require('../ledger/savings') as typeof import('../ledger/savings')).savingsReport({ threadId }),
    claudeLogin: makeDaemonClaudeLogin(),
    trust: (require('../trust/store') as typeof import('../trust/store')).trustHostApi,
    extensions: (require('../extensions/host') as typeof import('../extensions/host')).extensionsHostApi,
    removeRepoFootprint: (cwd) => (require('../enforce/repo-footprint') as typeof import('../enforce/repo-footprint')).removeRepoFootprint(cwd),
    openGraphDb: openGraphDbReadOnly,
  };
  // The bundle requires a per-home secret (`<koraHome>/ui-token`, 0600) on /ws and /api/*, and refuses foreign
  // Origin/Host headers: loopback alone is not a boundary (any web page can dial it). The desktop reads the file.
  const ui = await mod.startUiServer(host, { host: '127.0.0.1', port, koraHome: koraHome() });
  if (typeof ui.desktopClients === 'function') setDesktopClientProbe(() => ui.desktopClients!());
  log(`ui: chat UI server on http://127.0.0.1:${ui.port} (ws://127.0.0.1:${ui.port}/ws) from ${file}`);
  return ui;
}
