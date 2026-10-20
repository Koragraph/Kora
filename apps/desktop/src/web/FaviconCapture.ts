// @effect-diagnostics globalTimers:off -- the rasterization deadline guards a plain Promise, outside any Effect runtime.
// Turns a page's declared favicon candidates into one 32x32 PNG data URL for the preview browser's tab strip.
// Every byte is treated as hostile: sizes are bounded, image headers are read without decoding, redirects are
// refused, and the actual decoding happens inside an isolated world of the page's own renderer, never here.
import { SITE_ICON_DATA_URL_MAX } from "@kora/contracts";
import type * as Electron from "electron";

export const MAX_FAVICON_RESPONSE_BYTES = 100_000;
export const MAX_FAVICON_CANDIDATES = 8;

const MAX_URL_LENGTH = 2_048;
const MAX_INPUT_BUDGET = 262_144;
const MIN_CANDIDATE_CHARGE = 256;
const MAX_SOURCE_PIXELS = 1_048_576;
const INLINE_URL_MAX = Math.ceil((MAX_FAVICON_RESPONSE_BYTES * 4) / 3) + 128;
const CAPTURE_TIMEOUT_MS = 5_000;
const RASTER_TIMEOUT_MS = 1_000;
const ISOLATED_WORLD_ID = 1_001;
const OUTPUT_SIZE = 32;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

export type FaviconCaptureResult =
  | { readonly kind: "timed-out" }
  | { readonly kind: "none" }
  | { readonly kind: "captured"; readonly dataUrl: string };

// ---------------------------------------------------------------------------------------------------------------
// Candidate selection

export function safeHttpOrigin(address: string): string | null {
  try {
    const decoded = new URL(address);
    return decoded.protocol === "http:" || decoded.protocol === "https:" ? decoded.origin : null;
  } catch {
    return null;
  }
}

const INLINE_IMAGE_PATTERN = /^data:image\/([a-z0-9.+-]+)((?:;[^,]*)*),(.*)$/is;

function isSupportedCandidate(cand: string): boolean {
  if (cand.length > INLINE_URL_MAX) return false;
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(cand)) return true;
  return cand.length <= MAX_URL_LENGTH && safeHttpOrigin(cand) !== null;
}

export function selectFaviconCandidates(candidates: ReadonlyArray<string>): ReadonlyArray<string> {
  const chosen: string[] = [];
  let spent = 0;
  for (const cand of candidates) {
    // Junk is charged too, so a long list of tiny or useless entries cannot keep this loop busy.
    spent += Math.max(MIN_CANDIDATE_CHARGE, cand.length);
    if (spent > MAX_INPUT_BUDGET) break;
    if (chosen.includes(cand) || !isSupportedCandidate(cand)) continue;
    chosen.push(cand);
    if (chosen.length >= MAX_FAVICON_CANDIDATES) break;
  }
  return chosen;
}

// ---------------------------------------------------------------------------------------------------------------
// Image headers (no decoding)

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

const isSafeSize = (wd: number, ht: number) =>
  Number.isSafeInteger(wd) &&
  Number.isSafeInteger(ht) &&
  wd > 0 &&
  ht > 0 &&
  wd * ht <= MAX_SOURCE_PIXELS;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (buf: Uint8Array, signature: ReadonlyArray<number>, when = 0) =>
  buf.length >= when + signature.length && signature.every((val, pos) => buf[when + pos] === val);
const asciiAt = (buf: Uint8Array, when: number, str: string) =>
  buf.length >= when + str.length &&
  [...str].every((ch, pos) => buf[when + pos] === ch.charCodeAt(0));

function readPng(buf: Uint8Array): Dimensions | null {
  if (!startsWith(buf, PNG_SIGNATURE) || buf.length < 24) return null;
  const surfaceView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: surfaceView.getUint32(16), height: surfaceView.getUint32(20) };
}

