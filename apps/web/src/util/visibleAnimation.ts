type AnimatedElement = HTMLElement | SVGElement;

interface Tracked {
  element: AnimatedElement;
  intersecting: boolean;
  /** Script-driven animations (sprite frame player) get told instead of / as well as the CSS vars. */
  onChange?: ((running: boolean) => void) | undefined;
}

const STATE_VAR = "--visible-animation-state";
const WILL_CHANGE_VAR = "--visible-animation-will-change";

// One observer / media listener / visibility listener is shared by every tracked element.
const tracked = new Map<Element, Tracked>();
let observer: IntersectionObserver | null = null;
let motionQuery: MediaQueryList | null = null;

function apply(entry: Tracked, running: boolean): void {
  entry.onChange?.(running);
  entry.element.style.setProperty(STATE_VAR, running ? "running" : "paused");
  entry.element.style.setProperty(WILL_CHANGE_VAR, running ? "transform" : "auto");
}

// Fail-open: an element animates unless it is KNOWN to be off screen or motion is reduced. Gating on
// document.visibilityState (and waiting for a first intersection callback) froze every work-row trace and spinner
// whenever the window reported "hidden" or the callback came late (Electron); the browser already stops animations
// in a hidden page by itself.
function evaluate(entry: Tracked): void {
  const running = entry.intersecting && !motionQuery?.matches;
  apply(entry, running);
}

function evaluateAll(): void {
  for (const entry of tracked.values()) evaluate(entry);
}

function ensureShared(): void {
  if (observer) return;
  const created = new IntersectionObserver((entries) => {
    if (observer !== created) return; // callback from a torn-down observer
    for (const e of entries) {
      const entry = tracked.get(e.target);
      if (!entry) continue;
      entry.intersecting = e.isIntersecting;
      evaluate(entry);
    }
  });
  observer = created;
  motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  motionQuery.addEventListener("change", evaluateAll);
}

function teardownShared(): void {
  observer?.disconnect();
  observer = null;
  motionQuery?.removeEventListener("change", evaluateAll);
  motionQuery = null;
}

/** Runs an element's animations unless it is scrolled off screen or the user asked for reduced motion. */
export function watchVisibleAnimation(
  element: AnimatedElement | null,
  onChange?: (running: boolean) => void,
): (() => void) | undefined {
  if (!element) return undefined;
  const entry: Tracked = { element, intersecting: true, onChange };
  if (typeof IntersectionObserver === "undefined") {
    apply(entry, !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    return undefined;
  }

  ensureShared();
  evaluate(entry);
  tracked.set(element, entry);
  observer!.observe(element);

  return () => {
    if (tracked.get(element) !== entry) return;
    tracked.delete(element);
    observer?.unobserve(element);
    apply(entry, false);
    if (tracked.size === 0) teardownShared();
  };
}
