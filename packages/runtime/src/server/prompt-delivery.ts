// Start-up prompt delivery check (Workspace.promptNow): after typing a prompt + Enter, make sure the agent took it,
// and escalate when it did not.
//
// Start-up races, seen live in every cross-agent run: a fresh Claude Code swallows the first Enter (text stays in the
// box); a fresh agy shows its `>` box before the input is wired and DROPS the text a few seconds later (the
// orchestrator then finds "an idle worker with an empty prompt"). One check at +4s was not enough for the second case
// — the text was still visible then and vanished afterwards. So escalate over ~16s: first a bare Enter (a no-op on a
// submitted prompt, the fix for a swallowed one); if the agent is STILL idle, clear the box and type the whole prompt
// again — agy kept our words visible in its box yet ignored three Enters, and only a full re-type got through (live
// run p22; bare-PTY runs confirm a re-type is accepted where a lone Enter is not). Three rounds, then leave it — the
// orchestrator's own wait reports the worker idle and it re-prompts.
//
// "Left idle" must be SUSTAINED: our own typed echo flips the screen to `working` for a moment (RECENT_OUTPUT) and, in
// a live 3-worker run, that blink ended the escalation after the first bare Enter while all three composers were in
// fact empty. Accepted = the agent's own hook said `working` after we typed (authoritative), or the pane has been
// non-idle for 1.5 s straight, or it blocked/exited. Strict mode for fleet WORKERS; a plain pane keeps the cheap check.
//
// Never re-send a prompt the agent already accepted. Found live (QA, plain `agent:"opencode"` worker): OpenCode took
// the prompt, worked for 0.6 s of `working`, then its screen read idle (its session footer matches the idle rule, and
// a quiet screen reads idle through the tracker's no-rule fallback) — the loop typed the whole task a second time, the
// worker did it twice and left an extra commit after the leader had merged. Only CONFIRMED states count
// (swarm-state.ts): acceptance is sticky once any confirmed signal shows it (hook hint, OpenCode's esc-interrupt /
// retrying footer, OpenCode's session view), and a re-send needs a confirmed "the prompt is not in": for OpenCode, its
// idle footer on the HOME screen (the session view only exists after a submitted prompt).
import { detect } from '../detect';
import { swarmIdleConfirmed } from './swarm-state';

export interface DeliveryPane {
  readonly id: string;
  readonly agent: string;
  readonly role?: string | null;
  readonly state: string;
  readonly exited: boolean;
  readonly hinted?: 'working' | 'idle' | null;
  readonly hintedAt: number;
  readonly lastOutputAt: number;
  write(data: string): void;
  detectionSnapshot?: () => any;
}

export interface DeliveryEnv {
  now(): number;
  sleep(ms: number): Promise<unknown>;
  log(msg: string): void;
}

// The OpenCode logo row; drawn only on the home route (routes/home.tsx), never in a session.
const OPENCODE_HOME_LOGO = /█▀▀█ █▀▀█ █▀▀█ █▀▀▄/;

function screenOf(p: DeliveryPane): string | null {
  if (typeof p.detectionSnapshot !== 'function') return null;
  try { return String(p.detectionSnapshot()?.screen ?? ''); } catch { return null; }
}

/** OpenCode has left its home screen for a session view — which it only opens once a prompt is submitted. */
export function opencodeSessionStarted(p: DeliveryPane): boolean {
  const screen = screenOf(p);
  return screen !== null && screen.trim().length > 0 && !OPENCODE_HOME_LOGO.test(screen);
}

/** OpenCode's own screen says it is busy (esc-interrupt / retrying footer) — our typed echo never draws these. */
function opencodeWorkingOnScreen(p: DeliveryPane): boolean {
  const screen = screenOf(p);
  if (screen === null) return false;
  try {
    const r = detect({ screen, oscTitle: '', oscProgress: '' } as any, 'opencode').ruleId;
    return r === 'esc_interrupt' || r === 'retrying';
  } catch { return false; }
}

/** Confirmed evidence the agent took the prompt typed at `typedAt`. */
export function promptTakenEvidence(p: DeliveryPane, typedAt: number): boolean {
  if (p.exited || p.state === 'blocked') return true;
  if (p.hintedAt > typedAt && p.hinted === 'working') return true;
  if (p.agent === 'opencode') return opencodeWorkingOnScreen(p) || opencodeSessionStarted(p);
  return false;
}