function readGif(buf: Uint8Array): Dimensions | null {
  if (!asciiAt(buf, 0, "GIF87a") && !asciiAt(buf, 0, "GIF89a")) return null;
  if (buf.length < 13) return null;
  const surfaceView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let wd = surfaceView.getUint16(6, true);
  let ht = surfaceView.getUint16(8, true);
  if (!isSafeSize(wd, ht)) return null;

  let when = 13;
  const flags = buf[10]!;
  if (flags & 0x80) when += 3 * 2 ** ((flags & 0x07) + 1);

  // Walks sub-blocks (length-prefixed) up to and including the zero-length terminator.
  const skipSubBlocks = (offset: number): number => {
    let caret = offset;
    for (;;) {
      if (caret >= buf.length) return -1;
      const extent = buf[caret]!;
      caret += 1;
      if (extent === 0) return caret;
      caret += extent;
    }
  };

  let frames = 0;
  let framePixels = 0;
  while (when < buf.length) {
    const introducer = buf[when]!;
    if (introducer === 0x3b) return frames > 0 ? { width: wd, height: ht } : null;
    if (introducer === 0x21) {
      if (when + 2 > buf.length) return null;
      when = skipSubBlocks(when + 2);
      if (when < 0) return null;
      continue;
    }
    if (introducer !== 0x2c || when + 10 > buf.length) return null;
    const leftSide = surfaceView.getUint16(when + 1, true);
    const upper = surfaceView.getUint16(when + 3, true);
    const frameWidth = surfaceView.getUint16(when + 5, true);
    const frameHeight = surfaceView.getUint16(when + 7, true);
    const frameFlags = buf[when + 9]!;
    if (frameWidth === 0 || frameHeight === 0) return null;
    framePixels += frameWidth * frameHeight;
    if (framePixels > MAX_SOURCE_PIXELS) return null;
    wd = Math.max(wd, leftSide + frameWidth);
    ht = Math.max(ht, upper + frameHeight);
    if (!isSafeSize(wd, ht)) return null;
    when += 10;
    if (frameFlags & 0x80) when += 3 * 2 ** ((frameFlags & 0x07) + 1);
    if (when >= buf.length) return null;
    const minimumCodeSize = buf[when]!;
    if (minimumCodeSize < 2 || minimumCodeSize > 8) return null;
    when = skipSubBlocks(when + 1);
    if (when < 0) return null;
    frames += 1;
  }
  return null;
}

// --- JPEG, including the EXIF orientation that Chromium applies when it lays the image out ----------------------

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

interface ExifOutcome {
  /** 1-8 when a valid orientation was found. */
  readonly orientation: number | null;
  /** The entry-visit budget ran out: the image is refused. */
  readonly exhausted: boolean;
}

/**
 * Looks for the Orientation tag in an EXIF block (`exif` starts at "Exif\0"). Entries are visited in order, the
 * first valid orientation wins, and the Exif sub-IFD is entered where its pointer sits. The number of entries
 * visited overall is capped in proportion to the segment size, and each sub-IFD is only walked once, so crafted
 * overlapping pointers cannot make this quadratic.
 */
function readExifOrientation(exif: Uint8Array, segmentLength: number): ExifOutcome {
  const none: ExifOutcome = { orientation: null, exhausted: false };
  // Layout: "Exif\0", one padding byte, then a TIFF header ("II"/"MM", magic, offset of the first IFD).
  const tiff = 6;
  if (exif.length < tiff + 8) return none;
  const head = exif[tiff]!;
  if (head !== exif[tiff + 1] || (head !== 0x49 && head !== 0x4d)) return none;
  const little = head === 0x49;
  const surfaceView = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
  const u16 = (when: number) => surfaceView.getUint16(when, little);
  const u32 = (when: number) => surfaceView.getUint32(when, little);

  let budget = Math.ceil(segmentLength / 12);
  const visited = new Map<number, number | null>();
  let exhausted = false;

  const walk = (ifdOffset: number): number | null => {
    if (visited.has(ifdOffset)) return visited.get(ifdOffset)!;
    visited.set(ifdOffset, null);
    const table = tiff + ifdOffset;
    if (table + 2 > exif.length) return null;
    const tally = u16(table);
    if (table + 2 + tally * 12 > exif.length) return null;
    let located: number | null = null;
    for (let pos = 0; pos < tally && located === null; pos += 1) {
      budget -= 1;
      if (budget < 0) {
        exhausted = true;
        return null;
      }
      const rec = table + 2 + pos * 12;
      const tag = u16(rec);
      const typ = u16(rec + 2);
      if (tag === 0x0112 && typ === 3 && u32(rec + 4) === 1) {
        const val = u16(rec + 8);
        if (val >= 1 && val <= 8) located = val;
      } else if (tag === 0x8769 && typ === 4) {
        located = walk(u32(rec + 8));
        if (exhausted) return null;
      }
    }
    visited.set(ifdOffset, located);
    return located;
  };

  const orientation = walk(u32(tiff + 4));
  return exhausted ? { orientation: null, exhausted: true } : { orientation, exhausted: false };
}

