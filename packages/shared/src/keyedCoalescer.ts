/**
 * KeyedCoalescingWorker - A keyed worker that keeps only the latest value per key.
 *
 * Enqueues for an active or already-queued key are merged atomically instead of
 * creating duplicate queued items. `drainKey()` resolves only when that key has
 * no queued, pending, or active work left.
 *
 * @module KeyedCoalescingWorker
 */
import * as Effect from "effect/Effect";

export interface KeyedCoalescingWorker<K, V> {
  readonly drainKey: (key: K) => Effect.Effect<void>;
  readonly enqueue: (key: K, value: V) => Effect.Effect<void>;
}
