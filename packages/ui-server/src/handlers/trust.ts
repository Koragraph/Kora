// @effect-diagnostics nodeBuiltinImport:off -- plain Node path checks at the RPC boundary, not Effect code.
import * as path from "node:path";

import type {
  FolderTrustStatus,
  TrustGetInput,
  TrustListResult,
  TrustSetInput,
} from "@kora/contracts";
import { RPC_METHODS, TrustOperationError } from "@kora/contracts";
import * as Effect from "effect/Effect";

import { host, type UiHost } from "../host.ts";
import { expandHome, type HandlerRecord, jsonSafe } from "./shared.ts";

/**
 * Folder trust handlers (`trust.get` / `trust.set` / `trust.list`): thin delegation to the runtime's trust store
 * (`packages/runtime/src/trust/store.ts`, bound as `UiHost.trust` by runtime `server/ui.ts`). Trust decides whether
 * agents load a folder's own configuration (Claude project hooks / MCP servers, Codex project config, OpenCode /
 * Koragent plugins and tools); the daemon enforces it per lane — this is only the switch. A failure (bad path, a
 * folder that can never be trusted, an older daemon without the store) is a typed `TrustOperationError`, never a
 * hang or a defect. Every result goes through `jsonSafe`.
 */

/** The runtime's `TrustHostApi` (structural; this package never imports the runtime). */
export interface KoraTrustLike {
  status(cwd: string): unknown;
  trust(cwd: string): unknown;
  revoke(cwd: string): unknown;
  list(): unknown;
}

const message = (cause: unknown): string => String((cause as Error)?.message ?? cause);

function trustApi(): KoraTrustLike {
  const api = (host() as UiHost & { trust?: KoraTrustLike }).trust;
  if (!api)
    throw new Error("folder trust is not available in this daemon (restart Kora after updating)");
  return api;
}

/** Clients may send `~/…`; anything else must be an absolute path (never resolved against the daemon's cwd). */
function folderOf(input: unknown): string {
  const raw = (input as { cwd?: unknown } | null)?.cwd;
  if (typeof raw !== "string" || !raw.trim()) throw new Error("a folder path is required");
  if (raw.includes("\0")) throw new Error("invalid folder path");
  const p = expandHome(raw.trim());
  if (!path.isAbsolute(p)) throw new Error("the folder path must be absolute");
  return path.normalize(p);
}

/** The runtime status, reduced to the wire shape (every field present, nullable). */
function toStatus(v: unknown): FolderTrustStatus {
  const s = (v ?? {}) as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  const source = str(s.source);
  return {
    cwd: str(s.cwd) ?? "",
    root: str(s.root) ?? "",
    trusted: s.trusted === true,
    trustedBy: str(s.trustedBy),
    source:
      source === "user" || source === "migration" || source === "cli" || source === "kora"
        ? source
        : null,
    canTrust: s.canTrust === true,
    reason: str(s.reason),
  };
}

const call = <A>(operation: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) => new TrustOperationError({ operation, message: message(cause) }),
  }).pipe(Effect.map((value) => jsonSafe(value)));

export const trustHandlers: HandlerRecord = {
  [RPC_METHODS.trustGet]: (input) =>
    call("get", () => toStatus(trustApi().status(folderOf(input as TrustGetInput)))),
  [RPC_METHODS.trustSet]: (input) =>
    call("set", () => {
      const i = input as TrustSetInput;
      const cwd = folderOf(i);
      if (typeof i?.trusted !== "boolean") throw new Error("trusted must be true or false");
      const api = trustApi();
      const status = toStatus(i.trusted ? api.trust(cwd) : api.revoke(cwd));
      host().log(`[kora-ui] folder trust ${i.trusted ? "granted" : "revoked"}: ${status.root}`);
      return status;
    }),
  [RPC_METHODS.trustList]: () =>
    call("list", (): TrustListResult => {
      const raw = trustApi().list();
      const folders = (Array.isArray(raw) ? raw : []).flatMap((e) => {
        const f = (e ?? {}) as Record<string, unknown>;
        if (typeof f.path !== "string") return [];
        const source: "user" | "migration" | "cli" =
          f.source === "migration" || f.source === "cli" ? f.source : "user";
        return [{ path: f.path, trustedAt: Number(f.trustedAt) || 0, source }];
      });
      return { folders };
    }),
};
