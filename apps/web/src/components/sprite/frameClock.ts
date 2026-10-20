/**
 * One shared timer for every mounted pixel animation: each player keeps its own frame index and next-due time, and
 * a single setTimeout fires at the earliest due time across all running players (none when nothing runs).
 */

interface Player {
  readonly durations: readonly number[];
  idx: number;
  nextAt: number;
  running: boolean;
  readonly onFrame: (idx: number) => void;
}

export interface FramePlayer {
  /** Pause (off screen) or resume; resuming waits the current frame's full duration again. */
  setRunning(running: boolean): void;
  dispose(): void;
}

const players = new Set<Player>();
let timer: ReturnType<typeof setTimeout> | null = null;
let timerAt = Number.POSITIVE_INFINITY;

const now = () => Date.now();

function schedule(): void {
  let earliest = Number.POSITIVE_INFINITY;
  for (const p of players) if (p.running && p.nextAt < earliest) earliest = p.nextAt;
  if (earliest === timerAt) return;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  timerAt = earliest;
  if (earliest === Number.POSITIVE_INFINITY) return;
  timer = setTimeout(tick, Math.max(0, earliest - now()));
}

function tick(): void {
  timer = null;
  timerAt = Number.POSITIVE_INFINITY;
  const t = now();
  for (const p of players) {
    if (!p.running || p.nextAt > t + 1) continue;
    p.idx = (p.idx + 1) % p.durations.length;
    // A late wake-up (throttled timer) resyncs instead of fast-forwarding through missed frames.
    p.nextAt = Math.max(p.nextAt + p.durations[p.idx]!, t + 1);
    p.onFrame(p.idx);
  }
  schedule();
}

/** Loop through frames with the given per-frame durations; `onFrame` gets each new index (starts at 0). */
export function playFrames(
  durations: readonly number[],
  onFrame: (idx: number) => void,
  running = true,
): FramePlayer {
  const p: Player = { durations, idx: 0, nextAt: now() + (durations[0] ?? 0), running, onFrame };
  if (durations.length > 1) {
    players.add(p);
    schedule();
  }
  return {
    setRunning(next) {
      if (next === p.running) return;
      p.running = next;
      if (next) p.nextAt = now() + p.durations[p.idx]!;
      schedule();
    },
    dispose() {
      players.delete(p);
      schedule();
    },
  };
}

/** How many players the shared clock is driving (tests). */
export function activePlayersForTests(): number {
  return [...players].filter((p) => p.running).length;
}
