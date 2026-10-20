import type { HostId } from "@kora/contracts";
import { mediaMimeType } from "@kora/shared/fileViewer";
import {
  isProjectFaviconFallbackUrl,
  getProjectFaviconResourceKey,
  getProjectFaviconCacheKey,
} from "@kora/shared/faviconKeys";
import * as Encoding from "effect/Encoding";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const KIB = 1024;
const MIB = KIB * KIB;

/** Total data-URL characters kept across all entries. */
export const PROJECT_FAVICON_CACHE_MAX_BYTES = MIB;
export const PROJECT_FAVICON_CACHE_MAX_ENTRIES = 128;
export const PROJECT_FAVICON_MAX_DATA_URL_LENGTH = 32 * KIB;
/** Larger sources are left to the remote URL. */
export const PROJECT_FAVICON_MAX_SOURCE_BYTES = MIB * 4;
/** Edge of the square thumbnail, in pixels. */
export const PROJECT_FAVICON_THUMBNAIL_SIZE = 96;

/** Which project's favicon: the host, the project folder and an optional explicit icon path. */
export type ProjectFaviconTarget = Readonly<{
  cwd: string;
  hostId: HostId;
  faviconPath?: string | null;
}>;

export type ProjectFaviconEntry = {
  hostId: HostId;
  cwd: string;
  faviconPath: string | null;
  revision: string;
  dataUrl: string;
};

export interface ProjectFaviconStorage {
  /** Invalid records are ignored. */
  list(): Promise<ReadonlyArray<unknown>>;
  put(key: string, entry: ProjectFaviconEntry): Promise<void>;
  remove(key: string, entry: ProjectFaviconEntry): Promise<void>;
}

const IMAGE_DATA_URL =
  /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/;

const isImageDataUrl = (value: string): boolean =>
  value.length <= PROJECT_FAVICON_MAX_DATA_URL_LENGTH && IMAGE_DATA_URL.test(value);

const StoredEntry = Schema.Struct({
  hostId: Schema.String,
  revision: Schema.String,
  faviconPath: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  dataUrl: Schema.String.check(Schema.isMaxLength(PROJECT_FAVICON_MAX_DATA_URL_LENGTH)),
});
const decodeStoredEntry = Schema.decodeUnknownOption(StoredEntry);

const keyOf = (entry: { hostId: string; cwd: string; faviconPath: string | null }) =>
  getProjectFaviconResourceKey(entry.hostId, entry.cwd, entry.faviconPath);

// ---- Loading an icon into a data URL -----------------------------------------------------

async function readBounded(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const tooLarge = () => new Error("Project icon is too large to decode.");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PROJECT_FAVICON_MAX_SOURCE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > PROJECT_FAVICON_MAX_SOURCE_BYTES) throw tooLarge();
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const step = await reader.read();
      if (step.done) break;
      const value = step.value;
      total += value.byteLength;
      if (total > PROJECT_FAVICON_MAX_SOURCE_BYTES) throw tooLarge();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  chunks.reduce((offset, chunk) => {
    bytes.set(chunk, offset);
    return offset + chunk.byteLength;
  }, 0);
  return bytes;
}

export function createProjectFaviconImageLoader(input: {
  fetch?: typeof fetch;
  downscale(
    image: { url: string; mimeType: string; bytes: Uint8Array },
    signal: AbortSignal,
  ): Promise<string>;
}): (url: string, signal: AbortSignal) => Promise<string> {
  return async (url, signal) => {
    const response = await (input.fetch ?? fetch)(url, { signal });
    if (!response.ok) throw new Error(`Project icon request failed with ${response.status}.`);

    const served = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const guessed = mediaMimeType(url);
    const mimeType = served.startsWith("image/")
      ? served
      : guessed?.startsWith("image/")
        ? guessed
        : null;
    if (mimeType === null) throw new Error("Project icon has no image type.");

    const bytes = await readBounded(response, signal);
    signal.throwIfAborted();

    const inline = `data:${mimeType};base64,${Encoding.encodeBase64(bytes)}`;
    if (isImageDataUrl(inline)) return inline;
    // Rasterising an SVG that has no intrinsic size is unreliable, so oversized vectors are refused.
    if (mimeType !== "image/svg+xml") return input.downscale({ url, mimeType, bytes }, signal);
    throw new Error("Project icon exceeds the cache limit.");
  };
}

// ---- The cache ---------------------------------------------------------------------------

