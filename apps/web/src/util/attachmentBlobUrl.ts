import { useEffect, useState } from "react";
import type { ThreadId } from "@kora/contracts";
import { fetchPrimaryHost } from "../hosts/primary/shellAuth";

interface CacheEntry {
  url: string | null;
  refCount: number;
  promise: Promise<string | null>;
  evictTimer: ReturnType<typeof setTimeout> | null;
}

/** How long an unreferenced blob survives: timeline rows remount (optimistic → server message,
 *  virtualization) and would otherwise refetch the same bytes on every remount. */
const EVICT_AFTER_MS = 30_000;

const blobUrlCache = new Map<string, CacheEntry>();

function attachmentCacheKey(threadId: ThreadId, attachmentId: string): string {
  return `${threadId}\u0000${attachmentId}`;
}

async function fetchAttachmentBlobUrl(
  httpBaseUrl: string,
  threadId: ThreadId,
  attachmentId: string,
): Promise<string | null> {
  try {
    const url = new URL(`/api/attachments/${threadId}/${attachmentId}`, httpBaseUrl);
    const response = await fetchPrimaryHost(url.toString());
    if (!response.ok) return null;
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/**
 * Saves an attachment through the authed fetch path (a plain `window.open` of the API URL carries no bearer and
 * always 401s). The bytes are re-typed `application/octet-stream` and handed over as a download, never as a
 * navigable document: an attachment served as `text/html` or `image/svg+xml` must not run as a page.
 */
export async function downloadAttachment(
  httpBaseUrl: string,
  threadId: ThreadId,
  attachmentId: string,
  name: string,
): Promise<boolean> {
  const url = new URL(`/api/attachments/${threadId}/${attachmentId}`, httpBaseUrl);
  const response = await fetchPrimaryHost(url.toString());
  if (!response.ok) return false;
  const bytes = await response.blob();
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = name.trim() || "attachment";
    anchor.rel = "noopener";
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
  return true;
}

/**
 * Fetches an attachment's bytes as an authed blob URL and caches it by
 * (thread, attachment) id, ref-counted across mounts so the lightbox and its
 * thumbnail can share one fetch. Revoked once nothing references it anymore.
 */
export function useAttachmentBlobUrl(
  httpBaseUrl: string | null,
  threadId: ThreadId | null,
  attachmentId: string | null,
): { url: string | null; loading: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!httpBaseUrl || !threadId || !attachmentId) {
      setUrl(null);
      setLoading(false);
      return;
    }
    const key = attachmentCacheKey(threadId, attachmentId);
    let cancelled = false;
    let entry = blobUrlCache.get(key);
    if (!entry) {
      const promise = fetchAttachmentBlobUrl(httpBaseUrl, threadId, attachmentId);
      entry = { url: null, refCount: 0, promise, evictTimer: null };
      blobUrlCache.set(key, entry);
      void promise.then((resolvedUrl) => {
        const current = blobUrlCache.get(key);
        if (current) current.url = resolvedUrl;
      });
    }
    entry.refCount += 1;
    if (entry.evictTimer) {
      clearTimeout(entry.evictTimer);
      entry.evictTimer = null;
    }
    if (entry.url) {
      setUrl(entry.url);
    } else {
      setLoading(true);
      void entry.promise.then((resolvedUrl) => {
        if (!cancelled) {
          setUrl(resolvedUrl);
          setLoading(false);
        }
      });
    }
    return () => {
      cancelled = true;
      const current = blobUrlCache.get(key);
      if (!current) return;
      current.refCount -= 1;
      if (current.refCount <= 0 && !current.evictTimer) {
        current.evictTimer = setTimeout(() => {
          if (current.refCount > 0 || blobUrlCache.get(key) !== current) return;
          blobUrlCache.delete(key);
          void current.promise.then((resolvedUrl) => {
            if (resolvedUrl) URL.revokeObjectURL(resolvedUrl);
          });
        }, EVICT_AFTER_MS);
      }
    };
  }, [httpBaseUrl, threadId, attachmentId]);

  return { url, loading };
}

/** @public Kept for tests and external callers (knip). */
export function __resetAttachmentBlobUrlCacheForTests(): void {
  for (const entry of blobUrlCache.values()) {
    if (entry.evictTimer) clearTimeout(entry.evictTimer);
    void entry.promise.then((resolvedUrl) => {
      if (resolvedUrl) URL.revokeObjectURL(resolvedUrl);
    });
  }
  blobUrlCache.clear();
}
