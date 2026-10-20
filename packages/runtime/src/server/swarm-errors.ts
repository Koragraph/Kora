// Swarm errors. SwarmNotReadyError is REAL (frozen in W0): SwarmService.spawn throws it when setup is incomplete, and
// kora_spawn returns its message as the tool's isError text so the leader explains the fix instead of doing the task.
import type { SwarmBlocker } from '../protocol/types';

export class SwarmNotReadyError extends Error {
  readonly blockers: SwarmBlocker[];
  /** Epoch ms when the next cooling model frees up (only meaningful with an `all-models-cooling` blocker). */
  readonly nextFreeAt: number | null;

  constructor(blockers: SwarmBlocker[], opts: { nextFreeAt?: number | null } = {}) {
    const what = blockers.length ? blockers.map((b) => b.message).join('; ') : 'setup is incomplete';
    const cooling = blockers.some((b) => b.code === 'all-models-cooling') && opts.nextFreeAt != null
      ? ` Next model frees up at ${new Date(opts.nextFreeAt).toLocaleTimeString()}.`
      : '';
    super(
      `swarm unavailable: ${what}. Tell the user what is missing and that they can fix it in Settings → Swarm or with ` +
      '`kora swarm setup`. Do not do this task on your own tokens without asking. In Stretch you can hand the slice to the cheap paid tier instead: ' +
      "kora_ask_workers (claude Haiku or codex Luna), then kora_spawn it; the user's Stretch button approves that." +
      cooling,
    );
    this.name = 'SwarmNotReadyError';
    this.blockers = blockers;
    this.nextFreeAt = opts.nextFreeAt ?? null;
  }
}
