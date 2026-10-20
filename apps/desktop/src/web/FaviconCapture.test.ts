import { describe, expect, it, vi } from "vite-plus/test";

import {
  captureFavicon,
  isPrivateNetworkHost,
  MAX_FAVICON_CANDIDATES,
  MAX_FAVICON_RESPONSE_BYTES,
  privateIconTarget,
  selectFaviconCandidates,
} from "./FaviconCapture.ts";

const RASTER_RESULT = "data:image/png;base64,cG5n";
const PAGE_URL = "https://example.com/page";
const FAVICON_URL = "https://example.com/favicon.png";

// ---------------------------------------------------------------------------
// Image fixtures: just enough header bytes for the size sniffing to work with.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const pngOfSize = (width: number, height: number): Buffer => {
  const png = Buffer.alloc(24);
  Buffer.from(PNG_SIGNATURE).copy(png);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
};

const TINY_PNG = pngOfSize(1, 1);
const HUGE_PNG = pngOfSize(4096, 4096);
const asDataUrl = (mime: string, bytes: Uint8Array) =>
  `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
const TINY_PNG_URL = asDataUrl("image/png", TINY_PNG);
const svg = (inner: string) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">${inner}</svg>`);

/** One image in a GIF: its size, and where it sits on the logical screen (0,0 by default). */
type GifFrame = { readonly width: number; readonly height: number } & Partial<
  Record<"left" | "top", number>
>;

const gifOf = (
  width: number,
  height: number,
  firstFrame: GifFrame = { width, height },
  laterFrames: ReadonlyArray<GifFrame> = [],
): Buffer => {
  const frames = [firstFrame, ...laterFrames];
  const gif = Buffer.alloc(13 + frames.length * 12 + 1);
  gif.write("GIF89a", 0, "ascii");
  gif.writeUInt16LE(width, 6);
  gif.writeUInt16LE(height, 8);
  frames.forEach((frame, index) => {
    const at = 13 + index * 12;
    gif[at] = 0x2c;
    gif.writeUInt16LE(frame.left ?? 0, at + 1);
    gif.writeUInt16LE(frame.top ?? 0, at + 3);
    gif.writeUInt16LE(frame.width, at + 5);
    gif.writeUInt16LE(frame.height, at + 7);
    gif[at + 10] = 2;
    gif[at + 11] = 0;
  });
  gif[13 + frames.length * 12] = 0x3b;
  return gif;
};

const webpOf = (width: number, height: number): Buffer => {
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp.writeUIntLE(width - 1, 24, 3);
  webp.writeUIntLE(height - 1, 27, 3);
  return webp;
};

const icoAround = (image: Buffer, declaredLength = image.byteLength): Buffer => {
  const ico = Buffer.alloc(22 + image.byteLength);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico.writeUInt32LE(declaredLength, 14);
  ico.writeUInt32LE(22, 18);
  image.copy(ico, 22);
  return ico;
};

const hugeDib = (): Buffer => {
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(4096, 4);
  dib.writeInt32LE(4096, 8);
  return dib;
};

// JPEG with EXIF orientation: SOI, [APP1 ...], SOF0 frame header.
const jpegFrameHeader = (width: number, height: number): Buffer => {
  // SOI marker, then a start-of-frame segment: length 7, 8-bit samples, height and width big-endian.
  const header = Buffer.from("ffd8ffc0000708", "hex");
  const size = Buffer.alloc(4);
  size.writeUInt16BE(height, 0);
  size.writeUInt16BE(width, 2);
  return Buffer.concat([header, size]);
};

const withApp1 = (width: number, height: number, segments: ReadonlyArray<Buffer>): Buffer => {
  const header = jpegFrameHeader(width, height);
  return Buffer.concat([header.subarray(0, 2), ...segments, header.subarray(2)]);
};

const app1Of = (payload: Buffer): Buffer => {
  const segment = Buffer.alloc(4 + payload.byteLength);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.byteLength + 2, 2);
  payload.copy(segment, 4);
  return segment;
};