/** The pane is confirmed to be sitting at an un-submitted prompt, so a bare Enter / re-type is safe. */
export function promptNotTakenConfirmed(p: DeliveryPane): boolean {
  if (p.exited || p.state !== 'idle') return false;
  if (p.agent === 'opencode') {
    // A start-up blank or an unrecognised screen is a no-rule idle, not a confirmed one; a session view means taken.
    return swarmIdleConfirmed(p) && screenOf(p) !== null && !opencodeSessionStarted(p);
  }
  return true;
}

/** Runs the escalation for a prompt submitted at `typedAt`. `text` is what a re-type sends. */
export async function confirmStartupDelivery(p: DeliveryPane, text: string, typedAt: number, env: DeliveryEnv): Promise<void> {
  const strict = p.role === 'worker';
  let accepted = false;
  const taken = () => (accepted ||= promptTakenEvidence(p, typedAt));
  const leftIdle = async (ms: number) => {
    const t0 = env.now(); let since: number | null = null;
    while (!p.exited && env.now() - t0 < ms) {
      if (taken()) return true;
      if (p.state !== 'idle') { if (!strict) return true; since ??= env.now(); if (env.now() - since >= 1500) return true; } else since = null;
      await env.sleep(100);
    }
    return taken() || (p.state !== 'idle' && (!strict || (since !== null && env.now() - since >= 1500)));
  };
  // "Busy" is also evidenced by output: an agent that printed anything in the last few seconds took the prompt even
  // if its screen still reads idle — never type a second copy at it.
  const quietFor = (ms: number) => env.now() - p.lastOutputAt >= ms;
  // A fleet worker gets a longer runway: five Claude Codes starting at once (MCP servers, hooks) showed the idle prompt
  // box ~1.5 s after spawn yet ignored input for 20–30 s more — three quick rounds all fell inside that window.
  const rounds = strict ? 6 : 3;
  if (await leftIdle(4000)) return;
  for (let round = 0; round < rounds && p.state === 'idle' && !p.exited; round++) {
    if (!quietFor(3000)) { await env.sleep(3000); if (p.state !== 'idle' || p.exited || !quietFor(3000)) break; }
    if (taken() || !promptNotTakenConfirmed(p)) break;
    if (round === 0) { p.write('\r'); }
    else { env.log(`pane ${p.id}: prompt not taken at start-up (round ${round + 1}); typing it again`); p.write('\x15'); await env.sleep(30); p.write(text); await env.sleep(50); p.write('\r'); }
    if (await leftIdle(round === 0 ? 4000 : 6000 + round * 2000)) break;
  }
}

/** The typed text's last line is still in the input box at the bottom of the screen (a submitted prompt moves up into the transcript). */
export function textStillInInput(p: DeliveryPane, text: string): boolean {
  const screen = screenOf(p);
  if (screen === null) return false;
  const tail = (text.trim().split('\n').pop() ?? '').trim().replace(/\s+/g, ' ').slice(-40);
  if (tail.length < 4) return false;
  const bottom = screen.split('\n').map((l) => l.trim()).filter(Boolean).slice(-6).join(' ').replace(/\s+/g, ' ');
  return bottom.includes(tail);
}

/**
 * After the delivery escalation: look at the screen. A woken worker (a resumed session) showed the text typed but not
 * submitted while its state read non-idle, so the state-based escalation above never ran. If the text is still in the
 * input box, press Enter once more and look again. A bare Enter on a submitted prompt's empty box is a no-op.
 */
export async function confirmInputEmptied(p: DeliveryPane, text: string, env: DeliveryEnv): Promise<void> {
  if (p.role !== 'worker' || screenOf(p) === null) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    await env.sleep(attempt === 0 ? 1500 : 2500);
    if (p.exited || p.state === 'blocked' || !textStillInInput(p, text)) return;
    if (attempt === 1) { env.log(`pane ${p.id}: the prompt is still in the input box after a second Enter`); return; }
    env.log(`pane ${p.id}: the prompt was typed but not submitted; pressing Enter again`);
    p.write('\r');
  }
}
