// "Save image" / "Copy image" for media on a remote host. The app window's connect-src is loopback-only (2026-10-15
// audit desktop #4), so the renderer cannot fetch the bytes itself; the main process does, for public http(s) hosts
// only, without cookies, size- and time-capped. Only the main window's own renderer may ask.
import * as NodeDns from "node:dns";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Channels from "../channelNames.ts";
import { defineIpcMethod } from "../ShellIpc.ts";
import * as NativeWindow from "../../native/NativeWindow.ts";
import { isPrivateNetworkHost } from "../../web/FaviconCapture.ts";

export const MAX_REMOTE_MEDIA_BYTES = 100 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

const RemoteMediaResult = Schema.Struct({
  bytes: Schema.optional(Schema.Uint8Array),
  mime: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
type RemoteMediaResult = typeof RemoteMediaResult.Type;

type Lookup = (host: string) => Promise<ReadonlyArray<string>>;
const lookupAll: Lookup = async (host) =>
  (await NodeDns.promises.lookup(host, { all: true })).map((a) => a.address);

/** Why `address` may not be fetched from the main process, or null. A name that resolves to a private address counts. */
async function refusal(address: string, lookup: Lookup): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return "only http(s) media can be fetched";
  if (url.username || url.password) return "a URL with credentials is not fetched";
  if (isPrivateNetworkHost(url.hostname))
    return "media on this computer or the local network is not fetched";
  const resolved = await lookup(url.hostname.replace(/^\[|\]$/g, "")).catch(() => [] as string[]);
  if (resolved.length === 0) return "the host could not be resolved";
  if (resolved.some(isPrivateNetworkHost))
    return "media on this computer or the local network is not fetched";
  return null;
}

/** The bytes behind a public http(s) media URL. Pure apart from `fetchFn` / `lookup`, so tests can drive it. */
export async function fetchRemoteMedia(
  address: string,
  fetchFn: typeof fetch = fetch,
  lookup: Lookup = lookupAll,
): Promise<RemoteMediaResult> {
  const abort = AbortSignal.timeout(TIMEOUT_MS);
  let current = address;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const why = await refusal(current, lookup);
      if (why) return { error: `The file could not be fetched: ${why}.` };
      const resp = await fetchFn(current, {
        redirect: "manual",
        credentials: "omit",
        signal: abort,
      });
      if (resp.status >= 300 && resp.status < 400) {
        await resp.body?.cancel().catch(() => undefined);
        const next = resp.headers.get("location");
        if (!next) return { error: `The file could not be fetched (HTTP ${resp.status}).` };
        current = new URL(next, current).toString();
        continue;
      }
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => undefined);
        return { error: `The file could not be fetched (HTTP ${resp.status}).` };
      }
      const declared = Number(resp.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_REMOTE_MEDIA_BYTES) {
        await resp.body?.cancel().catch(() => undefined);
        return { error: "The file is too large to save from here. Open the original URL." };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = resp.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_REMOTE_MEDIA_BYTES) {
            await reader.cancel().catch(() => undefined);
            return { error: "The file is too large to save from here. Open the original URL." };
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      const mime = resp.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      return { bytes, mime };
    }
    return { error: "The file could not be fetched (too many redirects)." };
  } catch {
    return {
      error: "The file could not be fetched. The connection may be unavailable.",
    };
  }
}

export const fetchRemoteMediaIpc = defineIpcMethod({
  channel: Channels.IPC_FETCH_REMOTE_MEDIA,
  payload: Schema.String,
  result: RemoteMediaResult,
  handler: (address, evt) =>
    Effect.gen(function* () {
      const main = yield* (yield* NativeWindow.NativeWindow).main;
      if (
        Option.isNone(main) ||
        main.value.isDestroyed() ||
        evt?.sender.id !== main.value.webContents.id
      )
        return { error: "Not available here." };
      return yield* Effect.promise(() => fetchRemoteMedia(address));
    }),
});
