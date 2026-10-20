/**
 * Adapters from whatever the runtime's memory facade returns onto the Blobs wire shapes (`@kora/contracts`
 * `BlobFact` / `MemoryReceipt` / `BlobEpisodeHit`). The runtime memory module speaks `Fact { source: {threadId,
 * messageId}, until?: number, blobId?: string }` and `Receipt { kind: 'pending', factId: '' }`; the wire needs
 * required, nullable fields and `held` instead of `pending`. Already-wire input passes through unchanged, so the
 * facade may be written either way. Every output is a plain JSON value (no `undefined` anywhere).
 */
import type { BlobCardPayload, BlobEpisodeHit, BlobFact, MemoryReceipt } from "@kora/contracts";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const scopeOf = (v: unknown): BlobFact["scope"] =>
  v === "you" || v === "team" || v === "blob" ? v : "blob";

export function toWireFact(raw: unknown): BlobFact {
  const f = rec(raw);
  const source = rec(f.source);
  return {
    id: str(f.id),
    scope: scopeOf(f.scope),
    blobId: strOrNull(f.blobId),
    text: str(f.text),
    since: num(f.since),
    until: numOrNull(f.until),
    confidence: num(f.confidence, 1),
    important: f.important === true,
    sourceThreadId: strOrNull(f.sourceThreadId) ?? strOrNull(source.threadId),
    sourceMessageId: strOrNull(f.sourceMessageId) ?? strOrNull(source.messageId),
    lastUsedAt: numOrNull(f.lastUsedAt),
  };
}

export function toWireReceipt(raw: unknown): MemoryReceipt {
  const r = rec(raw);
  const kind = r.kind === "pending" ? "held" : r.kind;
  return {
    id: str(r.id),
    kind:
      kind === "added" || kind === "updated" || kind === "retired" || kind === "held"
        ? kind
        : "added",
    scope: scopeOf(r.scope),
    text: str(r.text),
    previousText: strOrNull(r.previousText),
    factId: strOrNull(r.factId),
    undone: r.undone === true,
    reason: strOrNull(r.reason),
  };
}

export function toWireEpisode(raw: unknown): BlobEpisodeHit {
  const e = rec(raw);
  return {
    threadId: str(e.threadId),
    title: str(e.title),
    summary: str(e.summary) || str(e.snippet) || str(e.text),
    at: num(e.at),
    score: num(e.score),
  };
}

/** One-line chat summary of a turn's receipts, for the `blob.card` activity row ("Remembered: ..."). */
function receiptsSummary(receipts: ReadonlyArray<MemoryReceipt>): string {
  const first = receipts[0];
  if (!first) return "Memory updated";
  const verb =
    first.kind === "retired"
      ? "Forgot"
      : first.kind === "held"
        ? "Wants to remember"
        : first.kind === "updated"
          ? "Updated"
          : "Remembered";
  const more = receipts.length > 1 ? ` (+${receipts.length - 1} more)` : "";
  const text = first.text.length > 120 ? `${first.text.slice(0, 117)}...` : first.text;
  return `${verb}: ${text}${more}`;
}

/** The one-line summary a `blob.card` activity row carries (the client renders the card from the payload). */
export function cardSummary(card: BlobCardPayload): string {
  switch (card.cardKind) {
    case "memory":
      return receiptsSummary(card.receipts);
    case "job":
      return `Job: ${card.title}`;
    case "proposal":
      return `Blob proposal: ${card.draft.name}`;
    case "confirm":
      return card.summary;
    case "self-change":
      return card.what;
    case "rate-limit":
      return `${card.engine} is rate limited`;
    case "routine-report":
      return `${card.title}: ${card.status === "completed" ? "done" : card.status}`;
    case "routine-confirm":
      return card.summary;
    case "app-connect":
      return card.reason === "not_connected"
        ? `${card.toolkit} is not connected`
        : `${card.toolkit} is not allowed here`;
  }
}
