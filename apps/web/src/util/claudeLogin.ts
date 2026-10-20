import { fetchPrimaryHost } from "../hosts/primary/shellAuth";
import type { HealthCheck } from "./healthCheck";

/**
 * "Log in to Claude" from inside Kora: the daemon runs `claude auth login` (the CLI when installed, else the copy
 * bundled with Kora — so a Mac without Claude Code can still sign in) and the CLI opens the browser. Plain JSON over
 * `/api/claude/login` (runtime `server/claude-login.ts`), not the RPC contract.
 */
export type ClaudeLoginPhase = "idle" | "waiting" | "done" | "failed" | "cancelled";

export interface ClaudeLoginState {
  readonly phase: ClaudeLoginPhase;
  readonly url: string | null;
  readonly message: string | null;
  readonly via: "cli" | "bundled" | null;
}

const PHASES: ReadonlySet<string> = new Set(["idle", "waiting", "done", "failed", "cancelled"]);

export function parseClaudeLoginState(val: unknown): ClaudeLoginState | null {
  if (!val || typeof val !== "object") return null;
  const raw = val as Record<string, unknown>;
  if (typeof raw.phase !== "string" || !PHASES.has(raw.phase)) return null;
  return {
    phase: raw.phase as ClaudeLoginPhase,
    url: typeof raw.url === "string" && /^https:\/\//.test(raw.url) ? raw.url : null,
    message: typeof raw.message === "string" && raw.message ? raw.message : null,
    via: raw.via === "cli" || raw.via === "bundled" ? raw.via : null,
  };
}

/** The health row that can offer the button: a failed Claude login the daemon says it can run itself. */
export function canLogInFromApp(check: HealthCheck): boolean {
  return (
    check.id === "claude-auth" &&
    check.status === "fail" &&
    (check.data?.login === "bundled" || check.data?.login === "cli")
  );
}

async function readState(res: Response): Promise<ClaudeLoginState> {
  if (res.status === 404)
    throw new Error("This Kora daemon can't sign in to Claude yet. Update Kora.");
  const login = parseClaudeLoginState(await res.json().catch(() => null));
  if (!res.ok || login === null) throw new Error(`The login did not start (HTTP ${res.status}).`);
  return login;
}

export async function claudeLoginAction(
  httpOrigin: string,
  request:
    | { readonly action: "start" | "cancel" }
    | { readonly action: "code"; readonly code: string },
  fetchImpl: (address: string, init?: RequestInit) => Promise<Response> = fetchPrimaryHost,
): Promise<ClaudeLoginState> {
  return readState(
    await fetchImpl(new URL("/api/claude/login", httpOrigin).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
}

export async function fetchClaudeLoginState(
  httpOrigin: string,
  fetchImpl: (address: string, init?: RequestInit) => Promise<Response> = fetchPrimaryHost,
): Promise<ClaudeLoginState> {
  return readState(await fetchImpl(new URL("/api/claude/login", httpOrigin).toString()));
}
