// Confirmed state for an OpenCode swarm worker. The tracker's no-rule fallback ("output flowing → working, quiet →
// idle") misreads OpenCode: during start-up the TUI clears the screen for a few hundred ms, which reads as a quiet
// blank → idle, and the start-up draw reads as working. Found live (e2e, v1.18.32): that blip released the swarm's
// prompt-pending hold, kora_wait answered "idle, no report" 2 s after spawn, and the nudge typed over a worker that
// had not started. A swarm pane's state only counts when a real signal backs it: the manifest's own screen rules
// (esc_interrupt / retrying = working, idle_prompt = idle) or the kora-state plugin's hook hint.
import { detect } from '../detect';

type StatePane = { hinted?: 'working' | 'idle' | null; detectionSnapshot?: () => any; eventDriven?: boolean };

/** The OpenCode manifest rule behind the pane's current screen; undefined when the pane can't say (test fakes). */
function ruleOf(pane: StatePane): string | null | undefined {
  if (typeof pane.detectionSnapshot !== 'function') return undefined;
  try { return detect(pane.detectionSnapshot(), 'opencode').ruleId; } catch { return undefined; }
}

// A Koragent worker (eventDriven) reports its state on its event stream: that state is confirmed by definition.
export function swarmWorkingConfirmed(pane: StatePane): boolean {
  if (pane.eventDriven) return true;
  const r = ruleOf(pane);
  return r === undefined || pane.hinted === 'working' || r === 'esc_interrupt' || r === 'retrying';
}

export function swarmIdleConfirmed(pane: StatePane): boolean {
  if (pane.eventDriven) return true;
  const r = ruleOf(pane);
  return r === undefined || pane.hinted === 'idle' || r === 'idle_prompt';
}
