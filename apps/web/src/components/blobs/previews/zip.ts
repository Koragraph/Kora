// A small, strict ZIP reader for Office files (xlsx / docx / pptx): central directory + stored / deflate entries.
// Inflate uses the platform's DecompressionStream (browser, worker, Node 24), so there is no dependency to bundle.
// Guards: no ZIP64, no encryption, a per-entry output cap enforced WHILE inflating (a lying header cannot bomb us).
import { PREVIEW_LIMITS, PreviewError } from "./limits";

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

export interface ZipArchive {
  readonly bytes: Uint8Array;
  readonly entries: ReadonlyMap<string, ZipEntry>;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export function openZip(bytes: Uint8Array): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 22)
    throw new PreviewError("corrupt", "This file is not a valid Office document.");
  let eocd = -1;
  const lowest = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let i = bytes.byteLength - 22; i >= lowest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new PreviewError("corrupt", "This file is not a valid Office document.");
  const total = view.getUint16(eocd + 10, true);
  const cenSize = view.getUint32(eocd + 12, true);
  const cenOffset = view.getUint32(eocd + 16, true);
  if (total === 0xffff || cenSize === 0xffffffff || cenOffset === 0xffffffff) {
    throw new PreviewError("unsupported", "ZIP64 files are not previewed. Open it in its app.");
  }
  if (cenOffset + cenSize > bytes.byteLength) {
    throw new PreviewError("corrupt", "This file is damaged (its directory is cut off).");
  }
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  let cursor = cenOffset;
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== CEN_SIG) {
      throw new PreviewError("corrupt", "This file is damaged (a directory entry is unreadable).");
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if ((flags & 1) !== 0) {
      throw new PreviewError("unsupported", "This file is password protected. Open it in its app.");
    }
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.set(name, { name, method, compressedSize, size, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return { bytes, entries };
}

function dataOf(archive: ZipArchive, entry: ZipEntry): Uint8Array {
  const view = new DataView(
    archive.bytes.buffer,
    archive.bytes.byteOffset,
    archive.bytes.byteLength,
  );
  const at = entry.localOffset;
  if (at + 30 > archive.bytes.byteLength || view.getUint32(at, true) !== LOC_SIG) {
    throw new PreviewError("corrupt", "This file is damaged (a part is missing).");
  }
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const end = start + entry.compressedSize;
  if (end > archive.bytes.byteLength) {
    throw new PreviewError("corrupt", "This file is damaged (a part is cut off).");
  }
  return archive.bytes.subarray(start, end);
}

export interface ReadEntryOptions {
  /** Hard cap on the inflated size; exceeding it throws `too_large`. */
  readonly maxBytes?: number;
  /** Stop inflating as soon as the text decoded so far satisfies this (reading only the top of a big sheet). */
  readonly until?: (textSoFar: string) => boolean;
}

/** The entry's text (UTF-8), inflated incrementally. Returns what was decoded when `until` stopped it. */
export async function readZipText(
  archive: ZipArchive,
  name: string,
  options: ReadEntryOptions = {},
): Promise<string | null> {
  const entry = archive.entries.get(name);
  if (!entry) return null;
  const maxBytes = options.maxBytes ?? PREVIEW_LIMITS.maxPartBytes;
  if (entry.size > maxBytes && options.until === undefined) {
    throw new PreviewError(
      "too_large",
      "A part of this file is too large to preview. Open it in its app.",
    );
  }
  const raw = dataOf(archive, entry);
  const decoder = new TextDecoder();
  if (entry.method === 0) {
    const slice = raw.byteLength > maxBytes && options.until ? raw.subarray(0, maxBytes) : raw;
    return decoder.decode(slice);
  }
  if (entry.method !== 8) {
    throw new PreviewError(
      "unsupported",
      "This file uses a compression method that is not previewed.",
    );
  }
  if (typeof DecompressionStream === "undefined") {
    throw new PreviewError("unsupported", "This environment cannot unpack Office files.");
  }
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        if (options.until) break;
        throw new PreviewError(
          "too_large",
          "A part of this file is too large to preview. Open it in its app.",
        );
      }
      text += decoder.decode(value, { stream: true });
      if (options.until?.(text)) break;
    }
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError("corrupt", "This file is damaged (a part would not unpack).");
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return text;
}
