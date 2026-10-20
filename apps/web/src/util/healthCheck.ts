import { fetchPrimaryHost } from "../hosts/primary/shellAuth";
import { thisComputer } from "./utils";
/**
 * Health checks from the daemon's `GET /api/doctor` and the redacted diagnostics export
 * (`POST /api/doctor/export`). The shapes mirror the runtime's `HealthReport`
 * (packages/runtime/src/server/health.ts); they are plain JSON, not part of the RPC contract,
 * so every field is read defensively and unknown check ids / statuses still render.
 */

export type HealthStatus = "ok" | "warn" | "fail" | "skip";

export interface HealthCheck {
  readonly id: string;
  readonly label: string;
  readonly status: HealthStatus;
  readonly detail: string;
  readonly fix: string | null;
  /** Structured facts some checks carry (local-models: `{ servers }`). */
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface HealthReport {
  readonly koraVersion: string;
  readonly platform: string;
  readonly cwd: string | null;
  readonly generatedAt: number;
  readonly checks: readonly HealthCheck[];
}

const STATUSES: ReadonlySet<string> = new Set<HealthStatus>(["ok", "warn", "fail", "skip"]);

/** Parse an `/api/doctor` body; null when it is not a report. */
export function parseHealthReport(value: unknown): HealthReport | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.checks)) return null;
  const checks: HealthCheck[] = [];
  for (const raw of v.checks) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== "string" || typeof c.label !== "string") continue;
    checks.push({
      id: c.id,
      label: c.label,
      status:
        typeof c.status === "string" && STATUSES.has(c.status)
          ? (c.status as HealthStatus)
          : "warn",
      detail: typeof c.detail === "string" ? c.detail : "",
      fix: typeof c.fix === "string" && c.fix ? c.fix : null,
      ...(c.data && typeof c.data === "object" && !Array.isArray(c.data)
        ? { data: c.data as Record<string, unknown> }
        : {}),
    });
  }
  return {
    koraVersion: typeof v.koraVersion === "string" ? v.koraVersion : "unknown",
    platform: typeof v.platform === "string" ? v.platform : "",
    cwd: typeof v.cwd === "string" ? v.cwd : null,
    generatedAt: typeof v.generatedAt === "number" ? v.generatedAt : Date.now(),
    checks,
  };
}

const AGENT_ROWS: ReadonlySet<string> = new Set([
  "claude-cli",
  "claude-auth",
  "codex",
  "opencode",
  "antigravity",
]);

/** A tool that is never part of the "to fix" tally: its own row still shows. */
const isOptionalCheck = (c: HealthCheck): boolean => c.id === "cli-path";

/**
 * Each agent row is optional on its own, but at least one agent must work (Claude signed in, or Codex, OpenCode,
 * Antigravity ok). `usable` is null when the report has no agent rows. Mirrors `agentSummary` in the runtime's health.ts.
 */
export function agentsUsable(checks: readonly HealthCheck[]): boolean | null {
  const agents = checks.filter((c) => AGENT_ROWS.has(c.id));
  if (agents.length === 0) return null;
  return agents.some((c) => c.status === "ok" && c.id !== "claude-cli");
}

/**
 * One line for the section header: the worst status wins. Optional tools do not count as things to fix, and the agent
 * rows count nothing while one agent works, or as one problem when none does.
 */
export function summarizeHealth(report: HealthReport): {
  readonly tone: "ok" | "warn" | "fail";
  readonly text: string;
} {
  const usable = agentsUsable(report.checks);
  const isAgentRow = (c: HealthCheck) => usable !== null && AGENT_ROWS.has(c.id);
  const counted = report.checks.filter((c) => !isOptionalCheck(c) && !isAgentRow(c));
  const fail = counted.filter((c) => c.status === "fail").length + (usable === false ? 1 : 0);
  const warn = counted.filter((c) => c.status === "warn").length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (usable === false && fail === 1 && warn === 0) {
    return {
      tone: "fail",
      text: "No coding agent works yet: get any one of Claude Code, Codex, OpenCode or Antigravity ready",
    };
  }
  if (fail > 0) {
    return {
      tone: "fail",
      text: `${plural(fail, "problem")}${warn ? ` and ${plural(warn, "warning")}` : ""} to fix`,
    };
  }
  if (warn > 0) return { tone: "warn", text: `Works, with ${plural(warn, "warning")}` };
  const optional = report.checks.filter(
    (c) => (isOptionalCheck(c) || isAgentRow(c)) && c.status !== "ok" && c.status !== "skip",
  ).length;
  if (optional > 0) {
    return {
      tone: "ok",
      text: `Everything required checks out (${plural(optional, "optional note")})`,
    };
  }
  return { tone: "ok", text: "Everything checks out" };
}

