/** Rows that belong to Kora's assistants (blobs): their cards, their helpers, their approval requests. */
import type { ChatThreadActivity } from "@kora/contracts";

import type { Row } from "./entries";
import { fields, text } from "./read";

const blobCardEntryCache = new WeakMap<ChatThreadActivity, Row>();

/** How a blob's approval request ended: read from the `approval.resolved` (or stale-failure) activity of the same request. */
export function approvalOutcomes(ranked: ReadonlyArray<ChatThreadActivity>): Map<string, string> {
  const acc = new Map<string, string>();
  for (const act of ranked) {
    if (act.kind !== "approval.resolved" && act.kind !== "provider.approval.respond.failed")
      continue;
    const payload = fields(act.payload);
    const reqKey = text(payload?.requestId);
    if (!reqKey) continue;
    if (act.kind === "approval.resolved") {
      const decision = text(payload?.decision);
      acc.set(
        reqKey,
        decision === "acceptAlways"
          ? "always"
          : decision === "accept" || decision === "acceptForSession"
            ? "allowed"
            : decision === "decline"
              ? "denied"
              : "cancelled",
      );
    } else if (/stale|unknown pending/i.test(text(payload?.detail) ?? "") && !acc.has(reqKey))
      acc.set(reqKey, "expired");
  }
  return acc;
}

export const BLOB_HELPER_KINDS = new Set([
  "worker.attached",
  "worker.detached",
  "worker.steered",
  "worker.blocked",
  "worker.done",
  "worker.stopped",
  "worker.idle",
  "worker.report",
  "worker.respawned",
  "worker.rate-limited",
  "worker.bounced",
]);
const HELPER_ENDED_KINDS = new Set([
  "worker.done",
  "worker.detached",
  "worker.stopped",
  "worker.idle",
  "worker.report",
]);

interface HelperAggregate {
  readonly first: ChatThreadActivity;
  readonly paneIds: Set<string>;
  readonly ended: Set<string>;
  readonly titles: string[];
}

/** One aggregate per turn: the helpers a blob used in that turn, however many `worker.*` rows the daemon wrote for them. */
export function collectBlobHelpers(
  ranked: ReadonlyArray<ChatThreadActivity>,
): Map<string, HelperAggregate> | null {
  const acc = new Map<string, HelperAggregate>();
  for (const act of ranked) {
    if (!BLOB_HELPER_KINDS.has(act.kind)) continue;
    const payload = fields(act.payload);
    if (payload?.blobThread !== true) continue;
    const keyName = act.turnId ?? "none";
    let agg = acc.get(keyName);
    if (!agg) {
      agg = { first: act, paneIds: new Set(), ended: new Set(), titles: [] };
      acc.set(keyName, agg);
    }
    const pane = text(payload.paneId) ?? text(payload.taskId);
    if (pane) agg.paneIds.add(pane);
    if (pane && HELPER_ENDED_KINDS.has(act.kind)) agg.ended.add(pane);
    const title = text(payload.title);
    if (
      act.kind === "worker.attached" &&
      title &&
      agg.titles.length < 6 &&
      !agg.titles.includes(title)
    )
      agg.titles.push(title);
  }
  return acc.size ? acc : null;
}

const helperEntryCache = new WeakMap<ChatThreadActivity, { sig: string; entry: Row }>();

export function blobHelpersEntry(agg: HelperAggregate): Row {
  const tally = Math.max(1, agg.paneIds.size);
  const working = [...agg.paneIds].filter((paneId) => !agg.ended.has(paneId)).length;
  const sig = `${tally}|${working}|${agg.titles.join("\u0001")}`;
  const hit = helperEntryCache.get(agg.first);
  if (hit && hit.sig === sig) return hit.entry;
  const rec: Row = {
    id: agg.first.id,
    createdAt: agg.first.createdAt,
    turnId: agg.first.turnId,
    label: `${tally} helper${tally === 1 ? "" : "s"}`,
    tone: "info",
    sourceActivityKind: "blob.card",
    blobCard: {
      cardId: `helpers:${agg.first.turnId ?? agg.first.id}`,
      version: working,
      payload: { cardKind: "helpers", count: tally, working, titles: agg.titles },
    },
  };
  helperEntryCache.set(agg.first, { sig, entry: rec });
  return rec;
}

const approvalCardEntryCache = new WeakMap<ChatThreadActivity, Map<string, Row>>();

/** A blob's approval request as a transcript card (`cardKind: "approval"`); null for every other request. */
export function blobApprovalEntry(
  act: ChatThreadActivity,
  verdict: string | undefined,
): Row | null {
  const payload = fields(act.payload);
  if (payload?.blobThread !== true) return null;
  const reqKey = text(payload.requestId);
  if (!reqKey) return null;
  const stateKey = verdict ?? "open";
  const byState = approvalCardEntryCache.get(act) ?? new Map<string, Row>();
  approvalCardEntryCache.set(act, byState);
  const hit = byState.get(stateKey);
  if (hit) return hit;
  const rec: Row = {
    id: act.id,
    createdAt: act.createdAt,
    turnId: act.turnId,
    label: act.summary,
    tone: "info",
    sourceActivityKind: "blob.card",
    blobCard: {
      cardId: `approval:${reqKey}`,
      version: stateKey === "open" ? 1 : 2,
      payload: {
        ...payload,
        cardKind: "approval",
        requestId: reqKey,
        title: act.summary,
        state: stateKey,
      },
    },
  };
  byState.set(stateKey, rec);
  return rec;
}

function blobCardIdentity(act: ChatThreadActivity): { cardId: string; version: number } {
  const payload = fields(act.payload);
  const cardId = text(payload?.cardId) ?? act.id;
  const rawVersion = payload?.version;
  return { cardId, version: typeof rawVersion === "number" ? rawVersion : 0 };
}

/**
 * `blob.card` activities are re-emitted with a higher `version` when a card changes (a memory receipt is undone, a
 * job step finishes). The transcript shows ONE row per `cardId`: it keeps the position of the first emission and
 * the payload of the highest version (later emission wins a tie).
 */
export function collectBlobCards(ranked: ReadonlyArray<ChatThreadActivity>) {
  const head = new Map<string, ChatThreadActivity>();
  const latest = new Map<string, { activity: ChatThreadActivity; version: number }>();
  for (const act of ranked) {
    if (act.kind !== "blob.card") continue;
    const { cardId, version } = blobCardIdentity(act);
    if (!head.has(cardId)) head.set(cardId, act);
    const live = latest.get(cardId);
    if (live === undefined || version >= live.version)
      latest.set(cardId, { activity: act, version });
  }
  if (head.size === 0) return null;
  return {
    entryFor(act: ChatThreadActivity): Row | null {
      const { cardId } = blobCardIdentity(act);
      if (head.get(cardId) !== act) return null;
      const winner = latest.get(cardId)!;
      const cached = blobCardEntryCache.get(winner.activity);
      if (cached && cached.id === act.id) return cached;
      const payload = fields(winner.activity.payload);
      const rec: Row = {
        id: act.id,
        createdAt: act.createdAt,
        turnId: act.turnId,
        label: winner.activity.summary,
        tone: "info",
        sourceActivityKind: "blob.card",
        blobCard: { cardId, version: winner.version, payload: payload ?? {} },
      };
      blobCardEntryCache.set(winner.activity, rec);
      return rec;
    },
  };
}
