import {
  AgentApprovalOption,
  AgentRequestKind,
  AskQuestion,
  RequestId,
  type ChatThreadActivity,
} from "@kora/contracts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** An open request for permission, oldest first in `derivePendingRequests`. */
export type PendingApproval = Readonly<{
  requestId: RequestId;
  createdAt: string;
  requestKind: AgentRequestKind;
  detail?: string;
  appName?: string;
  options?: ReadonlyArray<AgentApprovalOption>;
  /** A blob's request: it shows as a card in the transcript, not in the composer. */
  blobThread?: boolean;
}>;

/** An open question for the user. */
export type PendingQuestion = Readonly<{
  createdAt: string;
  requestId: RequestId;
  /** Async questions can be dismissed without a reply; native callbacks cannot. */
  dismissible: boolean;
  questions: ReadonlyArray<AskQuestion>;
}>;

// ── Native request types ─────────────────────────────────────────────

const KIND_BY_REQUEST_TYPE = new Map<string, AgentRequestKind>([
  ["exec_command_approval", "command"],
  ["command_execution_approval", "command"],
  ["dynamic_tool_call", "command"],
  ["file_read_approval", "file-read"],
  ["apply_patch_approval", "file-change"],
  ["file_change_approval", "file-change"],
  ["mcp_elicitation_approval", "mcp-elicitation"],
]);

/** Older activities use native request types instead of a request kind. */
export function requestKindFromRequestType(requestType: unknown): AgentRequestKind | null {
  return typeof requestType === "string" ? (KIND_BY_REQUEST_TYPE.get(requestType) ?? null) : null;
}

// ── Questions ────────────────────────────────────────────────────────

// Native question ids and option labels can be answer keys, so nothing here is trimmed.
const LooseOption = Schema.Struct({
  ...AskQuestion.fields.options.value.fields,
  label: Schema.String,
});
const isLooseOption = Schema.is(LooseOption);
const untrimmed = { id: Schema.String, question: Schema.String, header: Schema.String };
const LooseQuestion = Schema.Struct({
  ...AskQuestion.fields,
  ...untrimmed,
  options: Schema.Array(LooseOption),
});
const readQuestion = Schema.decodeUnknownOption(LooseQuestion);

function parseQuestions(raw: unknown): AskQuestion[] {
  const parsed: AskQuestion[] = [];
  if (!Array.isArray(raw)) return parsed;
  for (const entry of raw) {
    if (!Predicate.isObject(entry) || !Array.isArray(entry.options)) continue;
    const options = entry.options.filter(isLooseOption);
    const customAnswer =
      typeof entry.allowCustomAnswer === "boolean" ? entry.allowCustomAnswer : undefined;
    // A question with no options that also forbids a typed answer cannot be answered.
    if (options.length === 0 && customAnswer === false) continue;
    const candidate = {
      id: entry.id,
      header: entry.header,
      question: entry.question,
      multiSelect: entry.multiSelect === true,
      options,
      ...(customAnswer === undefined ? {} : { allowCustomAnswer: customAnswer }),
    };
    Option.match(readQuestion(candidate), {
      onNone: () => undefined,
      onSome: (question) => parsed.push(question),
    });
  }
  return parsed;
}

// ── Stale replies ────────────────────────────────────────────────────

// A failed reply closes its request only when the server says the request is stale or
// unknown; any other failure leaves it open so the user can try again.
const STALE_REPLY_MARKERS = new Map<string, ReadonlyArray<string>>([
  [
    "provider.approval.respond.failed",
    [
      "unknown pending codex approval request",
      "unknown pending permission request",
      "unknown pending approval request",
      "stale pending approval request",
    ],
  ],
  [
    "provider.user-input.respond.failed",
    [
      "unknown pending codex user input request",
      "unknown pending user input request",
      "unknown pending user-input request",
      "stale pending user-input request",
    ],
  ],
]);

function isStaleReply(kind: string, payload: Record<string, unknown>): boolean {
  const markers = STALE_REPLY_MARKERS.get(kind);
  if (markers === undefined) return false;
  const detail = typeof payload.detail === "string" ? payload.detail.toLowerCase() : "";
  return markers.some((marker) => detail.includes(marker));
}

// ── Approval detail ──────────────────────────────────────────────────

const DETAIL_CLIP = 600;
const clipDetail = (text: string) =>
  text.length > DETAIL_CLIP ? `${text.slice(0, DETAIL_CLIP - 1).trimEnd()}…` : text;

/**
 * What an approval asks for, when the daemon sent no `detail`: the command, or the file with its +/- line counts and the
 * first changed lines ("File change approval" alone told nobody what they were allowing).
 */
