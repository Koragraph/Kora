/**
 * One shared pointer listener drives the eyes of every avatar that opted in. Pointer moves are
 * coalesced to one rAF; each frame reads every follower's rect first, then writes the CSS custom
 * properties, so N avatars cost one layout read pass and N cheap style writes, never per-avatar
 * listeners or React renders.
 */

/** Largest eye travel: one sprite pixel each way (the eyes move in whole pixels only). */
const EYE_TRAVEL_X = 1;
const EYE_TRAVEL_Y = 1;

const snap = (v: number): number => (Math.abs(v) >= 0.5 ? Math.sign(v) : 0);

const followers = new Set<HTMLElement>();
const lastWritten = new WeakMap<HTMLElement, string>();
let pointer: { x: number; y: number } | null = null;
let frame = 0;
let listening = false;

function write(el: HTMLElement, rawX: number, rawY: number) {
  const x = snap(rawX);
  const y = snap(rawY);
  const key = `${x},${y}`;
  if (lastWritten.get(el) === key) return;
  lastWritten.set(el, key);
  el.style.setProperty("--ex", String(x));
  el.style.setProperty("--ey", String(y));
}

function flush() {
  frame = 0;
  const p = pointer;
  const reads: Array<[HTMLElement, number, number]> = [];
  for (const el of followers) {
    if (!p) {
      reads.push([el, 0, 0]);
      continue;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    const dx = p.x - (r.left + r.width / 2);
    const dy = p.y - (r.top + r.height * 0.58);
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) {
      reads.push([el, 0, 0]);
      continue;
    }
    const m = Math.min(1, dist / (r.width * 0.9 + 36));
    reads.push([el, (dx / dist) * m * EYE_TRAVEL_X, (dy / dist) * m * EYE_TRAVEL_Y]);
  }
  for (const [el, x, y] of reads) write(el, x, y);
}

function schedule() {
  if (frame === 0) frame = requestAnimationFrame(flush);
}

function onMove(event: PointerEvent) {
  pointer = { x: event.clientX, y: event.clientY };
  schedule();
}

function onLeave() {
  pointer = null;
  schedule();
}

function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("pointermove", onMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onLeave, { passive: true });
}

function unlisten() {
  if (!listening) return;
  listening = false;
  document.removeEventListener("pointermove", onMove);
  document.documentElement.removeEventListener("pointerleave", onLeave);
  if (frame !== 0) cancelAnimationFrame(frame);
  frame = 0;
  pointer = null;
}

/** Start steering `el`'s eyes toward the pointer. Returns the cleanup. */
export function followPointer(el: HTMLElement): () => void {
  followers.add(el);
  listen();
  return () => {
    followers.delete(el);
    el.style.removeProperty("--ex");
    el.style.removeProperty("--ey");
    lastWritten.delete(el);
    if (followers.size === 0) unlisten();
  };
}