function readJpeg(buf: Uint8Array): Dimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let when = 2;
  let fr: Dimensions | null = null;
  let orientation: number | null = null;
  let exifSettled = false;

  while (when < buf.length) {
    if (buf[when] !== 0xff) return null;
    while (when < buf.length && buf[when] === 0xff) when += 1; // fill bytes
    if (when >= buf.length) return null;
    const marker = buf[when]!;
    when += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // no length field
    if (marker === 0xd9 || marker === 0xda) break;
    if (when + 2 > buf.length) return null;
    const len = (buf[when]! << 8) | buf[when + 1]!;
    if (len < 2 || when + len > buf.length) return null;
    const markup = buf.subarray(when + 2, when + len);

    if (SOF_MARKERS.has(marker)) {
      if (fr !== null || len < 7) return null;
      fr = { height: (markup[1]! << 8) | markup[2]!, width: (markup[3]! << 8) | markup[4]! };
    } else if (
      marker === 0xe1 &&
      !exifSettled &&
      markup.length > 6 &&
      asciiAt(markup, 0, "Exif\0")
    ) {
      // Only the first real EXIF block counts, even if it carries no usable orientation.
      exifSettled = true;
      const verdict = readExifOrientation(markup, len);
      if (verdict.exhausted) return null;
      orientation = verdict.orientation;
    }
    when += len;
  }
  if (fr === null) return null;
  // Orientations 5-8 are rotated a quarter turn, which swaps the displayed width and height.
  return orientation !== null && orientation >= 5 ? { width: fr.height, height: fr.width } : fr;
}