const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_SUB_IFD = 0x8769;
const ROOT_IFD = 14;
const IFD_ENTRY_SIZE = 12;

/** Endian-aware field writer over an EXIF block. */
const exifWriter = (exif: Buffer, littleEndian = true) => {
  const u16 = (at: number, value: number) =>
    littleEndian ? exif.writeUInt16LE(value, at) : exif.writeUInt16BE(value, at);
  const u32 = (at: number, value: number) =>
    littleEndian ? exif.writeUInt32LE(value, at) : exif.writeUInt32BE(value, at);
  return {
    u16,
    u32,
    orientationEntry: (at: number, orientation: number) => {
      u16(at, TAG_ORIENTATION);
      u16(at + 2, 3);
      u32(at + 4, 1);
      u16(at + 8, orientation);
    },
    subIfdEntry: (at: number, target: number) => {
      u16(at, TAG_EXIF_SUB_IFD);
      u16(at + 2, 4);
      u32(at + 4, 1);
      u32(at + 8, target);
    },
  };
};

/** The TIFF preamble every fixture shares: "Exif\0\0", byte order, optional magic, IFD0 offset. */
const startExif = (size: number, order: "II" | "MM" = "II", magic: number | null = 42) => {
  const exif = Buffer.alloc(size);
  exif.write("Exif\0\0", 0, "binary");
  exif.write(order, 6, "ascii");
  const writer = exifWriter(exif, order === "II");
  if (magic !== null) writer.u16(8, magic);
  writer.u32(10, 8);
  return { exif, writer };
};

/** An APP1 EXIF segment whose root IFD lists `orientations`; little-endian ("II") TIFF magic 42 unless told otherwise. */
const exifOrientations = (
  orientations: ReadonlyArray<number>,
  {
    byteOrder = "II",
    magic = 42,
    padding = 0,
  }: { byteOrder?: "II" | "MM"; magic?: number; padding?: number } = {},
): Buffer => {
  const { exif, writer } = startExif(20 + orientations.length * IFD_ENTRY_SIZE, byteOrder, magic);
  exif[5] = padding;
  writer.u16(ROOT_IFD, orientations.length);
  orientations.forEach((orientation, index) => {
    writer.orientationEntry(16 + index * IFD_ENTRY_SIZE, orientation);
  });
  return app1Of(exif);
};

/** A JPEG of the given size with one EXIF segment per orientation tag. */
const jpegOf = (
  width: number,
  height: number,
  orientation: number | ReadonlyArray<number> = [],
): Buffer => {
  const tags = Array.isArray(orientation) ? orientation : [orientation as number];
  return withApp1(
    width,
    height,
    tags.map((tag) => exifOrientations([tag])),
  );
};

const jpegWithOrientationList = (orientations: ReadonlyArray<number>) =>
  withApp1(64, 32, [exifOrientations(orientations)]);

const jpegWithAliasedByteOrder = (alias: number, byteOrder: "II" | "MM"): Buffer => {
  const segment = exifOrientations([6], { byteOrder });
  segment[10] = alias;
  segment[11] = alias;
  return withApp1(64, 32, [segment]);
};

/**
 * EXIF whose orientation sits in a sub-IFD (`subIfdOrientation`), optionally with another one in the root IFD,
 * listed before or after the sub-IFD pointer.
 */
const exifWithSubIfd = (options: {
  subIfdOrientation: number;
  rootOrientation?: number;
  subIfdFirst?: boolean;
}): Buffer => {
  const rootCount = options.rootOrientation === undefined ? 1 : 2;
  const subIfd = ROOT_IFD + 2 + rootCount * IFD_ENTRY_SIZE + 4;
  const { exif, writer } = startExif(subIfd + 2 + IFD_ENTRY_SIZE + 4);
  writer.u16(ROOT_IFD, rootCount);

  const firstEntry = ROOT_IFD + 2;
  const pointer = () => writer.subIfdEntry(firstEntry, subIfd - 6);
  if (options.rootOrientation === undefined) {
    pointer();
  } else if (options.subIfdFirst) {
    pointer();
    writer.orientationEntry(firstEntry + IFD_ENTRY_SIZE, options.rootOrientation);
  } else {
    writer.orientationEntry(firstEntry, options.rootOrientation);
    writer.subIfdEntry(firstEntry + IFD_ENTRY_SIZE, subIfd - 6);
  }

  writer.u16(subIfd, 1);
  writer.orientationEntry(subIfd + 2, options.subIfdOrientation);
  return app1Of(exif);
};