/** Sort problems first (fail → warn → ok → skip), keeping the daemon's order within a status. */
export function orderChecks(checks: readonly HealthCheck[]): HealthCheck[] {
  const rank: Record<HealthStatus, number> = { fail: 0, warn: 1, ok: 2, skip: 3 };
  return checks
    .map((check, index) => ({ check, index }))
    .toSorted((a, b) => rank[a.check.status] - rank[b.check.status] || a.index - b.index)
    .map((entry) => entry.check);
}

/** Split a fix line into text and `code` runs so commands render (and copy) as code. */
export function fixSegments(
  fix: string,
): readonly { readonly text: string; readonly code: boolean }[] {
  const out: { text: string; code: boolean }[] = [];
  const parts = fix.split("`");
  parts.forEach((text, index) => {
    if (text) out.push({ text, code: index % 2 === 1 });
  });
  return out;
}

export async function fetchHealthReport(
  httpBaseUrl: string,
  options: {
    readonly cwd?: string | null;
    readonly only?: readonly string[];
    readonly probe?: boolean;
  } = {},
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetchPrimaryHost,
): Promise<HealthReport> {
  const url = new URL("/api/doctor", httpBaseUrl);
  if (options.cwd) url.searchParams.set("cwd", options.cwd);
  if (options.only?.length) url.searchParams.set("only", options.only.join(","));
  if (options.probe === false) url.searchParams.set("probe", "0");
  const res = await fetchImpl(url.toString());
  if (res.status === 404) {
    throw new Error("This Kora daemon has no health checks yet. Update Kora, then try again.");
  }
  if (!res.ok) throw new Error(`The health check failed (HTTP ${res.status}).`);
  const report = parseHealthReport(await res.json());
  if (report === null) throw new Error("The daemon sent an unreadable health report.");
  return report;
}

export async function exportDiagnostics(
  httpBaseUrl: string,
  options: { readonly cwd?: string | null; readonly dir?: string | null },
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetchPrimaryHost,
): Promise<{ readonly path: string; readonly bytes: number }> {
  const res = await fetchImpl(new URL("/api/doctor/export", httpBaseUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: options.cwd ?? null, dir: options.dir ?? null }),
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: unknown;
    path?: unknown;
    bytes?: unknown;
    reason?: unknown;
  } | null;
  if (res.ok && body?.ok === true && typeof body.path === "string") {
    return { path: body.path, bytes: typeof body.bytes === "number" ? body.bytes : 0 };
  }
  if (res.status === 404) {
    throw new Error(
      "This Kora daemon can't export diagnostics yet. Update Kora, or run `kora doctor --export`.",
    );
  }
  throw new Error(
    typeof body?.reason === "string" && body.reason
      ? body.reason
      : `Export failed (HTTP ${res.status}).`,
  );
}

/** A local OpenAI-compatible model server the daemon found (runtime `LocalModelServer`). */
export interface LocalModelServer {
  readonly kind: "ollama" | "lmstudio";
  readonly baseUrl: string;
  readonly reachable: boolean;
  readonly models: readonly string[];
}

/** The servers from a `local-models` check's data; [] when absent or malformed. */
export function localModelServers(check: HealthCheck | undefined): LocalModelServer[] {
  const raw = check?.data?.servers;
  if (!Array.isArray(raw)) return [];
  const out: LocalModelServer[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const s = entry as Record<string, unknown>;
    if (s.kind !== "ollama" && s.kind !== "lmstudio") continue;
    out.push({
      kind: s.kind,
      baseUrl: typeof s.baseUrl === "string" ? s.baseUrl : "",
      reachable: s.reachable === true,
      models: Array.isArray(s.models)
        ? s.models.filter((m): m is string => typeof m === "string")
        : [],
    });
  }
  return out;
}

/**
 * Code-only rows never show on a Kora (blob) project (live QA #4: a group's Diagnostics said "not a git repository ...
 * git init ... Swarm workers need one for their worktrees"): the graph index, git and OpenCode are Code-surface machinery.
 * The disk row keeps its meaning without the worktree wording.
 */
const CODE_ONLY_CHECKS = new Set(["graph", "git", "opencode"]);
export function checksForSurface(report: HealthReport, surface: "blobs" | "code"): HealthReport {
  if (surface === "code") return report;
  return {
    ...report,
    checks: report.checks
      .filter((c) => !CODE_ONLY_CHECKS.has(c.id))
      .map((c) =>
        c.id === "disk"
          ? {
              ...c,
              detail: c.detail
                .replace(/Worktrees, indexes and installs/, "Files, memory and installs")
                .replace(/ Each Swarm worker gets its own worktree\./, ""),
              fix: c.fix ? `Free some space on ${thisComputer()}.` : null,
            }
          : c,
      ),
  };
}