function readWebp(buf: Uint8Array): Dimensions | null {
  if (buf.length < 30 || !asciiAt(buf, 0, "RIFF") || !asciiAt(buf, 8, "WEBP")) return null;
  const surfaceView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (asciiAt(buf, 12, "VP8X")) {
    const le24 = (when: number) => buf[when]! | (buf[when + 1]! << 8) | (buf[when + 2]! << 16);
    return { width: le24(24) + 1, height: le24(27) + 1 };
  }
  if (asciiAt(buf, 12, "VP8 ")) {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return {
      width: surfaceView.getUint16(26, true) & 0x3fff,
      height: surfaceView.getUint16(28, true) & 0x3fff,
    };
  }
  if (asciiAt(buf, 12, "VP8L")) {
    if (buf[20] !== 0x2f) return null;
    const bits = surfaceView.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function readDibSize(buf: Uint8Array): Dimensions | null {
  if (buf.length < 12) return null;
  const surfaceView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerSize = surfaceView.getUint32(0, true);
  if (headerSize === 12)
    return { width: surfaceView.getUint16(4, true), height: surfaceView.getUint16(6, true) };
  if (headerSize >= 40 && buf.length >= 12) {
    return {
      width: Math.abs(surfaceView.getInt32(4, true)),
      height: Math.abs(surfaceView.getInt32(8, true)),
    };
  }
  return null;
}

function readIco(buf: Uint8Array): Dimensions | null {
  if (buf.length < 22) return null;
  const surfaceView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const typ = surfaceView.getUint16(2, true);
  const tally = surfaceView.getUint16(4, true);
  if (surfaceView.getUint16(0, true) !== 0 || (typ !== 1 && typ !== 2) || tally < 1 || tally > 256)
    return null;
  if (buf.length < 6 + tally * 16) return null;
  let wd = 0;
  let ht = 0;
  for (let pos = 0; pos < tally; pos += 1) {
    const rec = 6 + pos * 16;
    const extent = surfaceView.getUint32(rec + 8, true);
    const shift = surfaceView.getUint32(rec + 12, true);
    if (extent === 0 || shift === 0 || shift + extent > buf.length) return null;
    const image = buf.subarray(shift, shift + extent);
    const embedded = startsWith(image, PNG_SIGNATURE) ? readPng(image) : readDibSize(image);
    if (embedded === null || !isSafeSize(embedded.width, embedded.height)) return null;
    wd = Math.max(wd, buf[rec]! || 256);
    ht = Math.max(ht, buf[rec + 1]! || 256);
  }
  return { width: wd, height: ht };
}

/** Header-level dimensions of any supported format, chosen by magic bytes rather than the declared type. */
function sniffDimensions(buf: Uint8Array): Dimensions | null {
  for (const read of [readPng, readGif, readJpeg, readWebp, readIco]) {
    const located = read(buf);
    if (located !== null) return located;
  }
  return null;
}

function normalizeFaviconBuffer(
  buf: Uint8Array,
  declaredMime: string | null,
): { readonly mime: string | null; readonly dimensions: Dimensions } | null {
  let mime = declaredMime === null ? null : declaredMime.trim().toLowerCase();
  if (mime === "application/x-icon") mime = "image/x-icon";
  if (mime === "application/octet-stream" || mime === "binary/octet-stream" || mime === "")
    mime = null;
  if (mime !== null && !/^image\/[a-z0-9.+-]+$/.test(mime)) return null;
  if (mime === "image/svg+xml") return null;
  if (buf.byteLength === 0 || buf.byteLength > MAX_FAVICON_RESPONSE_BYTES) return null;
  const dimensions = sniffDimensions(buf);
  if (dimensions === null || !isSafeSize(dimensions.width, dimensions.height)) return null;
  return { mime, dimensions };
}

// ---------------------------------------------------------------------------------------------------------------
// Fetching / decoding candidates

const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeInlineImage(cand: string): { bytes: Uint8Array; mime: string } | null {
  const matched = INLINE_IMAGE_PATTERN.exec(cand);
  if (!matched) return null;
  const mime = `image/${matched[1]!.toLowerCase()}`;
  const parameters = matched[2]!.split(";").filter((fragment) => fragment.length > 0);
  const payload = matched[3]!;
  const base64At = parameters.findIndex((fragment) => fragment.toLowerCase() === "base64");
  let buf: Uint8Array;

  if (base64At !== -1) {
    if (base64At !== parameters.length - 1) return null;
    const bare = payload.replace(/=+$/, "");
    if (!BASE64_ALPHABET.test(payload) || bare.length % 4 === 1) return null;
    buf = Buffer.from(payload, "base64");
    if (Buffer.from(buf).toString("base64").replace(/=+$/, "") !== bare) return null;
  } else {
    const parts: Buffer[] = [];
    let literal = "";
    for (let pos = 0; pos < payload.length; pos += 1) {
      const ch = payload[pos]!;
      if (ch !== "%") {
        literal += ch;
        continue;
      }
      const hex = payload.slice(pos + 1, pos + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      if (literal) parts.push(Buffer.from(literal, "utf8"));
      literal = "";
      parts.push(Buffer.of(Number.parseInt(hex, 16)));
      pos += 2;
    }
    if (literal) parts.push(Buffer.from(literal, "utf8"));
    buf = Buffer.concat(parts);
  }
  return buf.byteLength >= 1 && buf.byteLength <= MAX_FAVICON_RESPONSE_BYTES
    ? { bytes: buf, mime }
    : null;
}

/** Loopback, link-local, private-range and `.local` / `.localhost` hosts. Exported for tests. */
export function isPrivateNetworkHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h === "0.0.0.0" ||
    h === ""
  )
    return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h.replace(/^::ffff:/, ""));
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(":"))
    return (
      h === "::1" ||
      h === "::" ||
      /^f[cd]/.test(h) ||
      /^fe[89ab]/.test(h) ||
      h.startsWith("::ffff:")
    );
  return false;
}

