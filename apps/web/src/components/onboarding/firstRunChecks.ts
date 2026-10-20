import { useCallback, useEffect, useState } from "react";

import { canLogInFromApp } from "../../util/claudeLogin";
import { fetchHealthReport, type HealthCheck, type HealthReport } from "../../util/healthCheck";
import { useHostHttpBaseUrl, usePrimaryHostId } from "../../atoms/hosts";

/** What a first chat needs (the daemon and any one of the four agents: Claude Code and its login, Codex, OpenCode,
 *  Antigravity) plus git, which opening a project wants (the code map, Swarm worktrees), and the CLI on PATH. Quick: no
 *  provider probes. */
export const FIRST_RUN_CHECKS = [
  "daemon",
  "claude-cli",
  "claude-auth",
  "codex",
  "opencode",
  "antigravity",
  "git",
  "cli-path",
] as const;

/** Rows that block a first chat whatever the agent; git is not one of them (chat works without it). */
const CHAT_BLOCKING_CHECKS: ReadonlySet<string> = new Set(["daemon"]);
/** The Claude rows block only while no other agent is usable (or on a Claude thread, `requireClaude`). */
const CLAUDE_CHECKS: ReadonlySet<string> = new Set(["claude-cli", "claude-auth"]);

/** The agents whose row says `ok` is "usable" (Claude: signed in). */
const OTHER_AGENTS = [
  { id: "codex", name: "Codex" },
  { id: "opencode", name: "OpenCode" },
  { id: "antigravity", name: "Antigravity" },
] as const;

/** Names of the agents that are usable on this Mac, in the order the app lists them. */
export function readyAgents(checks: readonly HealthCheck[]): readonly string[] {
  const ok = (id: string) => checks.some((c) => c.id === id && c.status === "ok");
  return [
    ...(ok("claude-auth") ? ["Claude Code"] : []),
    ...OTHER_AGENTS.filter((a) => ok(a.id)).map((a) => a.name),
  ];
}

/** A healthy answer is reused for a while (each check spawns `claude` twice); a problem is re-asked. */
const HEALTHY_TTL_MS = 5 * 60_000;
const lastHealthy = new Map<
  string,
  { readonly at: number; readonly checks: readonly HealthCheck[] }
>();
/** One request at a time per daemon: the welcome screen and a setup card mounting together share it. */
const inFlight = new Map<string, Promise<HealthReport>>();

/** Every mounted `useFirstRunChecks`: a login finished in one card re-checks them all (the welcome step, the chips). */
const recheckListeners = new Set<() => void>();

/** Forget the cached answer and ask again everywhere (after a login). */
export function forgetFirstRunChecks(): void {
  lastHealthy.clear();
  for (const listener of recheckListeners) listener();
}

/**
 * The rows the empty states show: problems only, or one "ready" line when nothing is wrong. Kora is ready when any one
 * agent works, so Claude's rows are a problem only while none does, or on a Claude thread (`requireClaude`).
 */
export function firstRunProblems(
  checks: readonly HealthCheck[],
  { requireClaude = false }: { readonly requireClaude?: boolean } = {},
): {
  readonly problems: readonly HealthCheck[];
  readonly readyLine: string | null;
} {
  const agents = readyAgents(checks);
  const claudeBlocks = requireClaude || agents.length === 0;
  const problems = checks.filter(
    (c) =>
      (c.status === "fail" || c.status === "warn") &&
      (CHAT_BLOCKING_CHECKS.has(c.id) || (claudeBlocks && CLAUDE_CHECKS.has(c.id))),
  );
  if (problems.length > 0) return { problems, readyLine: null };
  return {
    problems: [],
    readyLine: agents.length > 0 ? `Ready: ${agents.join(", ")}.` : null,
  };
}

/** git missing or not working (e.g. no Apple command line tools on a fresh Mac): the row to show, else null. */
export function gitProblem(checks: readonly HealthCheck[] | null): HealthCheck | null {
  return (
    checks?.find((c) => c.id === "git" && (c.status === "warn" || c.status === "fail")) ?? null
  );
}

/** CLI shim not on PATH (~/.local/bin not on PATH): the row to show, else null. */
export function cliPathProblem(checks: readonly HealthCheck[] | null): HealthCheck | null {
  return (
    checks?.find((c) => c.id === "cli-path" && (c.status === "warn" || c.status === "fail")) ?? null
  );
}

/**
 * Claude's own sign-in state, from the checks (per thread; first run uses `agentsStep`): still asking, done, one in-app login away, something to fix
 * first (no Claude Code to log in with, a check that could not tell), or the daemon did not answer.
 */
