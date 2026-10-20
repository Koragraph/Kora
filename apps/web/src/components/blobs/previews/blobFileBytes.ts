// Fetching a blob workspace file's bytes for binary previews (spreadsheets, documents, decks, PDFs, images).
// `projects.readFile` refuses binary content, so previews read through the daemon's authed HTTP route:
//
//   GET /api/blobs/:blobId/file?path=<workspace-relative path>   ->  the file's bytes (streamed)
//
// That route belongs to the ui-server (Slice B). While a daemon predates it the response is a 404/405 without the
// daemon's tagged JSON body and this module reports `unavailable`, so the card keeps working as Open / Reveal with a
// plain "preview not available on this daemon" line instead of an error. A file the daemon does not know is
// `not_found`. Size is checked from Content-Length BEFORE the body is read.
import { fetchPrimaryHost } from "~/hosts/primary/shellAuth";
import { resolvePrimaryHostHttpUrl } from "~/hosts/primary/target";
import { PreviewError, formatBytes, tooLargeMessage } from "./limits";

export interface BlobFileFetchOptions {
  readonly blobId: string;
  readonly relativePath: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

function blobFileUrl(blobId: string, relativePath: string): string {
  return resolvePrimaryHostHttpUrl(`/api/blobs/${encodeURIComponent(blobId)}/file`, {
    path: relativePath,
  });
}

const CACHE_LIMIT_BYTES = 48 * 1024 * 1024;
interface CacheEntry {
  readonly bytes: Uint8Array;
  /** What the daemon said about the file's version (etag / last-modified), or "" when it said nothing. */
  readonly version: string;
}
const cache = new Map<string, CacheEntry>();
let cachedBytes = 0;

function remember(key: string, bytes: Uint8Array, version: string) {
  if (bytes.byteLength > CACHE_LIMIT_BYTES / 2) return;
  const old = cache.get(key);
  if (old) cachedBytes -= old.bytes.byteLength;
  cache.delete(key);
  cache.set(key, { bytes, version });
  cachedBytes += bytes.byteLength;
  while (cachedBytes > CACHE_LIMIT_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cachedBytes -= cache.get(oldest)?.bytes.byteLength ?? 0;
    cache.delete(oldest);
  }
}

/** The file version the response advertises. A cached copy is reused only when this matches; no version = never reused. */
function responseVersion(headers: Headers): string {
  const etag = headers.get("etag") ?? "";
  const modified = headers.get("last-modified") ?? "";
  if (!etag && !modified) return "";
  return `${etag}|${modified}|${headers.get("content-length") ?? ""}`;
}

export function clearBlobFileCacheForTests(): void {
  cache.clear();
  cachedBytes = 0;
}

/** A fresh copy each call: the preview worker takes ownership of the buffer it is handed. */
export async function fetchBlobFileBytes(options: BlobFileFetchOptions): Promise<Uint8Array> {
  const key = `${options.blobId}\u0000${options.relativePath}`;
  // A blob edits the same path again and again ("add a savings column" rewrites budget.xlsx): the cache may only answer
  // when the daemon still reports the version it was filled from. Revalidate on every request - the headers arrive
  // before the body, so an unchanged file costs one round trip, not a download.
  const hit = cache.get(key);
  let response: Response;
  try {
    response = await fetchPrimaryHost(blobFileUrl(options.blobId, options.relativePath), {
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new PreviewError("unavailable", "Kora could not reach the daemon to preview this file.");
  }
  if (response.status === 404 || response.status === 405) {
    const tagged = await response
      .clone()
      .json()
      .then((body: unknown) => typeof body === "object" && body !== null && "_tag" in body)
      .catch(() => false);
    throw tagged
      ? new PreviewError("not_found", "This file is no longer in the blob's folder.")
      : new PreviewError("unavailable", "Previews of this kind of file need a newer Kora daemon.");
  }
  if (response.status === 413) {
    throw new PreviewError(
      "too_large",
      "This file is too large to preview. Open it to see everything.",
    );
  }
  if (!response.ok) {
    throw new PreviewError(
      "unavailable",
      `The daemon could not send this file (${response.status}).`,
    );
  }
  const version = responseVersion(response.headers);
  if (hit && version !== "" && hit.version === version) {
    void response.body?.cancel().catch(() => undefined);
    if (hit.bytes.byteLength > options.maxBytes) {
      throw new PreviewError(
        "too_large",
        tooLargeMessage(hit.bytes.byteLength, options.maxBytes, "file"),
      );
    }
    return hit.bytes.slice();
  }
  if (hit) {
    cachedBytes -= hit.bytes.byteLength; // stale (the file changed, or the daemon cannot tell us): drop it
    cache.delete(key);
  }
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new PreviewError("too_large", tooLargeMessage(declared, options.maxBytes, "file"));
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > options.maxBytes) {
    throw new PreviewError(
      "too_large",
      `This file is ${formatBytes(buffer.byteLength)}, over the ${formatBytes(options.maxBytes)} preview limit. Open it to see everything.`,
    );
  }
  if (version !== "") remember(key, buffer, version);
  return buffer.slice();
}
