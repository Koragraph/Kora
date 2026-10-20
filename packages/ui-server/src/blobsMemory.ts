// @effect-diagnostics globalDate:off -- plain wall-clock read for a forgotten fact's `until`.
/**
 * The Memory tab's operations over the runtime's memory facade (the async twin of the memory module's `MemoryStore`),
 * returning Blobs wire shapes. The facade speaks the module's own types (`Fact { source: {threadId, messageId} }`,
 * `Receipt { kind: 'pending', pendingId }`, `undo(): boolean`, `forgetFact()` that deletes), so this is where those become
 * `BlobFact` / `MemoryReceipt` / `BlobEpisodeHit`. Errors are plain `Error`s with a `code` the handler turns into a
 * `BlobError`.
 */
import type { BlobEpisodeHit, BlobFact, BlobMemoryScope, MemoryReceipt } from "@kora/contracts";

import { toWireEpisode, toWireFact, toWireReceipt } from "./blobsWire.ts";
import type { KoraBlobMemoryLike } from "./host.ts";

type Rec = Record<string, unknown>;

class MemoryOpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MemoryOpError";
    this.code = code;
  }
}

const notFound = (what: string) => new MemoryOpError("not_found", `${what} could not be found.`);

export async function listMemory(
  memory: KoraBlobMemoryLike,
  i: { scope: BlobMemoryScope; blobId: string | null; includeRetired: boolean },
): Promise<{ facts: BlobFact[]; core: string; held: MemoryReceipt[] }> {
  const facts = await memory.listFacts({
    scope: i.scope,
    ...(i.scope === "blob" && i.blobId ? { blobId: i.blobId } : {}),
    includeRetired: i.includeRetired,
  });
  let core = "";
  if (i.scope === "team") core = (await memory.getTeamCore?.()) ?? "";
  else {
    const notes = await memory.getCore(i.blobId ?? "");
    core = i.scope === "you" ? notes.you : notes.blob;
  }
  return {
    facts: (facts ?? []).map(toWireFact),
    core: core ?? "",
    held: await heldIn(memory, i),
  };
}

/**
 * The open held-for-your-OK items in `scope`, as `held` receipts. The id is the receipt that announced the item when
 * there is one (what the transcript card confirms), else the pending id (`confirmReceipt` accepts both).
 */
async function heldIn(
  memory: KoraBlobMemoryLike,
  i: { scope: BlobMemoryScope; blobId: string | null },
): Promise<MemoryReceipt[]> {
  if (!memory.listPending) return [];
  const pending = (await memory.listPending(i.blobId ? { blobId: i.blobId } : {})) as Rec[];
  const inScope = (pending ?? []).filter(
    (p) => p.scope === i.scope && (i.scope !== "blob" || !i.blobId || p.blobId === i.blobId),
  );
  if (inScope.length === 0) return [];
  const receipts = ((await memory.listReceipts({ limit: 500 })) as Rec[]) ?? [];
  return inScope.map((p) => {
    const announced = receipts.find((r) => r.pendingId === p.id);
    return toWireReceipt({
      id: typeof announced?.id === "string" ? announced.id : p.id,
      kind: "pending",
      scope: p.scope,
      text: p.text,
      reason: p.reason,
      undone: false,
    });
  });
}

export async function editFact(
  memory: KoraBlobMemoryLike,
  factId: string,
  text: string,
): Promise<BlobFact> {
  const clean = text.trim();
  if (!clean)
    throw new MemoryOpError("empty", "A memory needs some text. Use Forget to remove it.");
  let fact: unknown;
  try {
    fact = await memory.editFact(factId, { text: clean });
  } catch (cause) {
    throw new MemoryOpError("invalid_fact", String((cause as Error)?.message ?? cause));
  }
  if (!fact) throw notFound("That memory");
  return toWireFact(fact);
}

/** The module deletes a forgotten fact; the wire answers with it as it was, retired now. */
export async function forgetFact(memory: KoraBlobMemoryLike, factId: string): Promise<BlobFact> {
  const fact = await memory.getFact(factId);
  if (!fact) throw notFound("That memory");
  await memory.forgetFact(factId);
  const wire = toWireFact(fact);
  return { ...wire, until: wire.until ?? Date.now() };
}

