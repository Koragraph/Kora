import { Atom } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";

import { koraAtomRegistry } from "./atomRegistry";

export interface SlowRpcAckRequest {
  readonly thresholdMs: number;
  readonly tag: string;
  readonly startedAtMs: number;
  readonly startedAt: string;
  readonly requestId: string;
}

const SLOW_THRESHOLD_MS = 15_000;
const MAX_TRACKED = 256;

const slowRequestsAtom = Atom.make<ReadonlyArray<SlowRpcAckRequest>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("slow-rpc-ack-requests"),
);

// requestId -> timer; insertion order doubles as age for eviction.
const pending = new Map<string, ReturnType<typeof setTimeout>>();

const setSlow = (
  change: (live: ReadonlyArray<SlowRpcAckRequest>) => ReadonlyArray<SlowRpcAckRequest>,
) => koraAtomRegistry.set(slowRequestsAtom, change(koraAtomRegistry.get(slowRequestsAtom)));

function stopTimer(reqKey: string): void {
  const tmr = pending.get(reqKey);
  if (tmr === undefined) return;
  clearTimeout(tmr);
  pending.delete(reqKey);
}

export function trackRpcRequestSent(reqKey: string, verb: string, marker: string = verb): void {
  // Subscriptions are open-ended by design; only unary calls can be "slow".
  if (verb.includes("subscribe")) return;
  stopTimer(reqKey);
  while (pending.size >= MAX_TRACKED) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    stopTimer(oldest);
  }

  const startedAtMs = Date.now();
  const slow: SlowRpcAckRequest = {
    requestId: reqKey,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    tag: marker,
    thresholdMs: SLOW_THRESHOLD_MS,
  };
  pending.set(
    reqKey,
    setTimeout(() => {
      pending.delete(reqKey);
      setSlow((live) => [...live, slow].slice(-MAX_TRACKED));
    }, SLOW_THRESHOLD_MS),
  );
}

export function acknowledgeRpcRequest(reqKey: string): void {
  stopTimer(reqKey);
  // A late reply dismisses the warning.
  setSlow((live) =>
    live.some((res) => res.requestId === reqKey)
      ? live.filter((res) => res.requestId !== reqKey)
      : live,
  );
}

export function useSlowRpcAckRequests(): ReadonlyArray<SlowRpcAckRequest> {
  return useAtomValue(slowRequestsAtom);
}

function resetRequestLatencyStateForTests(): void {
  for (const tmr of pending.values()) clearTimeout(tmr);
  pending.clear();
  koraAtomRegistry.set(slowRequestsAtom, []);
}
