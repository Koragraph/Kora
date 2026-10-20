// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off -- plain boundary code: a small
// in-memory store with a JSON file beside it and unref'd timers, fed by driver events and on-demand probes; not Effect.
//
// The account's plan limits per provider ("5-hour session 42% · resets 11:00 PM"), published on the provider entry
// (`AgentStatus.usageLimits`) so the composer's usage line and Settings → Usage read it from the config stream
// every client already holds. Fed by:
//   - driver events (`usage.limits`): Claude's rate_limit_event on every request, Codex's rollout snapshot after every
//     turn, and either provider refusing a turn (limited until …);
//   - probes through the provider's own CLI (`host().readUsageLimits`): at boot, on Settings → Refresh, and after a
//     Claude turn when the last full read is old;
//   - Antigravity: `agy -p /usage --output-format json` (antigravityModels.ts `readAgyUsage`, a child process, 0 tokens)
//     at boot, on Refresh and after every agy turn. agy not installed = no entry at all.
// Persisted to `<KORA_HOME>/usage-limits.json` so a restart shows the last known numbers at once.
import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentUsageLimits } from "@kora/contracts";

import { daemonConfig } from "./config.ts";
import { host, type KoraUsageLimitsReport, type KoraUsageWindow } from "./host.ts";
import { notifyAgentStatusesChanged } from "./modelRefresh.ts";
import { readAgyUsage } from "./antigravityModels.ts";

export type UsageProvider = "claude" | "codex" | "antigravity";
export const USAGE_AGENTS: ReadonlyArray<UsageProvider> = ["claude", "codex", "antigravity"];

/** The provider whose plan a thread's driver draws on (Claude, Codex, Antigravity), else null (OpenCode, ACP, API keys). */
export function usageProviderOf(driver: unknown): UsageProvider | null {
  return USAGE_AGENTS.find((p) => p === driver) ?? null;
}

/** A probe's answer: a report, null (the read failed: keep the last good bars) or "absent" (not installed: no entry). */
export type UsageRead = KoraUsageLimitsReport | null | "absent";

function defaultRead(p: UsageProvider): Promise<UsageRead> {
  if (p === "antigravity") return readAgyUsage();
  return host().readUsageLimits?.(p) ?? Promise.resolve(null);
}

interface AgentUsageState {
  checkedAt: number;
  windows: KoraUsageWindow[];
  plan?: string | undefined;
  limited?: { resetsAt?: number | undefined; message?: string | undefined } | undefined;
  unavailable?: { reason: "unsupported" | "probeFailed"; message?: string | undefined } | undefined;
  /** When the last FULL report (probe / Codex snapshot) landed; sparse events don't count. */
  fullAt?: number | undefined;
}

const KIND_ORDER: Record<KoraUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};
const REFRESH_MIN_INTERVAL_MS = 60_000;
const AFTER_TURN_REFRESH_MS = 5 * 60_000;
// No background timer: a periodic probe started claude/codex/agy processes every 2 minutes on its own, and agy's
// fallback OAuth opened login tabs in the user's browser. Numbers refresh on turns, on boot (Claude/Codex) and when
// the user opens the usage details or presses Refresh.
const PUSH_DEBOUNCE_MS = 400;

const iso = (ms: number | undefined): string | undefined =>
  ms !== undefined && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;

/** The wire shape (contracts `AgentUsageLimits`). No `undefined` leaves: the RPC JSON codec dies on them. */
export function toAgentUsageLimits(state: AgentUsageState): AgentUsageLimits {
  const windows = [...state.windows]
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label))
    .map((w) => {
      const resetsAt = iso(w.resetsAt);
      return {
        id: w.id,
        kind: w.kind,
        label: w.label,
        usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
        ...(resetsAt ? { resetsAt } : {}),
        ...(w.windowMinutes !== undefined && w.windowMinutes >= 0
          ? { windowDurationMins: Math.round(w.windowMinutes) }
          : {}),
      };
    });
  const limitedResets = iso(state.limited?.resetsAt);
  const limitedMessage = state.limited?.message?.trim();
  return {
    checkedAt: new Date(state.checkedAt).toISOString(),
    windows,
    ...(state.plan ? { plan: state.plan } : {}),
    ...(state.limited
      ? {
          limited: {
            ...(limitedResets ? { resetsAt: limitedResets } : {}),
            ...(limitedMessage ? { message: limitedMessage.slice(0, 500) } : {}),
          },
        }
      : {}),
    ...(state.unavailable
      ? {
          unavailable: {
            reason: state.unavailable.reason,
            ...(state.unavailable.message ? { message: state.unavailable.message } : {}),
          },
        }
      : {}),
  };
}

/**
 * Fold one report into a provider's state. A complete report replaces the windows; a sparse one merges by id. A
 * report that carries windows and is not `limited` means the provider is serving requests again.
 */
export function mergeUsageReport(
  prev: AgentUsageState | undefined,
  report: KoraUsageLimitsReport,
  now: number,
  message?: string,
): AgentUsageState {
  const windows = report.complete
    ? [...report.windows]
    : [
        ...(prev?.windows ?? []).filter((w) => !report.windows.some((n) => n.id === w.id)),
        ...report.windows,
      ];
  const limited = report.limited
    ? {
        resetsAt: report.resetsAt ?? prev?.limited?.resetsAt,
        message: message ?? prev?.limited?.message,
      }
    : report.complete || report.windows.length > 0
      ? undefined
      : prev?.limited;
  const unavailable =
    report.complete && windows.length === 0 && !report.limited
      ? { reason: "unsupported" as const }
      : undefined;
  return {
    checkedAt: now,
    windows,
    plan: report.plan ?? prev?.plan,
    limited,
    unavailable,
    fullAt: report.complete ? now : prev?.fullAt,
  };
}

