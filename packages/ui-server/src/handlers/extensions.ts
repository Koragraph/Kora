// @effect-diagnostics nodeBuiltinImport:off -- plain Node path checks at the RPC boundary, not Effect code.
import * as path from "node:path";

import { ExtensionOperationError, RPC_METHODS } from "@kora/contracts";
import * as Effect from "effect/Effect";

import { host, type UiHost } from "../host.ts";
import { expandHome, type HandlerRecord, jsonSafe } from "./shared.ts";

/**
 * Extensions handlers (`extensions.*`): thin delegation to the runtime (`packages/runtime/src/extensions/host.ts`,
 * bound as `UiHost.extensions` by runtime `server/ui.ts`). Saving, testing and installing can take seconds (a first
 * `npx -y` downloads a package), so every call is a promise. A failure is a typed `ExtensionOperationError` whose
 * message is safe to show; every result goes through `jsonSafe`.
 */

/** The runtime's `ExtensionsHostApi` (structural; this package never imports the runtime). */
type Fn = (input: never) => unknown;
export interface KoraExtensionsLike {
  list: Fn;
  save: Fn;
  remove: Fn;
  setEnabled: Fn;
  test: Fn;
  parse: Fn;
  discover: Fn;
  catalog: Fn;
  addFromCatalog: Fn;
  project: Fn;
  projectApprove: Fn;
  setProjectSecret: Fn;
  skillAdd: Fn;
  skillRemove: Fn;
  skillSetEnabled: Fn;
}

function api(): KoraExtensionsLike {
  const a = (host() as UiHost & { extensions?: KoraExtensionsLike }).extensions;
  if (!a)
    throw new Error("extensions are not available in this daemon (restart Kora after updating)");
  return a;
}

/** A folder from the client: `~/…` or absolute, never resolved against the daemon's own cwd. */
function absolute(raw: unknown, what: string): string {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0"))
    throw new Error(`${what} is required`);
  const p = expandHome(raw.trim());
  if (!path.isAbsolute(p)) throw new Error(`${what} must be an absolute path`);
  return path.normalize(p);
}

const run = (operation: string, fn: () => unknown) =>
  Effect.tryPromise({
    try: async () => jsonSafe(await fn()),
    catch: (cause) =>
      new ExtensionOperationError({
        operation,
        message: String((cause as Error)?.message ?? cause),
      }),
  });

const call = (method: keyof KoraExtensionsLike) => (input: unknown) =>
  run(method, () => (api()[method] as (i: unknown) => unknown)(input ?? {}));

export const extensionsHandlers: HandlerRecord = {
  [RPC_METHODS.extensionsList]: call("list"),
  [RPC_METHODS.extensionsSave]: (input) =>
    run("save", async () => {
      const saved = await (api().save as (i: unknown) => Promise<{ name: string }>)(input);
      host().log(`[kora-ui] extension saved: ${saved.name}`);
      return saved;
    }),
  [RPC_METHODS.extensionsRemove]: call("remove"),
  [RPC_METHODS.extensionsSetEnabled]: call("setEnabled"),
  [RPC_METHODS.extensionsTest]: call("test"),
  [RPC_METHODS.extensionsParse]: call("parse"),
  [RPC_METHODS.extensionsDiscover]: call("discover"),
  [RPC_METHODS.extensionsCatalog]: call("catalog"),
  [RPC_METHODS.extensionsAddFromCatalog]: call("addFromCatalog"),
  [RPC_METHODS.extensionsProject]: (input) =>
    run("project", () =>
      (api().project as (i: unknown) => unknown)({
        cwd: absolute((input as { cwd?: unknown })?.cwd, "a project folder"),
      }),
    ),
  [RPC_METHODS.extensionsProjectApprove]: (input) =>
    run("projectApprove", () => {
      const i = (input ?? {}) as { cwd?: unknown; name?: unknown; approved?: unknown };
      return (api().projectApprove as (i: unknown) => unknown)({
        cwd: absolute(i.cwd, "a project folder"),
        name: String(i.name ?? ""),
        approved: i.approved === true,
      });
    }),
  [RPC_METHODS.extensionsSetProjectSecret]: call("setProjectSecret"),
  [RPC_METHODS.extensionsSkillAdd]: call("skillAdd"),
  [RPC_METHODS.extensionsSkillRemove]: call("skillRemove"),
  [RPC_METHODS.extensionsSkillSetEnabled]: call("skillSetEnabled"),
};
