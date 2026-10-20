// Enforcement — make a coding agent actually use the graph. Per-agent adapters (claude hooks, codex config,
// AGENTS.md managed blocks, MCP config injection, PATH shims). Implemented in src/enforce/*.ts (workstream: graph+enforce).
// The server calls prepare() on every pane.spawn; the CLI calls install/uninstall/status/doctor.
import type { AgentId } from '../protocol/types';

export interface PrepareInput { agent: AgentId; cwd: string; paneId: string; socketPath: string; binPath: string; command: string; args: string[]; env: Record<string, string>; /** Write no CLAUDE.md/AGENTS.md block or hook file into the repo (an untrusted folder in the chat lane) */ noRepoWrites?: boolean }
export interface EnforcePlan {
  command: string;                 // possibly rewritten (e.g. same binary)
  args: string[];                  // possibly extended (e.g. `--mcp-config …`, `-c mcp_servers…`)
  env: Record<string, string>;     // additions/overrides (PATH with shims, KORA_*)
  notes: string[];                 // human-readable: what was applied
}
export interface AdapterResult { agent: string; action: 'installed' | 'refreshed' | 'removed' | 'skipped' | 'managed' | 'absent'; file: string; detail?: string }
export interface DoctorCheck { name: string; ok: boolean; detail: string; fix?: string; /** Not ok, but nothing breaks without it (an optional agent): shown as a warning, never counted as a problem */ optional?: boolean }
export interface Enforcer {
  prepare(input: PrepareInput): Promise<EnforcePlan>;
  install(opts: { agent: AgentId | 'all'; cwd: string }): Promise<{ results: AdapterResult[] }>;
  uninstall(opts: { agent: AgentId | 'all'; cwd: string; /** Leave the per-machine PATH shims (a single repo's cleanup) */ keepShims?: boolean }): Promise<{ results: AdapterResult[] }>;
  status(opts: { agent: AgentId | 'all'; cwd: string }): Promise<{ results: AdapterResult[] }>;
  doctor(opts: { cwd: string }): Promise<{ checks: DoctorCheck[] }>;
}
export function createEnforcer(opts: { graph?: import('../graph').GraphService } = {}): Enforcer { return require('./enforcer').createEnforcer(opts); }
