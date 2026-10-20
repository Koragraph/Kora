// Embedded koragraph — the graph + memory layer as an in-process library.
// Implemented in src/graph/service.ts (workstream: graph+enforce). The server and CLI call ONLY this interface.
import type { AgentId, GraphTool, PaneGraphInfo } from '../protocol/types';

export interface GraphToolResult { text: string; data: unknown; ms: number }
export interface GraphService {
  /** Run one koragraph tool (never `remember`). cwd decides the repo scope. */
  callTool(name: GraphTool, args: Record<string, unknown>, opts: { cwd: string; fresh?: boolean }): Promise<GraphToolResult>;
  /** Graph status for the repo containing cwd. Cheap; safe to call on every pane spawn. */
  status(cwd: string, opts?: { nocache?: boolean }): Promise<PaneGraphInfo>;
  /** Index (or incrementally re-index) a repo. wait=false runs it detached. Refuses a home dir / fs root / shallow path
   *  (UnsafeIndexRootError) unless force. */
  ingest(path: string, opts?: { project?: string; wait?: boolean; full?: boolean; force?: boolean }): Promise<{ ok: true; nodes?: number; edges?: number }>;
  /** First index with a drawable progress signal (real per-file progress polled from the store, time estimate until the
   *  repository row appears; see service.ts). files = done so far, filesTotal once known. Used by the server's indexing gate. */
  ingestWithProgress?(path: string, onProgress: (p: { phase: string; pct: number; files: number; filesTotal?: number; elapsedMs: number; etaMs: number }) => void, opts?: { project?: string }): Promise<{ ok: boolean; nodes?: number; edges?: number; error?: string; ms: number }>;
  /** Session-start brief for an agent in cwd: laws, hazards, rituals, open loops, overview headline, and HOW to call the graph. */
  brief(cwd: string, agent?: AgentId): Promise<string>;
  /** Repo root (git toplevel or indexed full_path) for a cwd, or null. */
  repoRoot(cwd: string): string | null;
  /** Record a known root for cwd (skips the sync git lookup; see service.ts). */
  primeRepoRoot?(cwd: string, root: string): void;
  /** Fuzzy symbol candidates for a vague prompt (graph/fuzzy.ts). The worker-backed service answers from a worker thread so the
   *  symbol-index build (a scan of a repo's declaration names) never runs on the daemon's event loop. */
  fuzzy?(prompt: string, root: string, generation: string): Promise<unknown[]>;
  /** Bug-report localization for a plain-English bug prompt (graph/bug-localize.ts), off the event loop in the worker-backed service. */
  bugLocalize?(prompt: string, root: string, generation: string): Promise<unknown>;
}
export function createGraphService(): GraphService { return require('./service').createGraphService(); }