const exifWithRepeatedSubIfdPointers = (pointerCount: number, subIfdEntries: number): Buffer => {
  const rootCount = pointerCount + 1;
  const subIfd = ROOT_IFD + 2 + rootCount * IFD_ENTRY_SIZE + 4;
  const { exif, writer } = startExif(subIfd + 2 + subIfdEntries * IFD_ENTRY_SIZE + 4);
  writer.u16(ROOT_IFD, rootCount);
  for (let n = 0; n < pointerCount; n += 1) {
    writer.subIfdEntry(ROOT_IFD + 2 + n * IFD_ENTRY_SIZE, subIfd - 6);
  }
  writer.orientationEntry(ROOT_IFD + 2 + pointerCount * IFD_ENTRY_SIZE, 6);

  writer.u16(subIfd, subIfdEntries);
  for (let n = 0; n < subIfdEntries; n += 1) {
    const at = subIfd + 2 + n * IFD_ENTRY_SIZE;
    writer.u16(at, 1);
    writer.u16(at + 2, 3);
    writer.u32(at + 4, 1);
  }
  return app1Of(exif);
};

const exifWithStaggeredSubIfds = (pointerCount: number, subIfdEntries: number): Buffer => {
  const rootCount = pointerCount + 1;
  const subIfd = ROOT_IFD + 2 + rootCount * IFD_ENTRY_SIZE + 4;
  const { exif, writer } = startExif(
    subIfd + pointerCount * 2 + 2 + subIfdEntries * IFD_ENTRY_SIZE,
    "II",
    null,
  );
  writer.u16(ROOT_IFD, rootCount);
  for (let n = 0; n < pointerCount; n += 1) {
    writer.subIfdEntry(ROOT_IFD + 2 + n * IFD_ENTRY_SIZE, subIfd + n * 2 - 6);
    writer.u16(subIfd + n * 2, subIfdEntries);
  }
  writer.orientationEntry(ROOT_IFD + 2 + pointerCount * IFD_ENTRY_SIZE, 6);
  return app1Of(exif);
};

// ---------------------------------------------------------------------------
// WebContents double and capture helpers
// ---------------------------------------------------------------------------

const pngResponse = (bytes: Uint8Array = TINY_PNG) =>
  new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } });

function makeGuest(options?: {
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly rasterize?: (code: string) => Promise<unknown>;
}) {
  const fetch = vi.fn(options?.fetch ?? (async () => pngResponse()));
  const executeJavaScriptInIsolatedWorld = vi.fn(
    async (_worldId: number, scripts: ReadonlyArray<{ readonly code: string }>) =>
      options?.rasterize ? options.rasterize(scripts[0]?.code ?? "") : RASTER_RESULT,
  );
  return {
    webContents: { session: { fetch }, executeJavaScriptInIsolatedWorld } as never,
    executeJavaScriptInIsolatedWorld,
    fetch,
  };
}

type Guest = ReturnType<typeof makeGuest>["webContents"];

const grab = (
  webContents: Guest,
  candidates: string[],
  signal: AbortSignal = new AbortController().signal,
) => captureFavicon({ webContents, pageUrl: PAGE_URL, candidates, signal });

const CAPTURED = { kind: "captured", dataUrl: RASTER_RESULT } as const;
const NOTHING = { kind: "none" } as const;
const TIMED_OUT = { kind: "timed-out" } as const;

/** A fetch whose Response only resolves for the second candidate. */
const failFirstThenSucceed =
  (firstBody: BodyInit | null = null) =>
  async (url: string) =>
    url.endsWith("first.png") ? new Response(firstBody, { status: 404 }) : pngResponse();

