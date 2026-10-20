import { useSyncExternalStore } from "react";

/**
 * A UI clock quantised to the minute ("YYYY-MM-DDTHH:MM", UTC). A single module-level timer serves
 * every subscriber and only exists while somebody is listening.
 */

const MINUTE_MS = 60_000;

const readMinute = (): string => new Date().toISOString().slice(0, 16);

type Ticker = { handle: number; repeating: boolean };

const clock = {
  minute: readMinute(),
  ticker: null as Ticker | null,
  subscribers: new Set<() => void>(),
};

function advance(): void {
  const fresh = readMinute();
  if (fresh === clock.minute) return;
  clock.minute = fresh;
  clock.subscribers.forEach((notify) => notify());
}

function startTicker(): void {
  // The first tick lands on the next minute boundary; afterwards a plain 60s interval. Each tick
  // re-reads the wall clock, so a throttled or late timer corrects itself when it fires.
  const untilBoundary = MINUTE_MS - (Date.now() % MINUTE_MS);
  const ticker: Ticker = { handle: 0, repeating: false };
  ticker.handle = window.setTimeout(() => {
    advance();
    ticker.repeating = true;
    ticker.handle = window.setInterval(advance, MINUTE_MS);
  }, untilBoundary);
  clock.ticker = ticker;
}

function stopTicker(): void {
  const { ticker } = clock;
  if (!ticker) return;
  clock.ticker = null;
  if (ticker.repeating) window.clearInterval(ticker.handle);
  else window.clearTimeout(ticker.handle);
}

function subscribe(listener: () => void): () => void {
  if (clock.subscribers.size === 0) startTicker();
  clock.subscribers.add(listener);
  return () => {
    clock.subscribers.delete(listener);
    if (clock.subscribers.size === 0) stopTicker();
  };
}

function getSnapshot(): string {
  // Without a running timer (nobody subscribed yet, e.g. the first render after a full unmount) the
  // stored minute may be stale, so re-read it. While the timer runs the stored value is returned
  // untouched, as useSyncExternalStore requires between change notifications.
  if (clock.ticker === null) clock.minute = readMinute();
  return clock.minute;
}

export function useNowMinute(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