export function createProjectFaviconCache(input: {
  storage: ProjectFaviconStorage;
  load: (url: string, signal: AbortSignal) => Promise<string>;
}) {
  const { storage, load } = input;
  // Insertion order doubles as recency order.
  const entries = new Map<string, ProjectFaviconEntry>();
  const pending = new Set<Promise<unknown>>();
  const hostRevisions = new Map<string, number>();
  let generation = 0;
  let hydrating: Promise<void> | null = null;
  let clearTail: Promise<void> = Promise.resolve();

  const track = (work: Promise<unknown>): void => {
    const safe = work.catch(() => {});
    pending.add(safe);
    void safe.then(() => pending.delete(safe));
  };

  const persistRemoval = (key: string, entry: ProjectFaviconEntry) =>
    track(Promise.resolve().then(() => storage.remove(key, entry)));

  const drop = (key: string): void => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    persistRemoval(key, entry);
  };

  const trim = (): void => {
    let total = 0;
    for (const entry of entries.values()) total += entry.dataUrl.length;
    for (const [key, entry] of entries) {
      if (
        entries.size <= PROJECT_FAVICON_CACHE_MAX_ENTRIES &&
        total <= PROJECT_FAVICON_CACHE_MAX_BYTES
      ) {
        break;
      }
      total -= entry.dataUrl.length;
      drop(key);
    }
  };

  const hydrate = (): Promise<void> => {
    hydrating ??= (async () => {
      try {
        for (const record of await storage.list()) {
          const decoded = decodeStoredEntry(record);
          if (Option.isNone(decoded) || !isImageDataUrl(decoded.value.dataUrl)) continue;
          const entry = decoded.value as ProjectFaviconEntry;
          const key = keyOf(entry);
          if (!entries.has(key)) entries.set(key, entry);
        }
        trim();
      } catch {
        // A missing or corrupt cache must never block startup.
      }
    })();
    return hydrating;
  };

  const peek = (target: ProjectFaviconTarget): string | null =>
    entries.get(getProjectFaviconResourceKey(target.hostId, target.cwd, target.faviconPath))
      ?.dataUrl ?? null;

  const resolve = async (
    project: ProjectFaviconTarget,
    remoteUrl: string | null,
    abort: AbortSignal,
  ): Promise<string | null> => {
    const [target, url, signal] = [project, remoteUrl, abort] as const;
    await clearTail;
    const startedGeneration = generation;
    const startedHostRevision = hostRevisions.get(target.hostId) ?? 0;
    const cleared = () =>
      generation !== startedGeneration ||
      (hostRevisions.get(target.hostId) ?? 0) !== startedHostRevision;

    await hydrate();
    if (signal.aborted || url === null) return peek(target);

    const key = getProjectFaviconResourceKey(target.hostId, target.cwd, target.faviconPath);
    if (isProjectFaviconFallbackUrl(url)) {
      drop(key);
      return null;
    }

    const revision = getProjectFaviconCacheKey(target.hostId, target.cwd, url);
    const cached = entries.get(key);
    if (cached !== undefined) {
      // Re-insert so the entry becomes the most recently used.
      entries.set(key, (entries.delete(key), cached));
      if (cached.revision === revision) return cached.dataUrl;
    }

    try {
      const dataUrl = await load(url, signal);
      if (signal.aborted || cleared()) return peek(target);
      if (isImageDataUrl(dataUrl)) {
        const entry: ProjectFaviconEntry = {
          hostId: target.hostId,
          cwd: target.cwd,
          faviconPath: target.faviconPath || null,
          revision,
          dataUrl,
        };
        entries.delete(key);
        entries.set(key, entry);
        track(Promise.resolve().then(() => storage.put(key, entry)));
        trim();
        return dataUrl;
      }
    } catch {
      // Keep showing the last good image.
    }
    return peek(target) ?? url;
  };

  const clearMatching = (matches: (entry: ProjectFaviconEntry) => boolean): Promise<void> => {
    const previous = clearTail;
    const run = (async () => {
      await previous;
      await hydrate();
      for (const [key, entry] of [...entries]) {
        if (!matches(entry)) continue;
        entries.delete(key);
        persistRemoval(key, entry);
      }
      await flush();
    })();
    clearTail = run;
    return run;
  };

  const clearHost = (hostId: HostId): Promise<void> => {
    hostRevisions.set(hostId, (hostRevisions.get(hostId) ?? 0) + 1);
    return clearMatching((entry) => entry.hostId === hostId);
  };

  const clearAll = (): Promise<void> => {
    generation += 1;
    return clearMatching(() => true);
  };

  async function flush(): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending]);
  }

  return { hydrate, peek, resolve, clearHost, clearAll, flush };
}

export type ProjectFaviconCache = ReturnType<typeof createProjectFaviconCache>;