/** A fetch that never answers on its own and rejects as soon as it is aborted. */
const hangingFetch = (_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });

const pendingRaster = () => {
  let release!: (value: unknown) => void;
  const promise = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  return { promise, release: (value: unknown) => release(value) };
};

const timeoutError = () => new DOMException("capture timed out", "TimeoutError");

/** A response body that yields chunks of the given byte sizes and never closes; `cancel` records release. */
const streamOf = (chunkSizes: ReadonlyArray<number>) => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    cancel,
    start: (c) => chunkSizes.forEach((n) => c.enqueue(new Uint8Array(n))),
  });
  return { body, cancel };
};

/** What the rasterizer is asked for to fit a w x h image into the 32x32 icon, centred. */
const fitInto32 = (w: number, h: number) => {
  const [x, y] = [(32 - w) / 2, (32 - h) / 2];
  return {
    w,
    h,
    size: [`resizeWidth: ${w}`, `resizeHeight: ${h}`],
    draw: `context.drawImage(bitmap, ${x}, ${y}, ${w}, ${h})`,
  };
};
const LANDSCAPE_JPEG = fitInto32(32, 16);
const PORTRAIT_JPEG = fitInto32(16, 32);

const expectJpegLayout = async (
  source: Buffer,
  layout: typeof LANDSCAPE_JPEG | typeof PORTRAIT_JPEG,
) => {
  const { webContents } = makeGuest({
    rasterize: async (code) => {
      for (const part of [...layout.size, layout.draw]) expect(code).toContain(part);
      return RASTER_RESULT;
    },
  });

  expect(await grab(webContents, [asDataUrl("image/jpeg", source)])).toEqual(CAPTURED);
};

// ---------------------------------------------------------------------------

describe("selectFaviconCandidates", () => {
  it("drops unusable and repeated URLs first, then caps the list", () => {
    const usable = Array.from(
      { length: MAX_FAVICON_CANDIDATES + 2 },
      (_, n) => `https://example.com/favicon-${n}.png`,
    );
    const noisy = [
      ...Array.from({ length: 64 }, () => "javascript:alert(1)"),
      usable[0]!,
      usable[0]!,
      ...usable.slice(1),
    ];

    expect(selectFaviconCandidates(noisy)).toEqual(usable.slice(0, MAX_FAVICON_CANDIDATES));
  });

  it("limits how many raw entries it scans, whatever the usable cap is", () => {
    const junk = `javascript:${"x".repeat(2_048)}`;
    const input = [...Array.from({ length: 128 }, () => junk), "https://example.com/too-late.png"];

    expect(selectFaviconCandidates(input)).toEqual([]);
  });
});