export async function markImportant(
  memory: KoraBlobMemoryLike,
  factId: string,
  important: boolean,
): Promise<BlobFact> {
  await memory.markImportant(factId, important);
  const fact = await memory.getFact(factId);
  if (!fact) throw notFound("That memory");
  return toWireFact(fact);
}

export async function setCore(
  memory: KoraBlobMemoryLike,
  i: { scope: "you" | "blob"; blobId: string | null; text: string },
): Promise<string> {
  if (i.scope === "blob" && !i.blobId)
    throw new MemoryOpError("blob_required", "A blob's notes need a blob.");
  try {
    await memory.setCore(i.scope, i.blobId ?? "", i.text);
  } catch (cause) {
    const msg = String((cause as Error)?.message ?? cause);
    throw new MemoryOpError(/core note/.test(msg) ? "core_too_large" : "invalid_core", msg);
  }
  return i.text.trim();
}

export async function searchEpisodes(
  memory: KoraBlobMemoryLike,
  i: { blobId: string; query: string; limit: number },
): Promise<BlobEpisodeHit[]> {
  const hits = await memory.searchEpisodes({ blobId: i.blobId, query: i.query, limit: i.limit });
  return (hits ?? []).map(toWireEpisode);
}

/** A receipt as the module stores it (for a card that is not on screen), with its scope read off its fact. */
async function findReceipt(
  memory: KoraBlobMemoryLike,
  receiptId: string,
): Promise<{ wire: MemoryReceipt; pendingId: string } | null> {
  const rows = (await memory.listReceipts({ limit: 500 })) as Rec[];
  const row = (rows ?? []).find((r) => r.id === receiptId);
  if (!row) return null;
  const fact =
    typeof row.factId === "string" && row.factId
      ? ((await memory.getFact(row.factId)) as Rec | null)
      : null;
  return {
    wire: toWireReceipt({ ...row, scope: fact?.scope ?? row.scope }),
    pendingId: typeof row.pendingId === "string" && row.pendingId ? row.pendingId : receiptId,
  };
}

/** Undo a receipt's change; answers the receipt as the card should now show it (`undone: true`). */
export async function undoReceipt(
  memory: KoraBlobMemoryLike,
  receiptId: string,
  shown: MemoryReceipt | null,
): Promise<MemoryReceipt> {
  const found = shown ? null : await findReceipt(memory, receiptId);
  const prev = shown ?? found?.wire ?? null;
  if (!prev) throw notFound("That memory change");
  if (prev.undone) return prev;
  const ok = await memory.undo(receiptId);
  if (ok === false)
    throw new MemoryOpError(
      "not_undoable",
      "That change can't be undone any more (it was edited or replaced since).",
    );
  return { ...prev, undone: true };
}

/** Answer a held receipt: save it (the module approves the pending item) or decline it. */
export async function confirmReceipt(
  memory: KoraBlobMemoryLike,
  receiptId: string,
  save: boolean,
  shown: MemoryReceipt | null,
): Promise<MemoryReceipt> {
  const found = await findReceipt(memory, receiptId);
  const prev = shown ?? found?.wire ?? null;
  if (!prev) throw notFound("That memory");
  const pendingId = found?.pendingId ?? receiptId;
  if (!save) {
    await memory.rejectPending(pendingId);
    return { ...prev, undone: true };
  }
  const saved = (await memory.approvePending(pendingId)) as Rec | null;
  if (!saved)
    throw new MemoryOpError("already_decided", "That memory was already saved or declined.");
  const wire = toWireReceipt(saved);
  return {
    ...prev,
    // The approval is a real change with its own receipt: the card's line becomes that receipt, so Undo works on it.
    ...(wire.id ? { id: wire.id } : {}),
    kind: wire.kind === "held" ? "added" : wire.kind,
    factId: wire.factId ?? prev.factId,
    text: wire.text || prev.text,
    reason: null,
    undone: false,
  };
}
