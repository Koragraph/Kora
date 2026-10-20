// Group chat threads (docs/bots/GROUPS.md): the pure pieces the chat engine uses to turn a thread's message rows into the
// shared transcript the runtime's GroupOrchestrator reads, and a member's provider-session messages into its reply.
// A group thread is ONE Kora thread (what the person sees); each member runs in its own hidden thread keyed (group thread, blob).
import type { ThreadMessage } from "@kora/contracts";

/** Structural twin of the runtime's `GroupMessage` (groups/types.ts). */
export interface GroupMessageLike {
  id: string;
  seq: number;
  authorId: string;
  authorName: string;
  text: string;
  to: string[];
  ts: number;
  kind: "message" | "note";
}

/** The key of a member's hidden provider thread inside one group thread. */
export const memberThreadKey = (groupThreadId: string, blobId: string): string => `${groupThreadId}\u0000${blobId}`;

/**
 * The shared transcript of a group thread. `seq` is the row's position (1-based) in the thread's message list, which only
 * ever grows, so a message keeps its seq for ever. A reply still streaming is not part of the transcript yet.
 */
export function groupMessagesOf(
  messages: readonly ThreadMessage[],
  nameOf: (blobId: string) => string,
): GroupMessageLike[] {
  const out: GroupMessageLike[] = [];
  messages.forEach((m, i) => {
    if (m.streaming) return;
    const ts = Date.parse(m.createdAt) || 0;
    if (m.kind === "note") {
      out.push({ id: m.id, seq: i + 1, authorId: "system", authorName: "Kora", text: m.text, to: [], ts, kind: "note" });
      return;
    }
    if (m.role === "user") {
      out.push({ id: m.id, seq: i + 1, authorId: "user", authorName: "You", text: m.text, to: [...(m.to ?? [])], ts, kind: "message" });
      return;
    }
    if (m.role === "assistant" && m.authorBlobId) {
      out.push({ id: m.id, seq: i + 1, authorId: m.authorBlobId, authorName: nameOf(m.authorBlobId), text: m.text, to: [...(m.to ?? [])], ts, kind: "message" });
    }
  });
  return out;
}

/** What a member said in its own session since `fromIndex`: its assistant messages in order, as one reply. */
export function memberReplyText(messages: readonly ThreadMessage[], fromIndex: number): string {
  return messages
    .slice(Math.max(0, fromIndex))
    .filter((m) => m.role === "assistant" && !m.notice && m.text.trim().length > 0)
    .map((m) => m.text.trim())
    .join("\n\n");
}

/** A member's failure in the words the group's note uses ("could not answer: ..."): one short sentence, no stack. */
export function friendlyMemberError(error: string): string {
  const first = error.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  const clipped = first.length > 140 ? `${first.slice(0, 139).trimEnd()}...` : first;
  return clipped || "it failed";
}