export function approvalDetailFromArgs(args: unknown): string | null {
  if (!Predicate.isObject(args)) return null;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const command = str(args.command);
  if (command) return clipDetail(command);
  const path = str(args.file_path) ?? str(args.path) ?? str(args.notebook_path);
  if (!path) return null;
  const lineCount = (text: string | null) => (text ? text.split("\n").length : 0);
  const pairs: Array<{ before: string | null; after: string | null }> = [];
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (Predicate.isObject(edit)) {
        pairs.push({ before: str(edit.old_string), after: str(edit.new_string) });
      }
    }
  } else {
    pairs.push({
      before: str(args.old_string),
      after: str(args.new_string) ?? str(args.content),
    });
  }
  const removed = pairs.reduce((n, p) => n + lineCount(p.before), 0);
  const added = pairs.reduce((n, p) => n + lineCount(p.after), 0);
  if (removed === 0 && added === 0) return path;
  const preview = pairs
    .flatMap((p) => [
      ...(p.before ? p.before.split("\n").map((l) => `- ${l}`) : []),
      ...(p.after ? p.after.split("\n").map((l) => `+ ${l}`) : []),
    ])
    .slice(0, 8)
    .join("\n");
  return clipDetail(`${path}  (+${added} -${removed})\n${preview}`);
}

// ── Reduction ────────────────────────────────────────────────────────

/**
 * Open requests of one sort. Request ids are unique and a close is final, so a request
 * stays closed even when its open event is delivered after the close.
 */
class RequestBook<Entry extends { readonly createdAt: string }> {
  private readonly open = new Map<RequestId, Entry>();
  private readonly closed = new Set<RequestId>();

  isClosed(id: RequestId): boolean {
    return this.closed.has(id);
  }

  record(id: RequestId, entry: Entry): void {
    if (!this.closed.has(id)) this.open.set(id, entry);
  }

  close(id: RequestId): void {
    this.closed.add(id);
    this.open.delete(id);
  }

  oldestFirst(): Entry[] {
    return [...this.open.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

/** Approval requests that are really something else and never become cards. */
const NOT_APPROVALS = new Set(["tool_user_input", "auth_tokens_refresh"]);

const isRequestId = Schema.is(RequestId);
const isRequestKind = Schema.is(AgentRequestKind);
const isApprovalOption = Schema.is(AgentApprovalOption);

function approvalFrom(
  payload: Record<string, unknown>,
  requestId: RequestId,
  createdAt: string,
): PendingApproval {
  const detail =
    typeof payload.detail === "string" && payload.detail !== ""
      ? payload.detail
      : approvalDetailFromArgs(payload.args);
  const options = Array.isArray(payload.options) ? payload.options.filter(isApprovalOption) : [];
  const appName =
    typeof payload.appName === "string" && payload.appName !== "" ? payload.appName : null;
  const kind = isRequestKind(payload.requestKind)
    ? payload.requestKind
    : requestKindFromRequestType(payload.requestType);
  return {
    requestId,
    // Older OpenCode approvals do not always carry a recognised kind.
    requestKind: kind ?? "command",
    createdAt,
    ...(detail ? { detail } : {}),
    ...(appName === null ? {} : { appName }),
    ...(options.length === 0 ? {} : { options }),
    ...(payload.blobThread === true ? { blobThread: true } : {}),
  };
}

/** Reduces request state once for web, desktop, and mobile. Layout stays with each client. */
export function derivePendingRequests(activities: ReadonlyArray<ChatThreadActivity>) {
  const approvals = new RequestBook<PendingApproval>();
  const questions = new RequestBook<PendingQuestion>();

  for (const { kind, payload: raw, createdAt } of activities) {
    if (!Predicate.isObject(raw) || !isRequestId(raw.requestId)) continue;
    const payload = raw as Record<string, unknown>;
    const id = raw.requestId;

    switch (kind) {
      case "approval.requested":
        if (approvals.isClosed(id) || NOT_APPROVALS.has(payload.requestType as string)) break;
        approvals.record(id, approvalFrom(payload, id, createdAt));
        break;
      case "user-input.requested": {
        if (questions.isClosed(id)) break;
        const asked = parseQuestions(payload.questions);
        if (asked.length === 0) break;
        questions.record(id, {
          requestId: id,
          createdAt,
          questions: asked,
          dismissible: payload.responseMode === "message",
        });
        break;
      }
      case "approval.resolved":
        approvals.close(id);
        break;
      case "user-input.resolved":
        questions.close(id);
        break;
      case "provider.approval.respond.failed":
        if (isStaleReply(kind, payload)) approvals.close(id);
        break;
      case "provider.user-input.respond.failed":
        if (isStaleReply(kind, payload)) questions.close(id);
        break;
    }
  }

  return { approvals: approvals.oldestFirst(), userInputs: questions.oldestFirst() };
}
