// @effect-diagnostics globalDate:off nodeBuiltinImport:off -- plain wall clock + child_process at the daemon boundary.
/**
 * Ruling 10: when no UI websocket client is connected and a blob thread settles or needs an approval / an answer, post a
 * quiet macOS notification through `osascript`. The text is generic ("Popo is done"): it never carries thread titles,
 * message text, file names or anything else the user typed. Rate-limited per thread and globally.
 */
import * as NodeChildProcess from "node:child_process";

export type BlobAttentionKind = "settled" | "needs-you" | "failed";

export interface BlobNotifierOptions {
  /** Connected UI websocket clients. Notify only at 0. */
  clients: () => number;
  /** The blob's display name, or null when it is gone. */
  nameOf: (blobId: string) => string | null;
  /** Post the notification (defaults to osascript on macOS). */
  post?: (title: string, body: string) => void;
  now?: () => number;
  /** Same thread + same kind: at most one per this many ms (default 2 min). */
  perThreadGapMs?: number;
  /** Any two notifications: at least this far apart (default 8 s). */
  globalGapMs?: number;
  /** At most this many per rolling 10 minutes (default 6). */
  burst?: number;
  enabled?: () => boolean;
}

/** The notification text for an event: blob name + a fixed phrase, nothing else. */
export function notificationText(
  name: string,
  kind: BlobAttentionKind,
): { title: string; body: string } {
  const safe =
    [...name]
      .map((ch) => (ch.charCodeAt(0) < 32 || ch === '"' || ch === "\\" ? " " : ch))
      .join("")
      .trim()
      .slice(0, 40) || "A blob";
  const body =
    kind === "needs-you"
      ? `${safe} needs you.`
      : kind === "failed"
        ? `${safe} hit a problem.`
        : `${safe} is done.`;
  return { title: "Kora", body };
}

function osascriptPost(title: string, body: string): void {
  // No osascript off macOS: execFile reports ENOENT to the (ignored) callback. Values travel as argv items, never spliced into the script text.
  NodeChildProcess.execFile(
    "osascript",
    [
      "-e",
      "on run argv",
      "-e",
      "display notification (item 1 of argv) with title (item 2 of argv)",
      "-e",
      "end run",
      body,
      title,
    ],
    { timeout: 5000 },
    () => {
      /* a missing permission or osascript is not worth a log line */
    },
  );
}

export function makeBlobNotifier(o: BlobNotifierOptions) {
  const now = o.now ?? Date.now;
  const post = o.post ?? osascriptPost;
  const perThreadGap = o.perThreadGapMs ?? 120_000;
  const globalGap = o.globalGapMs ?? 8_000;
  const burst = o.burst ?? 6;
  const lastByKey = new Map<string, number>();
  const recent: number[] = [];
  let lastAny = 0;
  return (e: { threadId: string; blobId: string; kind: BlobAttentionKind }): boolean => {
    if (o.enabled && !o.enabled()) return false;
    if (o.clients() > 0) return false;
    const name = o.nameOf(e.blobId);
    if (!name) return false;
    const t = now();
    const key = `${e.threadId}:${e.kind}`;
    if (t - (lastByKey.get(key) ?? -Infinity) < perThreadGap) return false;
    if (t - lastAny < globalGap) return false;
    while (recent.length && t - recent[0]! > 600_000) recent.shift();
    if (recent.length >= burst) return false;
    lastByKey.set(key, t);
    if (lastByKey.size > 200) lastByKey.delete(lastByKey.keys().next().value as string);
    lastAny = t;
    recent.push(t);
    const { title, body } = notificationText(name, e.kind);
    try {
      post(title, body);
    } catch {
      /* advisory */
    }
    return true;
  };
}