export type ClaudeStep =
  | { readonly kind: "checking" }
  | { readonly kind: "done"; readonly detail: string | null }
  | { readonly kind: "sign-in"; readonly check: HealthCheck }
  | { readonly kind: "fix"; readonly problems: readonly HealthCheck[] }
  | { readonly kind: "unreachable" };

export function claudeStep(checks: readonly HealthCheck[] | null, failed: boolean): ClaudeStep {
  if (checks === null) return failed ? { kind: "unreachable" } : { kind: "checking" };
  const auth = checks.find((c) => c.id === "claude-auth");
  if (auth?.status === "ok") return { kind: "done", detail: auth.detail || null };
  if (auth && canLogInFromApp(auth)) return { kind: "sign-in", check: auth };
  const { problems } = firstRunProblems(checks, { requireClaude: true });
  // An older daemon without a login row, and nothing failing: nothing to ask of the user.
  return problems.length > 0 ? { kind: "fix", problems } : { kind: "done", detail: null };
}

/**
 * The first-run "Connect a coding agent" step: done when any agent works (`agents` names them; empty on an older daemon
 * with no rows to read), otherwise the four ways in, with Claude's own step for its one-click login.
 */
export type AgentsStep =
  | { readonly kind: "checking" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "done"; readonly agents: readonly string[]; readonly detail: string | null }
  | { readonly kind: "choose"; readonly claude: ClaudeStep };

export function agentsStep(checks: readonly HealthCheck[] | null, failed: boolean): AgentsStep {
  const claude = claudeStep(checks, failed);
  if (claude.kind === "checking" || claude.kind === "unreachable") return claude;
  const agents = readyAgents(checks ?? []);
  if (agents.length > 0) {
    return { kind: "done", agents, detail: claude.kind === "done" ? claude.detail : null };
  }
  return claude.kind === "done"
    ? { kind: "done", agents, detail: claude.detail }
    : { kind: "choose", claude };
}

/**
 * The first-run checks for the primary daemon (`/api/doctor?only=…&probe=0`). Re-asked when the window regains focus
 * while something is wrong (the fix often happens in a browser or a terminal). `failed` = the daemon did not answer
 * (an older daemon without the route, or unreachable).
 */
export function useFirstRunChecks(): {
  readonly httpBaseUrl: string | null;
  readonly checks: readonly HealthCheck[] | null;
  readonly checking: boolean;
  readonly failed: boolean;
  readonly recheck: () => void;
} {
  const hostId = usePrimaryHostId();
  const httpBaseUrl = useHostHttpBaseUrl(hostId);
  const [checks, setChecks] = useState<readonly HealthCheck[] | null>(null);
  const [round, setRound] = useState(0);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const hasProblems =
    checks !== null &&
    (firstRunProblems(checks).problems.length > 0 ||
      gitProblem(checks) !== null ||
      cliPathProblem(checks) !== null);
  const recheck = useCallback(() => {
    if (httpBaseUrl) lastHealthy.delete(httpBaseUrl);
    setRound((n) => n + 1);
  }, [httpBaseUrl]);

  useEffect(() => {
    const listener = () => setRound((n) => n + 1);
    recheckListeners.add(listener);
    return () => {
      recheckListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!hasProblems) return;
    const onFocus = () => setRound((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [hasProblems]);

  useEffect(() => {
    if (!httpBaseUrl) return;
    const cached = lastHealthy.get(httpBaseUrl);
    if (cached && Date.now() - cached.at < HEALTHY_TTL_MS) {
      setChecks(cached.checks);
      return;
    }
    let cancelled = false;
    setChecking(true);
    let request = inFlight.get(httpBaseUrl);
    if (!request) {
      request = fetchHealthReport(httpBaseUrl, { only: FIRST_RUN_CHECKS, probe: false });
      inFlight.set(httpBaseUrl, request);
      const base = httpBaseUrl;
      void request.finally(() => inFlight.delete(base)).catch(() => {});
    }
    request.then(
      (report) => {
        if (
          firstRunProblems(report.checks).problems.length === 0 &&
          !gitProblem(report.checks) &&
          !cliPathProblem(report.checks)
        ) {
          lastHealthy.set(httpBaseUrl, { at: Date.now(), checks: report.checks });
        } else {
          lastHealthy.delete(httpBaseUrl);
        }
        if (cancelled) return;
        setChecking(false);
        setFailed(false);
        setChecks(report.checks);
      },
      () => {
        if (cancelled) return;
        setChecking(false);
        setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [httpBaseUrl, round]);

  return { httpBaseUrl, checks, checking, failed, recheck };
}
