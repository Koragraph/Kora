import * as Result from "effect/Result";
import * as Encoding from "effect/Encoding";
import { formatReplyFootnoteHref, parseReplyFootnoteHref } from "@kora/shared/assistantFootnotes";
import type { ReplyFootnote } from "@kora/contracts";

import { randomUUID } from "./utils";

declare module "@tanstack/react-router" {
  interface HistoryState {
    assistantCitationActivation?: string;
  }
}

const FOOTNOTE_HASH_PREFIX = "assistant-citation=";

/** Base64url keeps router hash normalization from decoding quote whitespace or source IDs. */
export function replyFootnoteHash(citation: ReplyFootnote) {
  return `${FOOTNOTE_HASH_PREFIX}${Encoding.encodeBase64Url(formatReplyFootnoteHref(citation))}`;
}

export function replyFootnoteFromLocation(linkTarget: string) {
  const hashIndex = linkTarget.indexOf("#");
  if (hashIndex === -1) return null;
  const hash = linkTarget.slice(hashIndex + 1);
  if (!hash.startsWith(FOOTNOTE_HASH_PREFIX) || hash.length > 140_000) return null;
  try {
    return parseReplyFootnoteHref(
      Result.getOrThrow(Encoding.decodeBase64UrlString(hash.slice(FOOTNOTE_HASH_PREFIX.length))),
    );
  } catch {
    return null;
  }
}

/** A fresh activation lets the same link reveal its source again after dismissal. */
export function replyFootnoteNavigation(citation: ReplyFootnote) {
  return {
    to: "/$hostId/$threadId" as const,
    params: { hostId: citation.hostId, threadId: citation.threadId },
    hash: replyFootnoteHash(citation),
    resetScroll: false,
    state: { assistantCitationActivation: randomUUID() },
  };
}
