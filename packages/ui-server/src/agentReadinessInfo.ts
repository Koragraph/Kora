// @effect-diagnostics globalConsole:off globalDate:off -- boot-time boundary code (one background probe + a log line), not an Effect fiber.
// Real install + login state for the Claude and Codex provider entries.
//
// config.ts advertises both providers as installed, signed in and at Kora's own version, so the composer always has
// a provider to route to. That made Settings → Agents say "Ready · signed in" on a Mac with neither CLI installed nor
// logged in. The daemon's health checks (runtime `server/health.ts`: `claude-cli`, `claude-auth`, `codex`) already
// know the truth; this maps them onto the entries, at boot and whenever a client re-runs those checks
// (`/api/doctor`, e.g. the setup check's "Check again"), and pushes the change to open clients.
//
// Claude stays `status: "ready"` whatever the probe says: chat turns run on the Claude binary bundled with Kora, the
// composer must stay usable, and a signed-out turn fails with its own clear error. Codex without its CLI is
// `status: "error"` (it cannot run; the model picker shows it as unavailable instead of offering dead models).
import type { AgentStatus } from "@kora/contracts";

import { daemonConfig } from "./config.ts";
import { host } from "./host.ts";
import { notifyAgentsChanged } from "./modelRefresh.ts";

interface CheckRow {
  readonly id: string;
  readonly status: string;
  readonly detail: string;
  readonly fix: string | null;
}

const AGENT_HEALTH_CHECKS = ["claude-cli", "claude-auth", "codex"] as const;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const versionOf = (detail: string): string | null =>
  /\bv(\d+\.\d+\.\d+)\b/.exec(detail)?.[1] ?? null;

/** "Install … `curl … | bash` …" → the same text without backticks, for a plain-text card detail. */
const plain = (text: string): string => text.replaceAll("`", "");

function rowsOf(report: unknown): CheckRow[] {
  const checks = (report as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) return [];
  return checks.filter(
    (c): c is CheckRow =>
      !!c && typeof c === "object" && typeof c.id === "string" && typeof c.status === "string",
  );
}

const authLabel = (detail: string): { label?: string } => {
  const via = /\bvia ([\w.-]+)/.exec(detail)?.[1];
  return via ? { label: via } : {};
};

/** The provider fields the health rows imply; null when the report says nothing about that provider. */
export function claudeReadiness(
  rows: ReadonlyArray<CheckRow>,
): Pick<AgentStatus, "installed" | "version" | "auth" | "message"> | null {
  const cli = rows.find((r) => r.id === "claude-cli");
  const auth = rows.find((r) => r.id === "claude-auth");
  if (!cli && !auth) return null;
  const signedIn = auth?.status === "ok";
  const signedOut =
    auth?.status === "fail" || (auth?.status === "skip" && /not logged in/i.test(auth.detail));
  // Kora can run Claude without the CLI (it ships the binary), but not without a login — and logging in needs the
  // CLI. So "installed" here means "usable or one login away".
  const installed = cli?.status === "ok" || signedIn;
  const problem = [cli, auth].find((r) => r && (r.status === "fail" || r.status === "warn"));
  return {
    installed,
    version: cli ? versionOf(cli.detail) : null,
    auth: signedIn
      ? {
          status: "authenticated",
          type: "subscription",
          ...authLabel(auth?.detail ?? ""),
        }
      : { status: signedOut ? "unauthenticated" : "unknown" },
    // The card already headlines "Not installed": then the fix is the whole message.
    ...(problem
      ? {
          message: plain(
            !installed && problem.fix
              ? problem.fix
              : `${problem.detail} ${problem.fix ?? ""}`.trim(),
          ),
        }
      : {}),
  };
}

export function codexReadiness(
  rows: ReadonlyArray<CheckRow>,
): Pick<AgentStatus, "installed" | "version" | "auth" | "message" | "status"> | null {
  const row = rows.find((r) => r.id === "codex");
  if (!row) return null;
  if (row.status === "skip") {
    return {
      auth: { status: "unknown" },
      status: "error",
      version: null,
      installed: false,
      message: plain(row.fix ?? "Optional: install the Codex CLI to lead threads with Codex."),
    };
  }
  const signedIn = row.status === "ok";
  return {
    installed: true,
    version: versionOf(row.detail),
    status: "ready",
    auth: signedIn
      ? { status: "authenticated", type: "subscription" }
      : { status: /not logged in/i.test(row.detail) ? "unauthenticated" : "unknown" },
    ...(signedIn ? {} : { message: plain(`${row.detail} ${row.fix ?? ""}`.trim()) }),
  };
}

const snapshotKey = (p: AgentStatus): string =>
  JSON.stringify([p.installed, p.version, p.status, p.auth, p.message ?? null]);

/**
 * Patch the Claude/Codex entries from a health report (any subset of checks; providers the report says nothing about
 * are left alone). Returns true when an entry changed — and then tells every open client.
 */
export function applyHealthToAgents(report: unknown, now = new Date()): boolean {
  const rows = rowsOf(report);
  const patches: Record<string, object | null> = {
    claude: claudeReadiness(rows),
    codex: codexReadiness(rows),
  };
  let changed = false;
  for (const provider of daemonConfig.providers) {
    const patch = patches[provider.instanceId];
    if (!patch) continue;
    const before = snapshotKey(provider);
    const target = provider as Mutable<AgentStatus>;
    Object.assign(target, patch);
    if (!("message" in patch)) delete target.message;
    target.checkedAt = now.toISOString() as AgentStatus["checkedAt"];
    if (snapshotKey(target) !== before) changed = true;
  }
  if (changed) notifyAgentsChanged();
  return changed;
}

/** Boot: run the three checks in the background (each `claude` / `codex` spawn is bounded by the health module). */
export function probeAgentReadiness(): Promise<void> {
  const doctor = host().doctor;
  if (!doctor) return Promise.resolve();
  return doctor
    .run({ only: [...AGENT_HEALTH_CHECKS], probe: false })
    .then((report) => {
      applyHealthToAgents(report);
    })
    .catch((cause: unknown) => {
      console.warn("[kora-ui] provider readiness probe failed:", String(cause));
    });
}
