// Reads a `blob.card` payload defensively. The payload crosses the wire as `unknown`; a card this client does not
// know (a newer daemon, a malformed row) becomes `{ kind: "unknown" }` and renders as its one-line summary, never as
// an error. Phase 2 cards (job, proposal) are parsed to the fields their placeholder row shows.
import type { BlobCardRef } from "../../../thread/timeline";
import type { RoutineConfirmCardWire, RoutineReportCardWire } from "../routines/routineModel";

export interface ParsedMemoryReceipt {
  readonly id: string;
  readonly kind: "added" | "updated" | "retired" | "held";
  readonly scope: "you" | "blob" | "team";
  readonly text: string;
  readonly previousText: string | null;
  readonly undone: boolean;
  readonly reason: string | null;
}

export interface ParsedJobStep {
  readonly id: string;
  readonly blobName: string;
  readonly title: string;
  readonly status: string;
}

export type ParsedBlobCard =
  | { readonly kind: "memory"; readonly receipts: ReadonlyArray<ParsedMemoryReceipt> }
  | {
      readonly kind: "self-change";
      readonly what: string;
      readonly undoToken: string;
      readonly undone: boolean;
    }
  | {
      readonly kind: "rate-limit";
      readonly engine: string;
      readonly resetsAt: number | null;
      readonly threadId: string;
    }
  | {
      readonly kind: "job";
      readonly title: string;
      readonly status: string;
      readonly steps: ReadonlyArray<ParsedJobStep>;
    }
  | {
      readonly kind: "proposal";
      readonly name: string;
      readonly job: string;
      readonly state: string;
    }
  | { readonly kind: "confirm"; readonly summary: string }
  | { readonly kind: "routine-report"; readonly card: RoutineReportCardWire }
  | { readonly kind: "routine-confirm"; readonly card: RoutineConfirmCardWire }
  | {
      readonly kind: "app-connect";
      readonly toolkit: string;
      readonly reason: "not_connected" | "not_granted";
      readonly blobId: string;
    }
  | { readonly kind: "approval" }
  | { readonly kind: "helpers" }
  | { readonly kind: "unknown"; readonly cardKind: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const SCOPES = new Set(["you", "blob", "team"]);
const RECEIPT_KINDS = new Set(["added", "updated", "retired", "held"]);

function parseReceipt(value: unknown, index: number): ParsedMemoryReceipt | null {
  if (!isRecord(value)) return null;
  const text = str(value.text).trim();
  if (text.length === 0) return null;
  const kind = str(value.kind);
  const scope = str(value.scope);
  return {
    id: str(value.id, `receipt-${index}`),
    kind: RECEIPT_KINDS.has(kind) ? (kind as ParsedMemoryReceipt["kind"]) : "added",
    scope: SCOPES.has(scope) ? (scope as ParsedMemoryReceipt["scope"]) : "you",
    text,
    previousText: typeof value.previousText === "string" ? value.previousText : null,
    undone: value.undone === true,
    reason: typeof value.reason === "string" && value.reason.trim() ? value.reason : null,
  };
}

export function parseBlobCard(card: BlobCardRef): ParsedBlobCard {
  const payload = card.payload;
  const cardKind = typeof payload.cardKind === "string" ? payload.cardKind : null;
  switch (cardKind) {
    case "memory": {
      const receipts = (Array.isArray(payload.receipts) ? payload.receipts : [])
        .map(parseReceipt)
        .filter((r): r is ParsedMemoryReceipt => r !== null);
      return receipts.length === 0 ? { kind: "unknown", cardKind } : { kind: "memory", receipts };
    }
    case "self-change": {
      const what = str(payload.what).trim();
      return what
        ? {
            kind: "self-change",
            what,
            undoToken: str(payload.undoToken),
            undone: payload.undone === true,
          }
        : { kind: "unknown", cardKind };
    }
    case "approval":
      return { kind: "approval" };
    case "helpers":
      return { kind: "helpers" };
    case "rate-limit":
      return {
        kind: "rate-limit",
        engine: str(payload.engine, "claude"),
        resetsAt: typeof payload.resetsAt === "number" ? payload.resetsAt : null,
        threadId: str(payload.threadId),
      };
    case "job": {
      const steps = (Array.isArray(payload.steps) ? payload.steps : []).flatMap((step, index) =>
        isRecord(step)
          ? [
              {
                id: str(step.id, `step-${index}`),
                blobName: str(step.blobName),
                title: str(step.title),
                status: str(step.status, "queued"),
              },
            ]
          : [],
      );
      return { kind: "job", title: str(payload.title, "Job"), status: str(payload.status), steps };
    }
    case "proposal": {
      const draft = isRecord(payload.draft) ? payload.draft : {};
      return {
        kind: "proposal",
        name: str(draft.name, "New blob"),
        job: str(draft.job),
        state: str(payload.state, "open"),
      };
    }
    case "confirm": {
      const summary = str(payload.summary).trim();
      return summary ? { kind: "confirm", summary } : { kind: "unknown", cardKind };
    }
    case "routine-report": {
      const runId = str(payload.runId);
      const status = str(payload.status);
      if (!runId || !["completed", "failed", "cancelled"].includes(status))
        return { kind: "unknown", cardKind };
      return {
        kind: "routine-report",
        card: {
          cardKind: "routine-report",
          cardId: str(payload.cardId, runId),
          routineId: str(payload.routineId),
          runId,
          blobId: str(payload.blobId),
          title: str(payload.title, "Routine"),
          status: status as RoutineReportCardWire["status"],
          ranAt: typeof payload.ranAt === "number" ? payload.ranAt : Date.now(),
          text: str(payload.text),
          outputs: (Array.isArray(payload.outputs) ? payload.outputs : []).filter(
            (o): o is string => typeof o === "string",
          ),
          executionThreadId:
            typeof payload.executionThreadId === "string" ? payload.executionThreadId : null,
          resultsThreadId: str(payload.resultsThreadId),
        },
      };
    }
    case "routine-confirm": {
      const token = str(payload.token);
      const summary = str(payload.summary).trim();
      const state = str(payload.state, "open");
      if (!token || !summary) return { kind: "unknown", cardKind };
      return {
        kind: "routine-confirm",
        card: {
          cardKind: "routine-confirm",
          cardId: str(payload.cardId, token),
          token,
          blobId: str(payload.blobId),
          summary,
          details: (Array.isArray(payload.details) ? payload.details : []).filter(
            (d): d is string => typeof d === "string",
          ),
          state: (["open", "confirmed", "dismissed", "failed"].includes(state)
            ? state
            : "open") as RoutineConfirmCardWire["state"],
          result: typeof payload.result === "string" ? payload.result : null,
        },
      };
    }
    case "app-connect": {
      const toolkit = str(payload.toolkit).trim();
      return toolkit
        ? {
            kind: "app-connect",
            toolkit,
            reason: payload.reason === "not_granted" ? "not_granted" : "not_connected",
            blobId: str(payload.blobId),
          }
        : { kind: "unknown", cardKind };
    }
    default:
      return { kind: "unknown", cardKind };
  }
}

/** "Claude" for the engine instance a rate-limit card names. */
export function engineDisplayName(engine: string): string {
  switch (engine) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "opencode":
      return "This model";
    default:
      return engine.length > 0 ? engine.charAt(0).toUpperCase() + engine.slice(1) : "This model";
  }
}
