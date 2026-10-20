import type {
  AppsAccountsInput,
  AppsConnectInput,
  AppsDecisionsInput,
  AppsDisconnectInput,
  AppsSetKeyInput,
  AppsToolkitsInput,
  AppsToolsInput,
} from "@kora/contracts";
import { BLOB_METHODS, BlobError } from "@kora/contracts";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { KoraAppsLike } from "../host.ts";
import { type HandlerRecord, jsonSafe } from "./shared.ts";
import { fail, runtimeFor } from "./blobs.ts";

/**
 * `blobs.apps.*` (docs/bots/APPS.md): connected apps through the runtime's `AppsService` (`UiHost.blobs.apps`).
 * What leaves the daemon here is the owner's own UI data. Three rules:
 *   - the Composio key (BYO) and the broker token never appear in a result, a log line or an error: `setKey` answers with the
 *     new status only, and a failure carries the service's own secret-free message;
 *   - a connect link goes to the one caller that asked for it and is never logged;
 *   - an `AppsError` code becomes the `BlobError.code` so the client branches on it (`cap_reached`, `broker_down`,
 *     `alias_required`, `account_limit`, `link_expired`, `bad_key`, `registration_closed`, `not_configured`...).
 */

const isBlobError = Schema.is(BlobError);

function appsOf(operation: string): KoraAppsLike {
  const apps = runtimeFor(operation).apps;
  if (!apps)
    throw fail(
      operation,
      "Connected apps are not available in this daemon yet. Restart Kora to finish updating it.",
      "unavailable",
    );
  return apps;
}

/** An AppsError (has a `code` and a message that is already safe) or anything else (a generic line: never raw text). */
function toAppsError(operation: string, cause: unknown): BlobError {
  if (isBlobError(cause)) return cause;
  const c = cause as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (c?.name === "AppsError" && typeof c.code === "string" && typeof c.message === "string")
    return fail(operation, c.message, c.code);
  return fail(
    operation,
    "Connected apps hit an unexpected error. Try again; if it keeps happening, check Settings → Connections.",
    "upstream",
  );
}

const run = <A>(operation: string, body: () => Promise<A>) =>
  Effect.tryPromise({ try: body, catch: (cause) => toAppsError(operation, cause) }).pipe(
    Effect.map((value) => jsonSafe(value)),
  );

export const blobsAppsHandlers: HandlerRecord = {
  [BLOB_METHODS.appsStatus]: () => run("appsStatus", () => appsOf("appsStatus").status()),

  [BLOB_METHODS.appsSetKey]: (input) => {
    const i = input as AppsSetKeyInput;
    return run("appsSetKey", async () => {
      const apps = appsOf("appsSetKey");
      await apps.setByoKey(i.key);
      return apps.status();
    });
  },

  [BLOB_METHODS.appsClearKey]: () =>
    run("appsClearKey", async () => {
      const apps = appsOf("appsClearKey");
      await apps.clearByoKey();
      return apps.status();
    }),

  [BLOB_METHODS.appsResetBroker]: () =>
    run("appsResetBroker", async () => {
      const apps = appsOf("appsResetBroker");
      await apps.resetBroker();
      return apps.status();
    }),

  [BLOB_METHODS.appsToolkits]: (input) => {
    const i = input as AppsToolkitsInput;
    return run("appsToolkits", () =>
      appsOf("appsToolkits").toolkits({
        ...(i.search?.trim() ? { search: i.search.trim() } : {}),
        ...(i.cursor ? { cursor: i.cursor } : {}),
      }),
    );
  },

  [BLOB_METHODS.appsAccounts]: (input) => {
    const i = input as AppsAccountsInput;
    return run("appsAccounts", async () => ({
      accounts: await appsOf("appsAccounts").accounts(i.toolkit ?? undefined),
    }));
  },

  [BLOB_METHODS.appsConnect]: (input) => {
    const i = input as AppsConnectInput;
    return run("appsConnect", async () => {
      const apps = appsOf("appsConnect");
      const link = apps.assertLinkFresh(await apps.connect(i.toolkit, i.alias ?? undefined));
      return { url: link.url, expiresAt: link.expiresAt };
    });
  },

  [BLOB_METHODS.appsDisconnect]: (input) => {
    const i = input as AppsDisconnectInput;
    return run("appsDisconnect", () => appsOf("appsDisconnect").disconnect(i.accountId));
  },

  [BLOB_METHODS.appsTools]: (input) => {
    const i = input as AppsToolsInput;
    return run("appsTools", async () => {
      const tools = await appsOf("appsTools").ownerTools(i.toolkit);
      return {
        tools: tools.map((t) => ({
          slug: t.slug,
          name: t.name,
          description: t.description,
          toolkit: t.toolkit,
          readOnly: t.readOnly,
          outbound: t.outbound,
        })),
      };
    });
  },

  [BLOB_METHODS.appsDecisions]: (input) => {
    const i = input as AppsDecisionsInput;
    return run("appsDecisions", async () => {
      const limit = Math.max(1, Math.min(200, Math.trunc(i.limit) || 50));
      const rows = appsOf("appsDecisions").decisions.recent(limit, i.blobId ?? undefined);
      return {
        // newest first; the argument KEY NAMES and hash stay in the file, the client never needs them
        decisions: rows
          .slice()
          .reverse()
          .map((r) => ({
            at: Number(r.at) || 0,
            kind: r.kind === "result" ? "result" : "decision",
            blobId: String(r.blobId ?? ""),
            threadId: typeof r.threadId === "string" ? r.threadId : null,
            tool: String(r.tool ?? ""),
            toolkit: String(r.toolkit ?? ""),
            account: typeof r.account === "string" ? r.account : null,
            decision: r.decision === "deny" ? "deny" : "allow",
            reason: String(r.reason ?? ""),
            outbound: r.outbound === true,
            outcome: typeof r.outcome === "string" ? r.outcome : null,
          })),
      };
    });
  },
};
