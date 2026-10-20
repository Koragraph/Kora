// Reads a blob's approval request (the `approval.requested` payload, joined with how it ended) into what the card shows.
// Pure and defensive: the payload crosses the wire as `unknown`, and a request of a kind this client does not know still
// renders as "Use <tool>" with the arguments, never as a blank card.
import type { BlobCardRef } from "../../../thread/timeline";

export type ApprovalState = "open" | "allowed" | "always" | "denied" | "cancelled" | "expired";
export type ApprovalKind = "command" | "file-read" | "file-change" | "fetch" | "app" | "other";
export type ApprovalDecisionId = "accept" | "acceptAlways" | "decline";

export interface ApprovalView {
  readonly requestId: string;
  readonly kind: ApprovalKind;
  /** "Run a command", "Edit a file", "Send an email with Gmail" - what is being asked, in the blob's own words. */
  readonly heading: string;
  /** The exact command line / page / argument text, never shortened (the card scrolls it). */
  readonly body: string | null;
  /** The file (or page) the request touches. */
  readonly target: string | null;
  /** A symlink's real destination when the request reaches a sensitive file through it (`~/.ssh/id_rsa`). */
  readonly linkTarget: string | null;
  /** The folder a command runs in. */
  readonly cwd: string | null;
  readonly appName: string | null;
  readonly toolName: string | null;
  /** What "Always for this blob" would remember; null = that button is not offered. */
  readonly alwaysLabel: string | null;
  readonly state: ApprovalState;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

const STATES = new Set<string>(["open", "allowed", "always", "denied", "cancelled", "expired"]);

function argText(args: Record<string, unknown>): string | null {
  const keys = Object.keys(args).filter(
    (k) => args[k] !== null && args[k] !== undefined && args[k] !== "",
  );
  if (keys.length === 0) return null;
  return keys
    .map(
      (k) =>
        `${k.replace(/_/g, " ")}: ${typeof args[k] === "string" ? args[k] : JSON.stringify(args[k])}`,
    )
    .join("\n");
}

export function parseApproval(card: BlobCardRef): ApprovalView | null {
  const p = card.payload;
  if (p.cardKind !== "approval") return null;
  const requestId = str(p.requestId);
  if (!requestId) return null;
  const args = isRecord(p.args) ? p.args : {};
  const toolName = str(p.toolName);
  const appName = str(p.appName) ?? (args.kind === "app-action" ? str(args.appName) : null);
  const requestKind = str(p.requestKind);
  const command = str(args.command);
  const filePath =
    str(args.file_path) ?? str(args.path) ?? str(args.notebook_path) ?? str(p.detail);
  const url = str(args.url);
  const stateRaw = str(p.state) ?? "open";
  const state = (STATES.has(stateRaw) ? stateRaw : "open") as ApprovalState;
  const alwaysLabel =
    str(p.alwaysLabel) &&
    Array.isArray(p.options) &&
    p.options.some((o) => isRecord(o) && o.decision === "acceptAlways")
      ? str(p.alwaysLabel)
      : null;
  const base = {
    requestId,
    cwd: str(p.cwd),
    appName,
    toolName,
    alwaysLabel,
    linkTarget: str(p.linkTarget),
    state,
  };

  if (appName || args.kind === "app-action") {
    const summary = str(args.summary) ?? str(p.detail) ?? null;
    return {
      ...base,
      kind: "app",
      heading: str(p.title)?.replace(/^.*? wants to:\s*/i, "") ?? "Use a connected app",
      body: summary,
      target: null,
      cwd: null,
    };
  }
  if (command || toolName === "Bash") {
    return {
      ...base,
      kind: "command",
      heading: "Run a command",
      body: command ?? str(p.detail) ?? "(no command shown)",
      target: null,
    };
  }
  if (
    requestKind === "file-change" ||
    /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(toolName ?? "")
  ) {
    return {
      ...base,
      kind: "file-change",
      heading: toolName === "Write" ? "Write a file" : "Edit a file",
      body: null,
      target: filePath,
      cwd: null,
    };
  }
  if (requestKind === "file-read" || /^(Read|Glob|Grep|LS|NotebookRead)$/.test(toolName ?? "")) {
    return {
      ...base,
      kind: "file-read",
      heading: toolName === "Read" || !toolName ? "Read a file" : "Look through a folder",
      body: null,
      target: filePath ?? str(args.pattern),
      cwd: null,
    };
  }
  if (url || /^(WebFetch|WebSearch)$/.test(toolName ?? "")) {
    return {
      ...base,
      kind: "fetch",
      heading: toolName === "WebSearch" ? "Search the web" : "Open a web page",
      body: str(args.query) ?? null,
      target: url,
      cwd: null,
    };
  }
  return {
    ...base,
    kind: "other",
    heading: toolName ? `Use ${toolName}` : (str(p.title) ?? "Ask permission"),
    body: argText(args) ?? str(p.detail),
    target: null,
    cwd: null,
  };
}

/** The one quiet line a finished card collapses to. */
export function outcomeLine(v: ApprovalView): string {
  const what = v.kind === "command" ? firstLine(v.body) : (v.target ?? v.body ?? v.heading);
  switch (v.state) {
    case "allowed":
      return `Allowed once · ${what}`;
    case "always":
      return `Always allowed${v.alwaysLabel ? ` (${v.alwaysLabel})` : ""} · ${what}`;
    case "denied":
      return `Denied · ${what}`;
    case "cancelled":
      return `Stopped before an answer · ${what}`;
    case "expired":
      return `No longer waiting · ${what}`;
    default:
      return what;
  }
}

function firstLine(s: string | null): string {
  const line = (s ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** "~/Blobs/Popo" for a path under the home folder (the full path stays in the title attribute). */
export function tildePath(p: string, home: string | null): string {
  if (home && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`;
  const m = /^\/Users\/[^/]+(\/.*)?$/.exec(p);
  return m ? `~${m[1] ?? ""}` : p;
}