describe("captureFavicon", () => {
  describe("fetching", () => {
    it.each([
      {
        scope: "same-origin",
        faviconUrl: FAVICON_URL,
        credentials: "include",
      },
      {
        scope: "cross-origin",
        faviconUrl: "https://cdn.example.net/favicon.png",
        credentials: "omit",
      },
    ])(
      "sends credentials: $credentials on a $scope request",
      async ({ faviconUrl, credentials }) => {
        const { webContents, fetch } = makeGuest();

        expect(await grab(webContents, [faviconUrl])).toEqual(CAPTURED);
        expect(fetch).toHaveBeenCalledWith(
          faviconUrl,
          expect.objectContaining({ credentials, redirect: "error" }),
        );
      },
    );

    it("reads base64 and percent-encoded inline images without any request", async () => {
      const { webContents, fetch, executeJavaScriptInIsolatedWorld } = makeGuest();
      const percentEncoded = [...TINY_PNG]
        .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
        .join("");

      for (const inline of [TINY_PNG_URL, `data:image/png,${percentEncoded}`]) {
        expect(await grab(webContents, [inline])).toEqual(CAPTURED);
      }

      expect(fetch).not.toHaveBeenCalled();
      expect(executeJavaScriptInIsolatedWorld.mock.calls).toHaveLength(2);
    });

    it("falls through to the next candidate when one is turned down", async () => {
      const { webContents, fetch } = makeGuest({ fetch: failFirstThenSucceed() });

      const result = await grab(webContents, [
        "https://example.com/first.png",
        "https://example.com/second.png",
      ]);

      expect(result).toEqual(CAPTURED);
      expect(fetch.mock.calls).toHaveLength(2);
    });

    it("releases a rejected response's body before moving to the next candidate", async () => {
      const { body, cancel } = streamOf([1]);
      const { webContents, fetch } = makeGuest({ fetch: failFirstThenSucceed(body) });

      const result = await grab(webContents, [
        "https://example.com/first.png",
        "https://example.com/second.png",
      ]);

      expect(result).toEqual(CAPTURED);
      expect(cancel.mock.calls).toHaveLength(1);
      expect(fetch.mock.calls).toHaveLength(2);
    });

    it("rejects an oversized streamed body and cancels it", async () => {
      // Exactly the limit, then one byte more.
      const { body, cancel } = streamOf([MAX_FAVICON_RESPONSE_BYTES, 1]);
      const { webContents, executeJavaScriptInIsolatedWorld } = makeGuest({
        fetch: async () => new Response(body, { headers: { "content-type": "image/png" } }),
      });

      expect(await grab(webContents, [FAVICON_URL])).toEqual(NOTHING);
      expect(cancel.mock.calls).toHaveLength(1);
      expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    });

    it("aborts a request that is still pending when the caller aborts", async () => {
      const controller = new AbortController();
      const { webContents } = makeGuest({ fetch: hangingFetch });
      const outcome = grab(webContents, [FAVICON_URL], controller.signal);

      controller.abort();

      expect(await outcome).toEqual(NOTHING);
    });
  });

  describe("deadlines", () => {
    it("stops trying further candidates once the overall deadline passes", async () => {
      const deadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      const { webContents, fetch } = makeGuest({
        fetch: (url, init) =>
          url.endsWith("first.png")
            ? Promise.resolve(new Response(null, { status: 404 }))
            : hangingFetch(url, init),
      });
      try {
        const outcome = grab(
          webContents,
          ["first", "second", "third"].map((n) => `https://example.com/${n}.png`),
        );
        // The first 404s, the second hangs until the overall deadline: the third is never tried.
        await vi.waitFor(() => expect(fetch.mock.calls.length).toBe(2));
        deadline.abort(timeoutError());
        expect(await outcome).toEqual(TIMED_OUT);
        expect([fetch.mock.calls.length, timeout.mock.calls.length]).toEqual([2, 1]);
      } finally {
        timeout.mockRestore();
      }
    });

    it("discards a rasterization that finishes after the capture deadline", async () => {
      const captureDeadline = new AbortController();
      const rasterDeadline = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) =>
          ms === 5_000 ? captureDeadline.signal : rasterDeadline.signal,
        );
      const raster = pendingRaster();
      const { webContents, executeJavaScriptInIsolatedWorld } = makeGuest({
        rasterize: () => raster.promise,
      });
      try {
        const outcome = grab(webContents, [TINY_PNG_URL]);
        await vi.waitFor(() => expect(executeJavaScriptInIsolatedWorld.mock.calls).toHaveLength(1));
        captureDeadline.abort(timeoutError());

        expect(await outcome).toEqual(TIMED_OUT);
        raster.release(RASTER_RESULT);
      } finally {
        timeout.mockRestore();
      }
    });

    it("cancels a body that stalls past the capture deadline", async () => {
      const deadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      const cancel = vi.fn();
      const { webContents } = makeGuest({
        fetch: async () =>
          new Response(new ReadableStream<Uint8Array>({ cancel }), {
            headers: { "content-type": "image/png" },
          }),
      });
      try {
        const outcome = grab(webContents, [FAVICON_URL]);
        deadline.abort(timeoutError());

        expect(await outcome).toEqual(TIMED_OUT);
        expect(cancel.mock.calls).toHaveLength(1);
      } finally {
        timeout.mockRestore();
      }
    });

    it("lets the stuck rasterization settle before running a newer one after a timeout", async () => {
      vi.useFakeTimers();
      try {
        const stuck = pendingRaster();
        let runs = 0;
        const { webContents } = makeGuest({
          rasterize: () => {
            runs += 1;
            return runs === 1 ? stuck.promise : Promise.resolve(RASTER_RESULT);
          },
        });
        const timedOut = grab(webContents, [TINY_PNG_URL]);
        await vi.advanceTimersByTimeAsync(1_001);
        expect(await timedOut).toEqual(TIMED_OUT);

        const newer = grab(webContents, [TINY_PNG_URL]);
        await Promise.resolve();
        expect(runs).toBe(1);
        stuck.release(RASTER_RESULT);
        expect(await newer).toEqual(CAPTURED);
        expect(runs).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not move on to the next candidate after a rasterization times out", async () => {
      vi.useFakeTimers();
      try {
        const stuck = pendingRaster();
        const { webContents, fetch, executeJavaScriptInIsolatedWorld } = makeGuest({
          rasterize: () => stuck.promise,
        });
        const outcome = grab(webContents, [
          "https://example.com/first.png",
          "https://example.com/second.png",
        ]);

        await vi.advanceTimersByTimeAsync(1_001);

        expect(await outcome).toEqual(TIMED_OUT);
        expect(fetch.mock.calls).toHaveLength(1);
        expect(executeJavaScriptInIsolatedWorld.mock.calls).toHaveLength(1);
        stuck.release(RASTER_RESULT);
      } finally {
        vi.useRealTimers();
      }
    });

    it("runs only the newest of several queued rasterizations", async () => {
      const first = pendingRaster();
      let runs = 0;
      const { webContents } = makeGuest({
        rasterize: () => {
          runs += 1;
          return runs === 1 ? first.promise : Promise.resolve(RASTER_RESULT);
        },
      });
      const launched = [1, 2, 3].map(() => grab(webContents, [TINY_PNG_URL]));

      expect(runs).toBe(1);
      first.release(RASTER_RESULT);
      expect(await Promise.all(launched)).toEqual([CAPTURED, NOTHING, CAPTURED]);
      expect(runs).toBe(2);
    });
  });

  describe("image formats", () => {
    it("accepts the common favicon formats within bounds", async () => {
      const { webContents, executeJavaScriptInIsolatedWorld } = makeGuest();
      const samples: ReadonlyArray<readonly [string, Buffer]> = [
        ["image/gif", gifOf(32, 32)],
        ["image/jpeg", jpegOf(32, 32)],
        ["image/webp", webpOf(32, 32)],
        ["image/x-icon", icoAround(TINY_PNG)],
      ];

      for (const [mime, bytes] of samples) {
        expect(await grab(webContents, [asDataUrl(mime, bytes)])).toEqual(CAPTURED);
      }
      expect(executeJavaScriptInIsolatedWorld.mock.calls).toHaveLength(4);
    });

    it.each([
      { shape: "landscape", source: pngOfSize(64, 32), layout: LANDSCAPE_JPEG },
      { shape: "portrait", source: pngOfSize(32, 64), layout: PORTRAIT_JPEG },
    ])("scales a $shape image to fit 32x32 without distorting it", async ({ source, layout }) => {
      const { webContents } = makeGuest({
        rasterize: async (code) => {
          for (const part of [...layout.size, 'resizeQuality: "high"', layout.draw]) {
            expect(code).toContain(part);
          }
          return RASTER_RESULT;
        },
      });

      expect(await grab(webContents, [asDataUrl("image/png", source)])).toEqual(CAPTURED);
    });

    it("ignores rasterizer output that is not a bounded PNG data URL", async () => {
      const { webContents } = makeGuest({
        rasterize: async () => "data:image/svg+xml;base64,c3Zn",
      });

      expect(await grab(webContents, [TINY_PNG_URL])).toEqual(NOTHING);
    });

    describe("unsafe sources", () => {
      const rawIco = (() => {
        const ico = Buffer.alloc(22);
        ico.writeUInt16LE(1, 2);
        ico.writeUInt16LE(1, 4);
        ico.writeUInt32LE(100, 14);
        ico.writeUInt32LE(22, 18);
        return ico;
      })();
      const manyFrames = Array.from({ length: 256 }, () => ({ width: 64, height: 64 }));

      it.each([
        ["GIF", "image/gif", gifOf(4096, 4096)],
        ["GIF frame", "image/gif", gifOf(1, 1, { width: 4096, height: 4096 })],
        [
          "GIF later frame",
          "image/gif",
          gifOf(1, 1, { width: 1, height: 1 }, [{ width: 4096, height: 4096 }]),
        ],
        [
          "GIF cumulative frames",
          "image/gif",
          gifOf(64, 64, { width: 64, height: 64 }, manyFrames),
        ],
        ["JPEG", "image/jpeg", jpegOf(4096, 4096)],
        ["WebP", "image/webp", webpOf(4096, 4096)],
        ["ICO with PNG", "image/x-icon", icoAround(HUGE_PNG)],
        ["ICO with DIB", "image/x-icon", icoAround(hugeDib())],
        // SVG is never rasterized: it can pull anything in, a giant bitmap included.
        ["SVG", "image/svg+xml", svg("")],
        [
          "SVG with embedded bitmap",
          "image/svg+xml",
          svg(`<image href="${asDataUrl("image/png", HUGE_PNG)}"/>`),
        ],
        ["ICO invalid payload span", "image/x-icon", rawIco],
      ])("turns down %s without rasterizing", async (_label, mime, bytes) => {
        const { webContents, executeJavaScriptInIsolatedWorld } = makeGuest();

        expect(await grab(webContents, [asDataUrl(mime, bytes)])).toEqual(NOTHING);
        expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
      });

      it("turns down an oversized PNG fetched over the network", async () => {
        const { webContents, executeJavaScriptInIsolatedWorld } = makeGuest({
          fetch: async () => pngResponse(HUGE_PNG),
        });

        expect(await grab(webContents, [FAVICON_URL])).toEqual(NOTHING);
        expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
      });

      it("turns down a JPEG that carries several frame headers", async () => {
        const doubleFrame = Buffer.concat([jpegOf(4096, 4096), jpegOf(1, 1).subarray(2)]);
        const { webContents, executeJavaScriptInIsolatedWorld } = makeGuest();

        expect(await grab(webContents, [asDataUrl("image/jpeg", doubleFrame)])).toEqual(NOTHING);
        expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
      });

      it("turns down EXIF whose distinct SubIFDs use up the linear work budget", async () => {
        const source = withApp1(64, 32, [exifWithStaggeredSubIfds(32, 32)]);
        const { webContents, executeJavaScriptInIsolatedWorld } = makeGuest();

        expect(await grab(webContents, [asDataUrl("image/jpeg", source)])).toEqual(NOTHING);
        expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
      });
    });
  });

  describe("JPEG orientation", () => {
    const lookalikeApp1 = (text: string) => app1Of(Buffer.from(text, "binary"));

    it.each([
      ...[1, 2, 3, 4].map((orientation) => ({
        label: `keeps stored dimensions for orientation ${orientation}`,
        layout: LANDSCAPE_JPEG,
        source: jpegOf(64, 32, orientation),
      })),
      ...[5, 6, 7, 8].map((orientation) => ({
        label: `uses display dimensions for orientation ${orientation}`,
        layout: PORTRAIT_JPEG,
        source: jpegOf(64, 32, orientation),
      })),
      {
        label: "uses the first separate EXIF segment when it is transposed",
        layout: PORTRAIT_JPEG,
        source: jpegOf(64, 32, [6, 1]),
      },
      {
        label: "uses the first separate EXIF segment when it is untransposed",
        layout: LANDSCAPE_JPEG,
        source: jpegOf(64, 32, [1, 6]),
      },
      {
        label: "does not consult a later EXIF segment after an invalid orientation",
        layout: LANDSCAPE_JPEG,
        source: jpegOf(64, 32, [9, 6]),
      },
      {
        label: "uses a later valid orientation in the same IFD",
        layout: PORTRAIT_JPEG,
        source: jpegWithOrientationList([9, 6]),
      },
      {
        label: "skips a non-EXIF APP1 segment",
        layout: PORTRAIT_JPEG,
        source: withApp1(64, 32, [lookalikeApp1("not-exif"), exifOrientations([6])]),
      },
      {
        label: "skips an empty EXIF APP1 segment",
        layout: PORTRAIT_JPEG,
        source: withApp1(64, 32, [lookalikeApp1("Exif\0\0"), exifOrientations([6])]),
      },
      {
        label: "stops after a malformed qualifying EXIF APP1 segment",
        layout: LANDSCAPE_JPEG,
        source: withApp1(64, 32, [lookalikeApp1("Exif\0\0broken"), exifOrientations([6])]),
      },
      {
        label: "ignores the EXIF padding byte",
        layout: PORTRAIT_JPEG,
        source: withApp1(64, 32, [exifOrientations([6], { padding: 0xff })]),
      },
      {
        label: "reads big-endian EXIF",
        layout: PORTRAIT_JPEG,
        source: withApp1(64, 32, [exifOrientations([6], { byteOrder: "MM" })]),
      },
      {
        label: "matches Chromium for a nonstandard TIFF magic field",
        layout: PORTRAIT_JPEG,
        source: withApp1(64, 32, [exifOrientations([6], { magic: 0 })]),
      },
      {
        label: "rejects a high-bit little-endian alias",
        layout: LANDSCAPE_JPEG,
        source: jpegWithAliasedByteOrder(0xc9, "II"),
      },
      {
        label: "rejects a high-bit big-endian alias",
        layout: LANDSCAPE_JPEG,
        source: jpegWithAliasedByteOrder(0xcd, "MM"),
      },
      {
        label: "reads an orientation from a SubIFD",
        layout: PORTRAIT_JPEG,
        source: withApp1(64, 32, [exifWithSubIfd({ subIfdOrientation: 6 })]),
      },
      {
        label: "uses a SubIFD orientation before a later root orientation",
        layout: PORTRAIT_JPEG,
        source: withApp1(64, 32, [
          exifWithSubIfd({ rootOrientation: 1, subIfdFirst: true, subIfdOrientation: 6 }),
        ]),
      },
      {
        label: "uses a root orientation before a later SubIFD orientation",
        layout: LANDSCAPE_JPEG,
        source: withApp1(64, 32, [exifWithSubIfd({ rootOrientation: 1, subIfdOrientation: 6 })]),
      },
      {
        label: "memoizes repeated aliases to the same SubIFD",
        layout: PORTRAIT_JPEG,
        source: withApp1(64, 32, [exifWithRepeatedSubIfdPointers(32, 32)]),
      },
    ])("lays out like Chromium: $label", async ({ source, layout }) => {
      await expectJpegLayout(source, layout);
    });
  });
});

describe("private-network icons (2026-10-15 audit desktop #9)", () => {
  it("knows loopback, private ranges, link-local and .local hosts", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.1",
      "192.168.1.1",
      "169.254.1.1",
      "[::1]",
      "fd00::1",
      "fe80::1",
      "printer.local",
      "0.0.0.0",
    ]) {
      expect(isPrivateNetworkHost(h), h).toBe(true);
    }
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "2606:4700::1"])
      expect(isPrivateNetworkHost(h), h).toBe(false);
  });
  it("skips a private icon for a public page, keeps it for a page on a private host", () => {
    expect(privateIconTarget("http://192.168.1.1/admin/reboot", "https://evil.example")).toBe(true);
    expect(privateIconTarget("http://127.0.0.1:3000/favicon.ico", "http://127.0.0.1:3000")).toBe(
      false,
    );
    expect(privateIconTarget("https://cdn.example/favicon.ico", "https://example.com")).toBe(false);
  });
});