export class UsageLimitsService {
  private state = new Map<UsageProvider, AgentUsageState>();
  private file: string | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight = new Map<UsageProvider, Promise<void>>();
  private lastProbeAt = new Map<UsageProvider, number>();

  private readonly read: (p: UsageProvider) => Promise<UsageRead>;
  private readonly publish: () => void;

  constructor(
    read: (p: UsageProvider) => Promise<UsageRead> = defaultRead,
    publish: () => void = notifyAgentStatusesChanged,
  ) {
    this.read = read;
    this.publish = publish;
  }

  /** Load the last known numbers and put them on the provider entries before the first snapshot goes out. */
  init(koraHome: string): void {
    this.file = path.join(koraHome, "usage-limits.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, AgentUsageState>;
      for (const p of USAGE_AGENTS) {
        const s = raw?.[p];
        if (s && Array.isArray(s.windows) && typeof s.checkedAt === "number") this.state.set(p, s);
      }
    } catch {
      /* first run */
    }
    this.applyToConfig();
  }

  snapshot(provider: UsageProvider): AgentUsageLimits | null {
    const s = this.state.get(provider);
    return s ? toAgentUsageLimits(s) : null;
  }

  /** A driver's `usage.limits` event (or a refused turn). */
  apply(provider: UsageProvider, report: KoraUsageLimitsReport, message?: string): void {
    const prev = this.state.get(provider);
    const next = mergeUsageReport(prev, report, Date.now(), message);
    this.state.set(provider, next);
    const changed =
      !prev ||
      JSON.stringify({ ...toAgentUsageLimits(prev), checkedAt: 0 }) !==
        JSON.stringify({ ...toAgentUsageLimits(next), checkedAt: 0 });
    // checkedAt alone moving is not worth a frame to every client; it still persists.
    this.schedulePush(changed);
  }

  /** Probe one provider (or both) through its CLI. Throttled unless `force`; one in flight per provider. */
  async refresh(
    providers: ReadonlyArray<UsageProvider> = USAGE_AGENTS,
    opts: { force?: boolean; maxAgeMs?: number } = {},
  ): Promise<void> {
    await Promise.all(
      providers.map((p) => {
        const running = this.inflight.get(p);
        if (running) return running;
        const last = this.lastProbeAt.get(p) ?? 0;
        if (!opts.force && Date.now() - last < REFRESH_MIN_INTERVAL_MS) return Promise.resolve();
        // Opening the details: only a reading older than `maxAgeMs` is worth starting a CLI for.
        const checkedAt = this.state.get(p)?.checkedAt;
        if (
          !opts.force &&
          opts.maxAgeMs !== undefined &&
          checkedAt !== undefined &&
          Date.now() - checkedAt < opts.maxAgeMs
        )
          return Promise.resolve();
        this.lastProbeAt.set(p, Date.now());
        const run = this.read(p)
          .catch(() => null)
          .then((report) => {
            if (report === "absent") {
              if (this.state.delete(p)) this.schedulePush(true);
              return;
            }
            if (report) {
              this.apply(p, { ...report, complete: true });
              return;
            }
            const prev = this.state.get(p);
            // Keep the last good bars; just say this read failed.
            this.state.set(p, {
              ...(prev ?? { windows: [] }),
              checkedAt: Date.now(),
              unavailable: { reason: "probeFailed", message: "Couldn't read usage just now." },
            } as AgentUsageState);
            this.schedulePush(true);
          })
          .finally(() => this.inflight.delete(p));
        this.inflight.set(p, run);
        return run;
      }),
    );
  }

  /** After a turn: a Claude thread's live session answers cheaply, so keep the numbers fresh-ish. */
  onTurnSettled(provider: string): void {
    // agy's /usage is a local read (instant, no tokens): after every agy turn.
    if (provider === "antigravity") {
      void this.refresh(["antigravity"]);
      return;
    }
    if (provider !== "claude") return; // Codex reports its snapshot after every turn by itself
    const s = this.state.get("claude");
    if (s?.fullAt && Date.now() - s.fullAt < AFTER_TURN_REFRESH_MS) return;
    void this.refresh(["claude"]);
  }

  private schedulePush(publish: boolean): void {
    this.applyToConfig();
    if (this.pushTimer) {
      if (!publish) return;
      clearTimeout(this.pushTimer);
    }
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.persist();
      if (publish) this.publish();
    }, PUSH_DEBOUNCE_MS);
    this.pushTimer.unref?.();
  }

  private applyToConfig(): void {
    for (const p of USAGE_AGENTS) {
      const s = this.state.get(p);
      const entry = daemonConfig.providers.find((x) => x.instanceId === p);
      if (!entry) continue;
      if (s) (entry as { usageLimits?: AgentUsageLimits }).usageLimits = toAgentUsageLimits(s);
      else delete (entry as { usageLimits?: AgentUsageLimits }).usageLimits;
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.state)));
      fs.renameSync(tmp, this.file);
    } catch (cause) {
      console.warn("[kora-ui] usage-limits persist failed:", String(cause));
    }
  }
}

let service: UsageLimitsService | null = null;
export function usageLimits(): UsageLimitsService {
  if (!service) service = new UsageLimitsService();
  return service;
}
