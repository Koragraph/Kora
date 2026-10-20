// A blob's roster state, derived on the client from its threads' status dots (no status stream: ARCH D9).
// One status word + the avatar's motion state + the flags the roster needs (unread dot, working count).
import type { BlobVisualState } from "~/components/blobs/avatar";
import { rollupThreadDots, type ThreadDot, type ThreadDotTone } from "../../ThreadNav.logic";

export type BlobStatusWord = "idle" | "working" | "needs you" | "asking" | "error" | "paused";

export interface BlobStatus {
  readonly word: BlobStatusWord;
  readonly visual: BlobVisualState;
  /** The tone of the most urgent thread (TONE_PRIORITY), or "idle" when nothing needs a look. */
  readonly tone: ThreadDotTone;
  /** A thread finished while the user was away (green dot). */
  readonly unread: boolean;
  /** At least one thread is running a turn: counts toward the "several blobs at once" warning. */
  readonly working: boolean;
  /** The blob is blocked on the user (approval, a question, a plan to review). */
  readonly needsYou: boolean;
}

const BY_TONE: Record<ThreadDotTone, { word: BlobStatusWord; visual: BlobVisualState }> = {
  offline: { word: "paused", visual: "offline" },
  approval: { word: "needs you", visual: "waiting" },
  input: { word: "asking", visual: "waiting" },
  plan: { word: "needs you", visual: "waiting" },
  failed: { word: "error", visual: "failed" },
  working: { word: "working", visual: "working" },
  unread: { word: "idle", visual: "idle" },
  monitoring: { word: "idle", visual: "idle" },
  idle: { word: "idle", visual: "idle" },
};

/**
 * Dots are newest thread first. A thread whose last turn failed stops counting once a NEWER thread of the same blob went
 * fine (the blob recovered): otherwise one failure from before a restart kept the roster at "error" for good.
 */
export function withoutRecoveredFailures(dots: ReadonlyArray<ThreadDot>): ThreadDot[] {
  const out: ThreadDot[] = [];
  let recovered = false;
  for (const d of dots) {
    if (d.tone === "failed") {
      if (!recovered) out.push(d);
      continue;
    }
    if (d.tone === "idle" || d.tone === "unread" || d.tone === "monitoring" || d.tone === "working")
      recovered = true;
    out.push(d);
  }
  return out;
}

export function deriveBlobStatus(allDots: ReadonlyArray<ThreadDot>): BlobStatus {
  const dots = withoutRecoveredFailures(allDots);
  const top = rollupThreadDots(dots);
  const tone: ThreadDotTone = top?.tone ?? "idle";
  const base = BY_TONE[tone];
  return {
    word: base.word,
    visual: base.visual,
    tone,
    unread: dots.some((d) => d.tone === "unread"),
    working: dots.some((d) => d.tone === "working"),
    needsYou: dots.some((d) => d.tone === "approval" || d.tone === "input" || d.tone === "plan"),
  };
}

/** How many blobs have a turn running right now. */
export function countWorkingBlobs(statuses: Iterable<BlobStatus>): number {
  let n = 0;
  for (const s of statuses) if (s.working) n += 1;
  return n;
}

/**
 * The warning the user sees when starting work on one more blob while two are already working
 * ("Several blobs at once can hit your plan's limits"). `startingBlobId` is the blob about to run; a blob that is
 * already working does not add to the count.
 */
export function shouldWarnConcurrency(input: {
  readonly workingBlobIds: ReadonlySet<string>;
  readonly startingBlobId: string;
  readonly dismissed: boolean;
  /**
   * Blobs on a paid plan (Claude / Codex). The warning is about plan limits, so only they count: free models have
   * their own quotas and a free blob neither triggers the warning nor adds to it. Omitted = every blob counts.
   */
  readonly paidBlobIds?: ReadonlySet<string>;
}): boolean {
  if (input.dismissed) return false;
  if (input.workingBlobIds.has(input.startingBlobId)) return false;
  if (input.paidBlobIds) {
    if (!input.paidBlobIds.has(input.startingBlobId)) return false;
    let working = 0;
    for (const id of input.workingBlobIds) if (input.paidBlobIds.has(id)) working += 1;
    return working >= 2;
  }
  return input.workingBlobIds.size >= 2;
}

/** The blobs whose engine runs on the user's own Claude / Codex plan (everything but the free OpenCode models). */
export function paidBlobIdsOf(
  blobs: ReadonlyArray<{ readonly id: string; readonly engine: { readonly instanceId: string } }>,
): Set<string> {
  return new Set(blobs.filter((b) => !b.engine.instanceId.startsWith("opencode")).map((b) => b.id));
}
