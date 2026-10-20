// Defensive read of a `confirm` card payload (contracts: ConfirmCardPayload): an edit / retire / hire Kora wants the
// user to approve. Latest version wins (see proposalModel.latestVersion). Pure.
import type { BlobCardRef } from "../../../thread/timeline";

export type ConfirmState = "open" | "confirmed" | "dismissed" | "failed";
export type ConfirmAction = "edit" | "retire" | "hire";

export interface ConfirmView {
  readonly cardId: string;
  readonly version: number;
  readonly action: ConfirmAction;
  readonly blobId: string | null;
  readonly blobName: string | null;
  readonly summary: string;
  readonly details: ReadonlyArray<string>;
  readonly state: ConfirmState;
  readonly result: string | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseConfirm(card: BlobCardRef): ConfirmView | null {
  const p = card.payload;
  if (p.cardKind !== "confirm") return null;
  const summary = str(p.summary).trim();
  if (!summary) return null;
  const action = str(p.action);
  const state = str(p.state);
  return {
    cardId: card.cardId,
    version: card.version,
    action: action === "retire" || action === "hire" ? action : "edit",
    blobId: typeof p.blobId === "string" ? p.blobId : null,
    blobName: typeof p.blobName === "string" ? p.blobName : null,
    summary,
    details: (Array.isArray(p.details) ? p.details : []).filter(
      (d): d is string => typeof d === "string" && d.trim().length > 0,
    ),
    state: state === "confirmed" || state === "dismissed" || state === "failed" ? state : "open",
    result: typeof p.result === "string" && p.result.trim() ? p.result : null,
  };
}

export const CONFIRM_YES: Record<ConfirmAction, string> = {
  edit: "Confirm",
  retire: "Retire",
  hire: "Hire",
};