/** An icon on a private-network host for a page that is not on one. */
export function privateIconTarget(address: string, pageOrigin: string): boolean {
  try {
    if (!isPrivateNetworkHost(new URL(address).hostname)) return false;
    try {
      return !isPrivateNetworkHost(new URL(pageOrigin).hostname);
    } catch {
      return true;
    }
  } catch {
    return true;
  }
}

async function fetchRemoteImage(
  webContents: Electron.WebContents,
  pageOrigin: string,
  address: string,
  abortSig: AbortSignal,
): Promise<{ bytes: Uint8Array; mime: string | null } | null> {
  // The main process's fetch skips Chromium's Private Network Access rules: a public page could point its icon at a
  // loopback / LAN service and make Kora send it a blind GET (2026-10-15 audit desktop #9). Only a page that is itself
  // on such a host gets icons from one.
  if (privateIconTarget(address, pageOrigin)) return null;
  const resp = await webContents.session.fetch(address, {
    redirect: "error",
    // Cookies only go back to the page's own origin.
    credentials: safeHttpOrigin(address) === pageOrigin ? "include" : "omit",
    signal: abortSig,
  });
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => undefined);
    return null;
  }
  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FAVICON_RESPONSE_BYTES) {
    await resp.body?.cancel().catch(() => undefined);
    return null;
  }
  const mime = resp.headers.get("content-type")?.split(";")[0]?.trim() ?? null;
  const reader = resp.body?.getReader();
  if (!reader) return null;

  let readerClosed = false;
  const stop = () => {
    if (!readerClosed) {
      readerClosed = true;
      reader.cancel().catch(() => undefined);
    }
  };
  if (abortSig.aborted) {
    stop();
    return null;
  }
  abortSig.addEventListener("abort", stop, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      received += next.value.byteLength;
      if (received > MAX_FAVICON_RESPONSE_BYTES) {
        stop();
        return null;
      }
      chunks.push(next.value);
    }
    return abortSig.aborted ? null : { bytes: Buffer.concat(chunks), mime };
  } finally {
    abortSig.removeEventListener("abort", stop);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Rasterization (inside the page's renderer, in an isolated world)

type RasterOutcome =
  | { readonly kind: "done"; readonly value: string | null }
  | { readonly kind: "timed-out" };

interface Gate {
  /** Bumped by every attempt; an attempt that finds a newer number has been superseded. */
  generation: number;
  /** The most recent execution, until it has physically finished. */
  running: Promise<void> | null;
}
const gates = new WeakMap<object, Gate>();

function rasterScript(base64: string, mime: string | null, dimensions: Dimensions): string {
  const scale = Math.min(OUTPUT_SIZE / dimensions.width, OUTPUT_SIZE / dimensions.height);
  const wd = Math.max(1, Math.round(dimensions.width * scale));
  const ht = Math.max(1, Math.round(dimensions.height * scale));
  const leftSide = (OUTPUT_SIZE - wd) / 2;
  const upper = (OUTPUT_SIZE - ht) / 2;
  return `(async () => {
  let bitmap = null;
  try {
    const raw = atob(${JSON.stringify(base64)});
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const blob = new Blob([bytes], { type: ${JSON.stringify(mime ?? "")} });
    bitmap = await createImageBitmap(blob, { resizeWidth: ${wd}, resizeHeight: ${ht}, resizeQuality: "high" });
    if (!(bitmap.width > 0 && bitmap.height > 0 && bitmap.width * bitmap.height <= ${MAX_SOURCE_PIXELS})) return null;
    const canvas = new OffscreenCanvas(${OUTPUT_SIZE}, ${OUTPUT_SIZE});
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, ${leftSide}, ${upper}, ${wd}, ${ht});
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    let binary = "";
    for (let i = 0; i < png.length; i += 1) binary += String.fromCharCode(png[i]);
    return "${PNG_DATA_URL_PREFIX}" + btoa(binary);
  } catch {
    return null;
  } finally {
    if (bitmap) bitmap.close();
  }
})()`;
}

async function rasterizeFavicon(
  webContents: Electron.WebContents,
  buf: Uint8Array,
  mime: string | null,
  dimensions: Dimensions,
  abortSig: AbortSignal,
): Promise<RasterOutcome> {
  let gate = gates.get(webContents);
  if (!gate) {
    gate = { generation: 0, running: null };
    gates.set(webContents, gate);
  }
  gate.generation += 1;
  const mine = gate.generation;

  // Electron cannot cancel script running in an isolated world, so a new attempt waits for the old one to really
  // finish (or for its own abort) before it starts.
  while (gate.running !== null) {
    const prior = gate.running;
    await new Promise<void>((resolve) => {
      const wake = () => resolve();
      abortSig.addEventListener("abort", wake, { once: true });
      prior.then(wake, wake);
    });
    if (abortSig.aborted) return { kind: "done", value: null };
  }
  if (abortSig.aborted || gate.generation !== mine) return { kind: "done", value: null };

  const script = rasterScript(Buffer.from(buf).toString("base64"), mime, dimensions);
  const execution = Promise.resolve(
    webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: script }]),
  );
  const thisGate = gate;
  const settled = execution.then(
    () => undefined,
    () => undefined,
  );
  thisGate.running = settled;
  void settled.then(() => {
    if (thisGate.running === settled) thisGate.running = null;
  });

  return new Promise<RasterOutcome>((resolve) => {
    const tmr = setTimeout(() => finish({ kind: "timed-out" }), RASTER_TIMEOUT_MS);
    const onAbort = () => finish({ kind: "done", value: null });
    const finish = (verdict: RasterOutcome) => {
      clearTimeout(tmr);
      abortSig.removeEventListener("abort", onAbort);
      resolve(verdict);
    };
    abortSig.addEventListener("abort", onAbort, { once: true });
    execution.then(
      (val) => finish({ kind: "done", value: typeof val === "string" ? val : null }),
      () => finish({ kind: "done", value: null }),
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------

async function captureCandidate(
  webContents: Electron.WebContents,
  pageOrigin: string,
  cand: string,
  abortSig: AbortSignal,
): Promise<FaviconCaptureResult> {
  try {
    let img: { bytes: Uint8Array; mime: string | null } | null;
    if (/^data:/i.test(cand)) {
      img = decodeInlineImage(cand);
    } else {
      img = await fetchRemoteImage(webContents, pageOrigin, cand, abortSig);
    }
    if (img === null) return { kind: "none" };
    const normalized = normalizeFaviconBuffer(img.bytes, img.mime);
    if (normalized === null) return { kind: "none" };

    const verdict = await rasterizeFavicon(
      webContents,
      img.bytes,
      normalized.mime,
      normalized.dimensions,
      abortSig,
    );
    if (verdict.kind === "timed-out") return { kind: "timed-out" };
    const val = verdict.value;
    return typeof val === "string" &&
      val.startsWith(PNG_DATA_URL_PREFIX) &&
      val.length <= SITE_ICON_DATA_URL_MAX
      ? { kind: "captured", dataUrl: val }
      : { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}

export async function captureFavicon(request: {
  readonly signal: AbortSignal;
  readonly candidates: ReadonlyArray<string>;
  readonly pageUrl: string;
  readonly webContents: Electron.WebContents;
}): Promise<FaviconCaptureResult> {
  const pageOrigin = safeHttpOrigin(request.pageUrl);
  if (pageOrigin === null) return { kind: "none" };

  const abortSig = AbortSignal.any([request.signal, AbortSignal.timeout(CAPTURE_TIMEOUT_MS)]);
  // A caller abort and the deadline look alike to the code below; tell them apart by who aborted first.
  const interrupted = (): FaviconCaptureResult =>
    request.signal.aborted ? { kind: "none" } : { kind: "timed-out" };

  for (const cand of selectFaviconCandidates(request.candidates)) {
    if (abortSig.aborted) return interrupted();
    const outcome = await captureCandidate(request.webContents, pageOrigin, cand, abortSig);
    if (abortSig.aborted && outcome.kind !== "captured") return interrupted();
    if (outcome.kind === "captured" || outcome.kind === "timed-out") return outcome;
  }
  return { kind: "none" };
}
