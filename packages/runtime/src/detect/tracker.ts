// Stateful layer on top of detect(): idle confirmation, unknown-never-overwrites, output-based fallback.
import type { AgentState } from '../protocol/types';
import { detect, Detection, DetectionSnapshot } from './manifest';

export const IDLE_CONFIRM_MS = 700;      // working→idle needs this much silence
export const UNKNOWN_STALE_MS = 30_000;  // unknown may replace a known state only after this
export const RECENT_OUTPUT_MS = 1_500;   // no rule matched + output this recent → working
export const BLOCKED_CONFIRM_MS = 400;   // a dialog must still be there on a second look before it counts
export const HINT_TTL_MS = 15 * 60_000;  // an agent's own "I am working" holds this long without a "stopped"
// …but not against a screen that has shown an idle prompt with NO output for this long: a lost Stop hook (a
// 400 ms fire-and-forget under load) held a finished worker "working" for the full 15 min TTL in a live run, and
// the orchestrator's wait sat on it the whole time. Real turns print something well inside this window.
export const HINT_QUIET_OVERRIDE_MS = 30_000;

export interface TrackerResult { state: AgentState; blocker: string | null; changed: boolean; ruleId: string | null; recheckInMs: number | null }

/**
 * Two sources feed the state:
 *   • the SCREEN (manifest regexes over the terminal) — universal, and the only source that can see a permission
 *     dialog, but a heuristic: prompt boxes redraw between tool calls, a printed list can look like a menu;
 *   • the AGENT ITSELF, when it has hooks (Claude Code: UserPromptSubmit / PreToolUse / PostToolUse / Stop) —
 *     authoritative for "a turn is running" / "the turn ended", blind to dialogs.
 * Rules: a hook `working` outranks a scraped `idle` (no more false idles mid-turn); a hook `idle` simply releases
 * that; a scraped `blocked` outranks everything (only the screen can see the question) but must survive one
 * re-check so a transient redraw cannot raise it; exit outranks all.
 */
export class StateTracker {
  state: AgentState = 'unknown';
  blocker: string | null = null;
  private lastKnownAt = 0;     // last time a rule produced a known (non-unknown) state
  private idleSince: number | null = null;
  private blockedSince: number | null = null;
  private hintState: 'working' | 'idle' | null = null;
  private hintAt = 0;

  reset() { this.state = 'unknown'; this.blocker = null; this.lastKnownAt = 0; this.idleSince = null; this.blockedSince = null; this.hintState = null; this.hintAt = 0; }

  /** The agent reported its own turn state (through a hook). */
  hint(state: 'working' | 'idle', now: number) { this.hintState = state; this.hintAt = now; }
  get hinted(): 'working' | 'idle' | null { return this.hintState; }

  /** An event-driven agent (Koragent) set its state: take it as is (no screen, no confirmation). */
  force(state: AgentState, blocker: string | null): TrackerResult {
    const prev = this.state, prevBlocker = this.blocker;
    this.hintState = state === 'working' || state === 'idle' ? state : null;
    if (state !== 'unknown') this.lastKnownAt = Date.now();
    this.idleSince = null; this.blockedSince = null;
    return this.apply(state, state === 'blocked' ? blocker : null, prev, prevBlocker, 'event', null);
  }

