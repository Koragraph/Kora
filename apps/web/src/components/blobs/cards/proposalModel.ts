// Defensive read of a `proposal` card payload (contracts: ProposalCardPayload) and the small rules the Proposal card
// needs: latest-version-wins, the look deck the avatar cycles through, and plain-language labels. Pure.
import type { BlobDraft, BlobPermission } from "@kora/contracts";

import { ACCESSORY_LABELS, STARTER_OUTFITS, type BlobOutfit } from "~/components/blobs/avatar";
import { toAvatarOutfit } from "../outfit";
import { engineLabel } from "../shell/engineLabel";
import type { BlobCardRef } from "../../../thread/timeline";

export type ProposalState = "open" | "hired" | "dismissed";

export interface ProposalView {
  readonly cardId: string;
  readonly version: number;
  readonly draft: BlobDraft;
  readonly state: ProposalState;
  readonly hiredBlobId: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];

const PERMISSIONS = new Set<string>(["ask", "auto", "full"]);

function parseDraft(value: unknown): BlobDraft {
  const d = isRecord(value) ? value : {};
  const outfit = isRecord(d.outfit)
    ? {
        head: typeof d.outfit.head === "string" ? d.outfit.head : null,
        face: typeof d.outfit.face === "string" ? d.outfit.face : null,
        neck: typeof d.outfit.neck === "string" ? d.outfit.neck : null,
      }
    : null;
  const engine =
    isRecord(d.engine) &&
    typeof d.engine.instanceId === "string" &&
    typeof d.engine.model === "string"
      ? {
          instanceId: d.engine.instanceId,
          model: d.engine.model,
          effort: typeof d.engine.effort === "string" ? d.engine.effort : null,
        }
      : null;
  const routines = (Array.isArray(d.routines) ? d.routines : []).flatMap((r) =>
    isRecord(r) && typeof r.title === "string" ? [{ title: r.title, cadence: str(r.cadence) }] : [],
  );
  return {
    name: str(d.name, "New blob"),
    title: str(d.title),
    job: str(d.job),
    howItWorks: strings(d.howItWorks),
    soul: str(d.soul),
    engine,
    permission: PERMISSIONS.has(str(d.permission)) ? (d.permission as BlobPermission) : "auto",
    outfit,
    apps: strings(d.apps),
    skills: strings(d.skills),
    routines,
    templateId: typeof d.templateId === "string" ? d.templateId : null,
  };
}

export function parseProposal(card: BlobCardRef): ProposalView | null {
  const payload = card.payload;
  if (payload.cardKind !== "proposal") return null;
  const state = str(payload.state, "open");
  return {
    cardId: card.cardId,
    version: card.version,
    draft: parseDraft(payload.draft),
    state: state === "hired" || state === "dismissed" ? state : "open",
    hiredBlobId: typeof payload.hiredBlobId === "string" ? payload.hiredBlobId : null,
  };
}

/** The highest version wins; an equal version keeps the newer arrival (it may carry a state change). */
export function latestVersion<T extends { readonly cardId: string; readonly version: number }>(
  prev: T | null,
  next: T,
): T {
  if (prev === null || prev.cardId !== next.cardId) return next;
  return next.version >= prev.version ? next : prev;
}

// ── looks ────────────────────────────────────────────────────────────────────────────────────────────────────

const key = (o: BlobOutfit) => `${o.head ?? ""}|${o.face ?? ""}`;

/** The suggested outfit first, then the starter looks (never the Chief's crown). Tapping the blob walks this deck. */
export function lookDeck(suggested: BlobOutfit): ReadonlyArray<BlobOutfit> {
  const seen = new Set<string>();
  const deck: BlobOutfit[] = [];
  const add = (o: BlobOutfit) => {
    const k = key(o);
    if (seen.has(k)) return;
    seen.add(k);
    deck.push(o);
  };
  add(suggested);
  for (const [id, o] of Object.entries(STARTER_OUTFITS)) if (id !== "kora") add(o);
  return deck;
}

export function stepLook(index: number, deckSize: number, direction: 1 | -1): number {
  if (deckSize <= 0) return 0;
  return (index + direction + deckSize) % deckSize;
}

export function describeOutfit(outfit: BlobOutfit): string {
  // A blob wears one accessory (the avatar draws the head slot, else the face slot).
  const id = outfit.head ?? outfit.face;
  return id ? ACCESSORY_LABELS[id] : "No accessory";
}

export function proposalOutfit(draft: BlobDraft, cardId: string): BlobOutfit {
  return toAvatarOutfit(draft.outfit, `proposal:${cardId}`);
}

// ── labels ───────────────────────────────────────────────────────────────────────────────────────────────────

export const PERMISSION_COPY: Record<BlobPermission, { label: string; hint: string }> = {
  ask: { label: "Ask", hint: "Asks before every command and edit." },
  auto: {
    label: "Auto",
    hint: "Works freely with plain file commands; asks for other shell commands and anything risky.",
  },
  full: { label: "Full", hint: "Works on its own without asking." },
};

export function modelLabel(
  draft: BlobDraft,
  labelOf: (engine: NonNullable<BlobDraft["engine"]>) => string = (e) => engineLabel(e),
): string {
  // New proposals carry the concrete model Kora will hire on ("Sonnet 5.5"); only an old card says "Best available".
  return draft.engine === null ? "Best available model" : labelOf(draft.engine);
}

/** "How it works": at most three bullets. */
export function howItWorks(draft: BlobDraft): string[] {
  return draft.howItWorks.slice(0, 3);
}
