// Plan headroom: how close the user's Claude plan is to a limit, from the `usage.limits` reports the chat lane already
// receives (the SDK's rate_limit_event carries a window's utilization when it crosses a warning threshold, e.g. the weekly
// at 74% and 90%; `rejected` = limited). When a window is tight, Auto starts NEW threads that would run on an Opus or Fable
// Default on Sonnet 5.5 at high effort instead (about half the plan use per token), so the user keeps working instead of
// hitting the wall. A running thread is never switched (a switch re-writes its whole context). Anthropic does not publish
// how plan usage is weighted; the working model (list-price-weighted, R §6.2) says Sonnet burns about half of Opus.
import fs from 'node:fs';
import type { UsageLimitsReport, UsageWindow } from './events';

/** A window at or above this share of its limit is tight. */
export const HEADROOM_TIGHT_PERCENT = 85;

export interface TightWindow { window: UsageWindow; limited: boolean }

/**
 * Windows that say the Default is short of room: the 5-hour and weekly all-model windows, and a weekly window of the
 * Default's own family (Opus, Fable). Never the weekly Sonnet window (moving work onto Sonnet is the remedy, not the
 * problem: R6 review #4) or extra usage (paid overage, not a plan wall).
 */
function counts(id: string): boolean {
  return !/^seven_day_sonnet|overage/.test(id);
}

export class PlanHeadroom {
  private readonly windows = new Map<string, UsageWindow & { at: number }>();
  private limitedUntil = 0;
  private file: string | null = null;

  /**
   * Keep the last reports in `file` across daemon restarts: a threshold event comes once per crossing, so a user already
   * at 90% would otherwise get no tight window until the next one (R6 review #10). Loads what is there now.
   */
  persistTo(file: string): void {
    this.file = file;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const w of Array.isArray(j?.windows) ? j.windows : []) if (w && typeof w.id === 'string' && typeof w.usedPercent === 'number' && typeof w.at === 'number' && counts(w.id)) this.windows.set(w.id, w);
      if (typeof j?.limitedUntil === 'number') this.limitedUntil = j.limitedUntil;
    } catch { /* none yet, or unreadable: start empty */ }
  }

  /** Merge a Claude report (windows by id); other providers are ignored. */
  observe(r: UsageLimitsReport | null | undefined, now: number = Date.now()): void {
    if (!r || r.provider !== 'claude') return;
    const ws = (r.windows ?? []).filter((w) => w && typeof w.usedPercent === 'number');
    for (const w of ws) if (counts(w.id)) this.windows.set(w.id, { ...w, at: now });
    // A rejection names its window when it carries one: a Sonnet-only or overage wall is not the Default's.
    if (r.limited && (ws.length === 0 || ws.some((w) => counts(w.id)))) this.limitedUntil = r.resetsAt && r.resetsAt > now ? r.resetsAt : now + 15 * 60_000;
    if (this.file) { try { fs.writeFileSync(this.file, JSON.stringify({ windows: [...this.windows.values()], limitedUntil: this.limitedUntil }), { mode: 0o600 }); } catch { /* advisory */ } }
  }

  /** The tightest window that is still current (not reset, not older than its own length), or null when there is room. */
  tight(now: number = Date.now()): TightWindow | null {
    let worst: (UsageWindow & { at: number }) | null = null;
    for (const w of this.windows.values()) {
      if (w.resetsAt && w.resetsAt <= now) continue;
      if (w.windowMinutes && now - w.at > w.windowMinutes * 60_000) continue;
      if (w.usedPercent < HEADROOM_TIGHT_PERCENT) continue;
      if (!worst || w.usedPercent > worst.usedPercent) worst = w;
    }
    const limited = this.limitedUntil > now;
    if (!worst && !limited) return null;
    const { at: _at, ...window } = worst ?? { id: 'limited', kind: 'other' as const, label: 'Usage', usedPercent: 100, at: now };
    return { window, limited };
  }
}

/** "your Claude Weekly · all models limit is at 90%" (the Auto notice says why it chose Sonnet). */
export function tightReason(t: TightWindow): string {
  if (t.limited && t.window.id === 'limited') return 'your Claude plan hit a limit';
  return `your Claude ${t.window.label} limit is at ${Math.round(t.window.usedPercent)}%`;
}
