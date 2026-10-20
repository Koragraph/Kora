export const PAGE_SCROLL_MAX_MULTIPLIER = 2;
export const PAGE_SCROLL_ACCELERATION_MS = 400;
export const PAGE_SCROLL_ANIMATION_MS = 150;

/** Space kept between the paged-to position and the viewport edge. */
const PAGE_ALIGNMENT_OFFSET_PX = 36;
const EDGE_EPSILON_PX = 1;

export type PageScrollKey = "PageUp" | "PageDown";

export function getTranscriptPageScrollKey(event: {
  defaultPrevented: boolean;
  scrollHeight: number;
  isComposing: boolean;
  clientHeight: number;
  shiftKey: boolean;
  scrollTop: number;
  metaKey: boolean;
  ctrlKey: boolean;
  keyCode: number;
  altKey: boolean;
  key: string;
}): PageScrollKey | null {
  if (event.key !== "PageUp" && event.key !== "PageDown") return null;
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;

  // The focused editor keeps native paging until it reaches its own boundary.
  const maxScroll = Math.max(0, event.scrollHeight - event.clientHeight);
  const position = Math.min(Math.max(event.scrollTop, 0), maxScroll);
  const editorCanScroll =
    event.key === "PageUp" ? position > EDGE_EPSILON_PX : position < maxScroll - EDGE_EPSILON_PX;
  return editorCanScroll ? null : event.key;
}

export function getPageScrollMultiplier(holdElapsedMs: number): number {
  const progress = Math.min(Math.max(holdElapsedMs, 0) / PAGE_SCROLL_ACCELERATION_MS, 1);
  return 1 + progress * (PAGE_SCROLL_MAX_MULTIPLIER - 1);
}

export function getPageScrollVelocityPxPerMs(args: {
  pageScrollDistancePx: number;
  holdElapsedMs: number;
}): number {
  return (
    (args.pageScrollDistancePx * getPageScrollMultiplier(args.holdElapsedMs)) /
    PAGE_SCROLL_ANIMATION_MS
  );
}

export function getPageScrollDistancePx(args: {
  scrollPaddingBottomPx: number;
  containerHeightPx: number;
}): number {
  return Math.max(
    0,
    args.containerHeightPx - PAGE_ALIGNMENT_OFFSET_PX - args.scrollPaddingBottomPx,
  );
}

// CSS `ease-in-out`: cubic-bezier(0.42, 0, 0.58, 1), solved for x by Newton's method.
function easeInOut(progress: number): number {
  const x1 = 0.42;
  const y1 = 0;
  const x2 = 0.58;
  const y2 = 1;
  const coordinate = (t: number, p1: number, p2: number) =>
    3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t;
  const slope = (t: number, p1: number, p2: number) =>
    3 * (1 - t) * (1 - t) * p1 + 6 * (1 - t) * t * (p2 - p1) + 3 * t * t * (1 - p2);

  let t = progress;
  for (let step = 0; step < 5; step += 1) {
    const error = coordinate(t, x1, x2) - progress;
    if (Math.abs(error) < 1e-4) break;
    const derivative = slope(t, x1, x2);
    if (derivative === 0) break;
    t -= error / derivative;
  }
  return coordinate(Math.min(Math.max(t, 0), 1), y1, y2);
}

type ScrollContainer = {
  getBoundingClientRect: () => { height: number };
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
};

type ScrollEnv = {
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  setTimeout: (callback: () => void, delay: number) => number;
  cancelAnimationFrame: (handle: number) => void;
  clearTimeout: (handle: number) => void;
  now: () => number;
};

const browserEnv = (): ScrollEnv => ({
  now: () => performance.now(),
  clearTimeout: (handle) => window.clearTimeout(handle),
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
});

export function createPageScrollController(args: {
  getContainer: () => ScrollContainer | null;
  getScrollPaddingBottomPx: () => number;
  onScrollStart?: (key: PageScrollKey) => void;
  env?: ScrollEnv;
}) {
  const env = args.env ?? browserEnv();

  let activeKey: PageScrollKey | null = null;
  let holding = false;
  let discreteFrame: number | null = null;
  let holdFrame: number | null = null;
  let holdTimer: number | null = null;

  const pageDistance = (container: ScrollContainer) =>
    getPageScrollDistancePx({
      containerHeightPx: container.getBoundingClientRect().height,
      scrollPaddingBottomPx: args.getScrollPaddingBottomPx(),
    });

  const canScroll = (container: ScrollContainer, key: PageScrollKey) => {
    const max = container.scrollHeight - container.clientHeight;
    return key === "PageUp"
      ? container.scrollTop > EDGE_EPSILON_PX
      : container.scrollTop < max - EDGE_EPSILON_PX;
  };

  const cancelDiscrete = () => {
    if (discreteFrame !== null) env.cancelAnimationFrame(discreteFrame);
    discreteFrame = null;
  };

  const stop = (cancelDiscreteAnimation: boolean) => {
    if (holdTimer !== null) env.clearTimeout(holdTimer);
    holdTimer = null;
    if (holdFrame !== null) env.cancelAnimationFrame(holdFrame);
    holdFrame = null;
    if (cancelDiscreteAnimation) cancelDiscrete();
    holding = false;
    activeKey = null;
  };

  const startDiscrete = (container: ScrollContainer, direction: 1 | -1) => {
    const origin = container.scrollTop;
    const distance = pageDistance(container) * direction;
    const startedAt = env.now();
    const tick = () => {
      discreteFrame = null;
      const progress = Math.min((env.now() - startedAt) / PAGE_SCROLL_ANIMATION_MS, 1);
      container.scrollTop = origin + distance * easeInOut(progress);
      if (progress < 1) discreteFrame = env.requestAnimationFrame(tick);
    };
    discreteFrame = env.requestAnimationFrame(tick);
  };

  const startHold = (key: PageScrollKey) => {
    holding = true;
    const direction = key === "PageDown" ? 1 : -1;
    const holdStartedAt = env.now();
    let lastFrameAt = holdStartedAt;
    const tick = () => {
      holdFrame = null;
      if (activeKey !== key) return;
      const container = args.getContainer();
      if (!container) return stop(true);
      const now = env.now();
      const delta = now - lastFrameAt;
      lastFrameAt = now;
      const before = container.scrollTop;
      const velocity = getPageScrollVelocityPxPerMs({
        holdElapsedMs: now - holdStartedAt,
        pageScrollDistancePx: pageDistance(container),
      });
      container.scrollTop = before + velocity * delta * direction;
      if (delta > 0 && container.scrollTop === before) return stop(true);
      holdFrame = env.requestAnimationFrame(tick);
    };
    holdFrame = env.requestAnimationFrame(tick);
  };

  return {
    handleKeyDown(key: PageScrollKey) {
      const container = args.getContainer();
      if (!container || !canScroll(container, key) || activeKey === key) return;
      stop(true);
      activeKey = key;
      args.onScrollStart?.(key);
      startDiscrete(container, key === "PageDown" ? 1 : -1);
      holdTimer = env.setTimeout(() => {
        holdTimer = null;
        if (activeKey === key) startHold(key);
      }, PAGE_SCROLL_ANIMATION_MS);
    },
    handleKeyUp(key: string) {
      if (key !== activeKey) return;
      stop(holding);
    },
    releaseActiveKey() {
      if (activeKey === null) return;
      stop(holding);
    },
    dispose() {
      stop(true);
    },
  };
}
