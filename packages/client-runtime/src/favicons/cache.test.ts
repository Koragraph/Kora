import { HostId } from "@kora/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import * as Favicons from "./cache.ts";

type Entry = Favicons.ProjectFaviconEntry;
type Storage = Favicons.ProjectFaviconStorage;

const PROJECT = { cwd: "/srv/app", hostId: HostId.make("h-fav") };
const ASSET = "https://fav.host.test/api/assets/sig-1/r1-mark.svg";
const ASSET_NEXT = "https://fav.host.test/api/assets/sig-1/r2-mark.svg";
const PNG_A = "data:image/png;base64,QUFB";
const PNG_B = "data:image/png;base64,QkJC";
const live = () => new AbortController().signal;

/** A promise plus the function that settles it. */
function deferred<T>() {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    settle = done;
  });
  return { promise, settle };
}

/** Storage kept in a Map; individual operations can be swapped out. */
class MapStorage implements Storage {
  readonly rows = new Map<string, Entry>();
  private readonly hooks: Partial<Storage>;
  constructor(hooks: Partial<Storage> = {}) {
    this.hooks = hooks;
  }
  list = async () => (this.hooks.list ? this.hooks.list() : [...this.rows.values()]);
  put = async (key: string, entry: Entry) => {
    if (this.hooks.put) return this.hooks.put(key, entry);
    this.rows.set(key, entry);
  };
  remove = async (key: string, entry: Entry) => {
    if (this.hooks.remove) return this.hooks.remove(key, entry);
    this.rows.delete(key);
  };
}

function setup(storage = new MapStorage()) {
  const load = vi.fn(async (): Promise<string> => PNG_A);
  return { storage, load, cache: Favicons.createProjectFaviconCache({ storage, load }) };
}
type Cache = ReturnType<typeof setup>["cache"];

/** Make the next load wait; resolves `started` when it begins. */
function pauseNextLoad(load: ReturnType<typeof setup>["load"]) {
  const result = deferred<string>();
  const started = deferred<void>();
  load.mockImplementationOnce(() => {
    started.settle();
    return result.promise;
  });
  return { result, started };
}

