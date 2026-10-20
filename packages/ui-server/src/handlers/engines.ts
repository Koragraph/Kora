import { ENGINE_METHODS, type BlobError, type EnginesDoInput } from "@kora/contracts";
import * as Effect from "effect/Effect";

import { host, type KoraEnginesLike } from "../host.ts";
import { syncEngineProviders } from "../enginesProviders.ts";
import { refreshAntigravity } from "../antigravityModels.ts";
import { fail } from "./blobs.ts";
import { type HandlerRecord, jsonSafe } from "./shared.ts";

/**
 * `engines.*` (docs/bots/ENGINES.md, Settings > Engines): thin delegation to the runtime's `Engines` service. A key travels
 * once, inside `engines.do` (`api.setKey` / `api.test`), and is never echoed, logged or put in an error. A failure is a
 * typed `BlobError` carrying the service's own one-sentence message.
 */

function enginesOf(operation: string): KoraEnginesLike {
  const e = host().engines;
  if (!e)
    throw fail(
      operation,
      "Engines are not available in this daemon yet. Restart Kora to finish updating it.",
      "unavailable",
    );
  return e;
}

/** A thrown sentence from the service (bad URL, bad path, name taken...) becomes the error the form shows. Never raw stack text. */
function toError(operation: string, cause: unknown): BlobError {
  const c = cause as { _tag?: unknown; message?: unknown } | null;
  if (c && c._tag === "BlobError") return cause as BlobError;
  const msg =
    typeof c?.message === "string" && c.message.trim()
      ? c.message.trim().slice(0, 300)
      : "Something went wrong.";
  return fail(operation, msg, "invalid");
}

const run = <A>(operation: string, body: () => Promise<A>) =>
  Effect.tryPromise({ try: body, catch: (cause) => toError(operation, cause) }).pipe(
    Effect.map((value) => jsonSafe(value)),
  );

export async function doEngines(
  e: KoraEnginesLike,
  i: EnginesDoInput,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  switch (i.op) {
    case "acp.save":
      e.acpSave({
        agentId: i.agentId,
        ...(i.label !== undefined ? { label: i.label } : {}),
        ...(i.command !== undefined ? { command: i.command } : {}),
        ...(i.executable !== undefined ? { executable: i.executable } : {}),
        ...(i.args ? { args: [...i.args] } : {}),
        ...(i.env ? { env: { ...i.env } } : {}),
      });
      break;
    case "acp.remove":
      e.acpRemove(i.agentId);
      break;
    case "acp.models": {
      const r = await e.acpModels(i.agentId);
      out.models = r.models;
      out.current = r.current;
      if (r.error) out.error = r.error;
      break;
    }
    case "acp.idle":
      e.setIdleMinutes(i.minutes);
      break;
    case "exe.set":
      e.setExecutable(i.engine, i.path);
      break;
    case "api.save":
      e.apiSave({
        id: i.id,
        ...(i.label !== undefined ? { label: i.label } : {}),
        ...(i.protocol !== undefined ? { protocol: i.protocol } : {}),
        ...(i.baseUrl !== undefined ? { baseUrl: i.baseUrl } : {}),
        ...(i.requiresKey !== undefined ? { requiresKey: i.requiresKey } : {}),
        ...(i.defaultModel !== undefined ? { defaultModel: i.defaultModel } : {}),
      });
      break;
    case "api.remove":
      await e.apiRemove(i.id);
      break;
    case "api.setKey":
      await e.apiSetKey(i.id, i.key);
      break;
    case "api.clearKey":
      await e.apiClearKey(i.id);
      break;
    case "api.test": {
      const t = await e.apiTest(i.id, i.key);
      out.test = {
        ok: t.ok,
        kind: t.kind,
        message: t.message,
        ...(t.status !== undefined ? { status: t.status } : {}),
        ...(t.modelCount !== undefined ? { modelCount: t.modelCount } : {}),
      };
      break;
    }
    case "api.models":
      out.models = await e.apiModels(i.id);
      break;
    case "account.add":
      out.account = e.accountAdd({
        name: i.name,
        ...(i.label !== undefined ? { label: i.label } : {}),
      });
      break;
    case "account.rename":
      e.accountRename(i.name, i.label);
      break;
    case "account.remove":
      e.accountRemove(i.name);
      break;
    case "account.check":
      out.account = await e.accountCheck(i.name);
      break;
    case "refresh":
      e.acpRecheck?.();
      break;
  }
  // Antigravity is a built-in provider with its own probe: Re-check (or a new path) looks at `agy` again, in the background.
  if (i.op === "refresh" || (i.op === "exe.set" && i.engine === "antigravity"))
    void refreshAntigravity().catch(() => false);
  // the model picker follows at once (also on `changed`, but a test/remove that changed nothing still refreshes the view)
  await syncEngineProviders().catch(() => false);
  return { ...out, view: await e.view() };
}

export const enginesHandlers: HandlerRecord = {
  [ENGINE_METHODS.list]: () => run("engines.list", async () => enginesOf("engines.list").view()),
  [ENGINE_METHODS.do]: (input) =>
    run("engines.do", async () => doEngines(enginesOf("engines.do"), input as EnginesDoInput)),
};
