// Author names for a group transcript. A blob thread has ONE author (the transcript wears a single BlobSkin); a group has
// many, so bubble bursts must split when the author changes and each assistant row needs its own skin. Pure helpers: the
// transcript passes `authorOf(message)` (the message's `authorBlobId`, WIRING.md) and gets bursts back.
import type { TranscriptRowEntry } from "../../thread/ThreadTranscript.logic";
import type { BlobSkin } from "../chat/blobSkin";
import { deriveBubbleGroups, type BubbleGroups, type BubblePosition } from "../transcript/grouping";
import type { GroupMember } from "./groupModel";

export type AuthorOf = (messageId: string, role: "user" | "assistant") => string | null;

/** `deriveBubbleGroups`, then split every burst wherever the author changes (Popo's replies never join Junip's bubble). */
export function deriveAuthorBubbleGroups(
  rows: ReadonlyArray<TranscriptRowEntry>,
  authorOf: AuthorOf,
): BubbleGroups {
  const base = deriveBubbleGroups(rows);
  const out = new Map<string, BubblePosition>();
  let run: Array<{ id: string; streaming: boolean }> = [];
  let runRole: "user" | "assistant" = "assistant";
  let runAuthor: string | null = null;

  const flush = () => {
    const streaming = run.some((r) => r.streaming);
    run.forEach((r, i) => {
      out.set(r.id, { role: runRole, first: i === 0, last: i === run.length - 1, streaming });
    });
    run = [];
  };

  for (const row of rows) {
    if (row.kind !== "message") continue;
    const position = base.get(row.id);
    if (position === undefined) continue;
    const author = authorOf(row.id, position.role);
    if (position.first || author !== runAuthor) flush();
    runRole = position.role;
    runAuthor = author;
    run.push({ id: row.id, streaming: Boolean(row.message.streaming) });
    if (position.last) {
      flush();
      runAuthor = null;
    }
  }
  flush();
  return out;
}

function skinOfMember(m: GroupMember): BlobSkin {
  return { blobId: m.id, name: m.name, title: m.title, outfit: m.outfit, chief: m.chief };
}

/** The skin for a message's author; falls back to a neutral "Someone" so a deleted blob's old replies still render. */
export function skinForAuthor(
  authorBlobId: string | null,
  byId: ReadonlyMap<string, GroupMember>,
): BlobSkin {
  const m = authorBlobId ? byId.get(authorBlobId) : undefined;
  if (m) return skinOfMember(m);
  return {
    blobId: authorBlobId ?? "unknown",
    name: "Former member",
    title: "",
    outfit: {},
    chief: false,
  };
}