describe("project favicon cache", () => {
  it("restores a stored image in a new client before the host answers", async () => {
    const first = setup();
    const { storage, load } = first;
    await first.cache.resolve(PROJECT, ASSET, live()).then((image) => expect(image).toBe(PNG_A));
    await first.cache.flush();

    const next = Favicons.createProjectFaviconCache({ storage, load });
    await next.hydrate();
    expect(next.peek(PROJECT)).toBe(PNG_A);
    expect(await next.resolve(PROJECT, null, live())).toBe(PNG_A);
    expect(load).toHaveBeenCalledOnce();
  });

  it("reuses the image when only the signature or origin of the URL changes", async () => {
    const { cache, load } = setup();
    await cache.resolve(PROJECT, ASSET, live());
    const elsewhere = "https://other.host.test/api/assets/sig-9/r1-mark.svg";
    expect(await cache.resolve(PROJECT, elsewhere, live())).toBe(PNG_A);
    expect(load).toHaveBeenCalledOnce();
  });

  it("keys entries by host, folder and favicon choice", async () => {
    const { cache } = setup();
    await cache.resolve(PROJECT, ASSET, live());
    expect(cache.peek({ ...PROJECT, faviconPath: null })).toBe(PNG_A);
    for (const other of [
      { ...PROJECT, faviconPath: "logo.svg" },
      { ...PROJECT, cwd: "/srv/other" },
      { ...PROJECT, hostId: HostId.make("h-else") },
    ]) {
      expect(cache.peek(other)).toBeNull();
    }
  });

  it("keeps showing the old image during a refresh and after a failed one", async () => {
    const { cache, load, storage } = setup();
    await cache.resolve(PROJECT, ASSET, live());
    const { result } = pauseNextLoad(load);
    const refreshing = cache.resolve(PROJECT, ASSET_NEXT, live());
    expect(cache.peek(PROJECT)).toBe(PNG_A);
    result.settle(PNG_B);
    expect(await refreshing).toBe(PNG_B);

    load.mockRejectedValueOnce(new Error("network down"));
    expect(await cache.resolve(PROJECT, ASSET, live())).toBe(PNG_B);
    await cache.flush();
    expect(
      await Favicons.createProjectFaviconCache({ storage, load }).resolve(PROJECT, null, live()),
    ).toBe(PNG_B);
  });

  it("persists a confirmed 'no favicon' and ignores an aborted older load", async () => {
    const { cache, load, storage } = setup();
    await cache.resolve(PROJECT, ASSET, live());
    const { result, started } = pauseNextLoad(load);
    const cancel = new AbortController();
    const stale = cache.resolve(PROJECT, ASSET_NEXT, cancel.signal);
    await started.promise;
    cancel.abort();

    const missing = "https://fav.host.test/api/assets/sig-1/project-favicon-missing";
    expect(await cache.resolve(PROJECT, missing, live())).toBeNull();
    result.settle(PNG_B);
    await stale;
    await cache.flush();
    expect(
      await Favicons.createProjectFaviconCache({ storage, load }).resolve(PROJECT, null, live()),
    ).toBeNull();
  });

  it.each([
    { scope: "its host", clear: (cache: Cache) => cache.clearHost(PROJECT.hostId), left: 1 },
    { scope: "all hosts", clear: (cache: Cache) => cache.clearAll(), left: 0 },
  ])(
    "does not write back a load that finishes after $scope was cleared",
    async ({ clear, left }) => {
      const { cache, load, storage } = setup();
      await cache.resolve({ ...PROJECT, hostId: HostId.make("h-bystander") }, ASSET, live());
      const { result, started } = pauseNextLoad(load);
      const pending = cache.resolve(PROJECT, ASSET, live());
      await started.promise;
      await clear(cache);
      result.settle(PNG_A);
      await pending;
      await cache.flush();
      expect(cache.peek(PROJECT)).toBeNull();
      expect(storage.rows.size).toBe(left);
    },
  );

  it("does not let a load started during a host clear repopulate it", async () => {
    const removing = deferred<void>();
    const storage: MapStorage = new MapStorage({
      remove: async (key) => {
        await removing.promise;
        storage.rows.delete(key);
      },
    });
    const { cache, load } = setup(storage);
    await cache.resolve(PROJECT, ASSET, live());
    await cache.flush();

    const clearing = cache.clearHost(PROJECT.hostId);
    await Promise.resolve();
    const late = cache.resolve(PROJECT, ASSET_NEXT, live());
    removing.settle();
    await clearing;
    expect([storage.rows.size, cache.peek(PROJECT), load.mock.calls.length]).toEqual([0, null, 1]);
    expect(await late).toBe(PNG_A);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("enforces the per-image, total-bytes and entry-count limits", async () => {
    const { cache, load, storage } = setup();
    const limit = Favicons.PROJECT_FAVICON_MAX_DATA_URL_LENGTH;
    load.mockResolvedValueOnce(`data:image/png;base64,${"z".repeat(limit)}`);
    // Too big to cache: the remote URL is used instead.
    expect(await cache.resolve(PROJECT, ASSET, live())).toBe(ASSET);
    expect(cache.peek(PROJECT)).toBeNull();

    const large = `data:image/png;base64,${"z".repeat(limit - 32)}`;
    load.mockResolvedValue(large);
    for (let i = 0; i < 40; i += 1)
      await cache.resolve({ ...PROJECT, cwd: `/big/${i}` }, ASSET, live());
    await cache.flush();
    const total = [...storage.rows.values()].reduce((sum, { dataUrl }) => sum + dataUrl.length, 0);
    expect(total).toBeLessThanOrEqual(Favicons.PROJECT_FAVICON_CACHE_MAX_BYTES);
    expect([
      cache.peek({ ...PROJECT, cwd: "/big/0" }),
      cache.peek({ ...PROJECT, cwd: "/big/39" }),
    ]).toEqual([null, large]);

    load.mockResolvedValue(PNG_A);
    const max = Favicons.PROJECT_FAVICON_CACHE_MAX_ENTRIES;
    for (let i = 0; i <= max; i += 1)
      await cache.resolve({ ...PROJECT, cwd: `/small/${i}` }, ASSET, live());
    await cache.flush();
    expect(storage.rows.size).toBe(max);
    expect(cache.peek({ ...PROJECT, cwd: "/small/0" })).toBeNull();
  });

  it("ignores corrupt stored rows and survives storage that always fails", async () => {
    const corrupt = Favicons.createProjectFaviconCache({
      load: async () => PNG_B,
      storage: new MapStorage({
        list: async () =>
          [
            { ...PROJECT, faviconPath: null, revision: "r", dataUrl: PNG_A },
            { ...PROJECT, cwd: "/bad", faviconPath: null, revision: "r", dataUrl: "plain text" },
            42,
          ] as never,
      }),
    });
    await corrupt.hydrate();
    expect([corrupt.peek(PROJECT), corrupt.peek({ ...PROJECT, cwd: "/bad" })]).toEqual([
      PNG_A,
      null,
    ]);

    const reject = (why: string) => async (): Promise<never> => Promise.reject(new Error(why));
    const broken = Favicons.createProjectFaviconCache({
      load: async () => PNG_A,
      storage: { list: reject("no storage"), put: reject("full"), remove: reject("full") },
    });
    expect(await broken.resolve(PROJECT, ASSET, live())).toBe(PNG_A);
    await broken.flush();
    expect(broken.peek(PROJECT)).toBe(PNG_A);
  });
});

describe("project favicon loader", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle r="4"/></svg>';
  const svgDataUrl = `data:image/svg+xml;base64,${btoa(svg)}`;
  const respond = (body: BodyInit, type: string) =>
    new Response(body, { headers: { "content-type": type } });
  const loaderFor = (response: Response) => {
    const downscale = vi.fn(async () => PNG_B);
    return {
      downscale,
      load: Favicons.createProjectFaviconImageLoader({ downscale, fetch: async () => response }),
    };
  };

  it("inlines a small icon byte for byte", async () => {
    const { load, downscale } = loaderFor(respond(svg, "image/svg+xml; charset=utf-8"));
    expect(await load(ASSET, live())).toBe(svgDataUrl);
    expect(downscale).not.toHaveBeenCalled();
  });

  it("falls back to the file extension when the type is not an image type", async () => {
    expect(await loaderFor(respond(svg, "text/plain")).load(ASSET, live())).toBe(svgDataUrl);
  });

  it("downscales a big bitmap and refuses a big vector", async () => {
    const bytes = new Uint8Array(Favicons.PROJECT_FAVICON_MAX_DATA_URL_LENGTH);
    const png = loaderFor(respond(bytes, "image/png"));
    expect(await png.load("https://fav.host.test/api/assets/s/r1-mark.png", live())).toBe(PNG_B);
    expect(png.downscale).toHaveBeenCalledWith(
      expect.objectContaining({ bytes, mimeType: "image/png" }),
      expect.any(AbortSignal),
    );

    const vector = loaderFor(respond(bytes, "image/svg+xml"));
    await expect(vector.load(ASSET, live())).rejects.toThrow("exceeds the cache limit");
    expect(vector.downscale).not.toHaveBeenCalled();
  });

  it("stops reading past the source limit, streamed or declared", async () => {
    const megabyte = new Uint8Array(1 << 20);
    let reads = 0;
    const forever = new ReadableStream<Uint8Array>({
      pull(sink) {
        reads += 1;
        sink.enqueue(megabyte);
      },
    });
    const streamed = loaderFor(respond(forever, "image/png"));
    await expect(streamed.load(ASSET, live())).rejects.toThrow("too large");
    expect(reads).toBeLessThan(Favicons.PROJECT_FAVICON_MAX_SOURCE_BYTES / megabyte.byteLength + 3);
    expect(streamed.downscale).not.toHaveBeenCalled();

    const declared = new Response("x", {
      headers: { "content-length": String(2 ** 40), "content-type": "image/png" },
    });
    await expect(loaderFor(declared).load(ASSET, live())).rejects.toThrow("too large");
  });

  it("refuses HTTP errors and non-images", async () => {
    await expect(
      loaderFor(new Response("gone", { status: 404 })).load(ASSET, live()),
    ).rejects.toThrow("404");
    const page = loaderFor(respond("<p>hi</p>", "text/html"));
    await expect(
      page.load("https://fav.host.test/api/assets/s/r1-favicon", live()),
    ).rejects.toThrow("no image type");
  });
});