  update(snapshot: DetectionSnapshot, agentId: string, now: number, lastOutputAt: number, exited = false): TrackerResult {
    const prev = this.state, prevBlocker = this.blocker;
    if (exited) return this.apply(this.state === 'unknown' ? 'idle' : this.state, null, prev, prevBlocker, null, null);
    const d: Detection = detect(snapshot, agentId);
    let next: AgentState; let blocker: string | null = null; let recheck: number | null = null;
    if (d.matched && d.skipStateUpdate) return { state: prev, blocker: prevBlocker, changed: false, ruleId: d.ruleId, recheckInMs: null };
    if (!d.matched) {
      // No rule matched (or no manifest for this agent, e.g. a shell): output flowing → working, quiet → idle.
      const quiet = now - lastOutputAt;
      if (quiet < RECENT_OUTPUT_MS) { next = 'working'; recheck = RECENT_OUTPUT_MS - quiet + 10; }
      else next = 'idle';
    } else {
      next = d.state; blocker = d.blocker;
    }
    if (next === 'unknown' && prev !== 'unknown' && now - this.lastKnownAt < UNKNOWN_STALE_MS) { next = prev; blocker = prevBlocker; recheck = UNKNOWN_STALE_MS - (now - this.lastKnownAt); }
    if (next !== 'unknown') this.lastKnownAt = now;
    // The agent said a turn is running and has not said it stopped: a scraped idle is a redraw, not the truth.
    const hintFresh = this.hintState !== null && now - this.hintAt < HINT_TTL_MS;
    if (hintFresh && this.hintState === 'working' && next === 'idle') {
      const quiet = now - lastOutputAt;
      if (quiet >= HINT_QUIET_OVERRIDE_MS && now - this.hintAt >= HINT_QUIET_OVERRIDE_MS) { this.hintState = null; } // the Stop was lost; the screen is the truth
      else { next = 'working'; blocker = null; recheck = Math.min(1000, HINT_QUIET_OVERRIDE_MS - quiet + 10); }
    }
    // Output still flowing means busy, whatever the prompt line says: idle needs IDLE_CONFIRM_MS of silence from
    // ANY prior state, not only from working. Codex keeps its `›` input line on screen while it runs a turn, so
    // its idle rule matched for the whole 30 s a worker was writing and committing — a wait on it returned at
    // once and the start-up re-type fired at a working agent. (Our own typed echo counts as output too: a moment
    // of "working" right after a prompt is harmless.)
    if (next === 'idle' && !(hintFresh && this.hintState === 'idle') && now - lastOutputAt < IDLE_CONFIRM_MS) { next = 'working'; blocker = null; recheck = IDLE_CONFIRM_MS - (now - lastOutputAt) + 10; }
    // A dialog must still be on screen on a second look before it counts (a printed list scrolling past the
    // prompt box, a half-drawn frame): one false `blocked` costs a transcript row and an orchestrator note.
    if (next === 'blocked' && prev !== 'blocked') {
      if (this.blockedSince == null) { this.blockedSince = now; return { state: prev, blocker: prevBlocker, changed: false, ruleId: d.ruleId, recheckInMs: BLOCKED_CONFIRM_MS + 10 }; }
      if (now - this.blockedSince < BLOCKED_CONFIRM_MS) return { state: prev, blocker: prevBlocker, changed: false, ruleId: d.ruleId, recheckInMs: BLOCKED_CONFIRM_MS - (now - this.blockedSince) + 10 };
    }
    if (next !== 'blocked') this.blockedSince = null;
    // working → idle needs a quiet period (agents redraw the prompt box between tool calls)
    if (prev === 'working' && next === 'idle') {
      const quiet = now - lastOutputAt;
      if (quiet < IDLE_CONFIRM_MS) {
        if (this.idleSince == null) this.idleSince = now;
        return { state: prev, blocker: prevBlocker, changed: false, ruleId: d.ruleId, recheckInMs: IDLE_CONFIRM_MS - quiet + 10 };
      }
    }
    this.idleSince = null;
    return this.apply(next, next === 'blocked' ? blocker : null, prev, prevBlocker, d.ruleId, recheck);
  }

  private apply(next: AgentState, blocker: string | null, prev: AgentState, prevBlocker: string | null, ruleId: string | null, recheck: number | null): TrackerResult {
    // Codex blinks its title between "[ . ] Action Required" and "[ ! ] Action Required" every second while it
    // waits; without this the blocker "changed" once a second and every listener re-rendered the pane.
    blocker = blocker == null ? null : blocker.replace(/^\s*\[\s*[.!*+\-]?\s*\]\s*/, '').trim() || blocker;
    this.state = next; this.blocker = blocker;
    return { state: next, blocker, changed: next !== prev || blocker !== prevBlocker, ruleId, recheckInMs: recheck };
  }
}
