// A bounded in-memory scrollback for terminal output, plus a cursor-based reader so a renderer
// fetches only what it has not seen ("append") or is told to redraw ("reset"). The budget is in
// UTF-8 bytes; positions are UTF-16 offsets into the output. State is immutable.

export interface TerminalOutputChunk {
  /** UTF-8 length of `data`. */
  readonly byteLength: number;
  readonly data: string;
  /** UTF-16 offset of this chunk within its generation and reset. */
  readonly startOffset: number;
}

export interface TerminalOutputState {
  readonly nextOffset: number;
  readonly resetVersion: number;
  readonly retainedBytes: number;
  readonly chunks: ReadonlyArray<TerminalOutputChunk>;
  readonly generation: number;
}

export interface TerminalOutputCursor {
  readonly offset: number;
  readonly resetVersion: number;
  readonly generation: number;
}

/** Matches nothing real, so the first read always resynchronises from a reset. */
export const INITIAL_TERMINAL_OUTPUT_CURSOR: Readonly<TerminalOutputCursor> = Object.freeze({
  resetVersion: -1,
  generation: -1,
  offset: 0,
});

export type TerminalOutputUpdate =
  | { readonly type: "none"; readonly cursor: TerminalOutputCursor }
  | { readonly type: "reset"; readonly data: string; readonly cursor: TerminalOutputCursor }
  | { readonly type: "append"; readonly data: string; readonly cursor: TerminalOutputCursor };

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024;
const MAX_CHUNKS = 1024;

export const EMPTY_TERMINAL_OUTPUT_STATE: Readonly<TerminalOutputState> = Object.freeze({
  generation: 0,
  chunks: Object.freeze([]) as ReadonlyArray<TerminalOutputChunk>,
  nextOffset: 0,
  resetVersion: 0,
  retainedBytes: 0,
});

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** UTF-8 continuation bytes are 10xxxxxx. */
const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

const codePointBytes = (codePoint: number): number =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

export function terminalOutputText(output: TerminalOutputState): string {
  return output.chunks.map((chunk) => chunk.data).join("");
}

/** Split `data` into chunks of at most `limit` bytes without cutting a code point. */
function chunkText(data: string, limit: number, startOffset: number): TerminalOutputChunk[] {
  const bytes = encoder.encode(data);
  if (bytes.length <= limit) return [{ startOffset, data, byteLength: bytes.length }];

  const chunks: TerminalOutputChunk[] = [];
  let position = 0;
  let offset = startOffset;
  while (position < bytes.length) {
    let end = Math.min(position + limit, bytes.length);
    // Back up to a code-point boundary...
    while (end < bytes.length && end > position && isContinuation(bytes[end]!)) end -= 1;
    // ...unless the limit is smaller than one code point, which then goes in whole.
    if (end === position) {
      end = position + 1;
      while (end < bytes.length && isContinuation(bytes[end]!)) end += 1;
    }
    const text = decoder.decode(bytes.subarray(position, end));
    chunks.push({ startOffset: offset, data: text, byteLength: end - position });
    offset += text.length;
    position = end;
  }
  return chunks;
}

const chunkLimit = (budget: number): number => Math.min(MAX_CHUNK_BYTES, Math.max(1, budget));

/** Drop bytes from the front until the retained total fits the budget. */
function trimToBudget(
  chunks: TerminalOutputChunk[],
  retainedBytes: number,
  budget: number,
): { chunks: TerminalOutputChunk[]; retainedBytes: number } {
  let retained = retainedBytes;
  let first = 0;
  while (retained > budget && first < chunks.length) {
    const excess = retained - budget;
    const head = chunks[first]!;
    if (head.byteLength <= excess) {
      retained -= head.byteLength;
      first += 1;
      continue;
    }
    // Trim inside the chunk, counting only the bytes of the removed prefix.
    let droppedBytes = 0;
    let droppedUnits = 0;
    for (const char of head.data) {
      if (droppedBytes >= excess) break;
      droppedBytes += codePointBytes(char.codePointAt(0)!);
      droppedUnits += char.length;
    }
    chunks[first] = {
      startOffset: head.startOffset + droppedUnits,
      data: head.data.slice(droppedUnits),
      byteLength: head.byteLength - droppedBytes,
    };
    retained -= droppedBytes;
    break;
  }
  return { chunks: first === 0 ? chunks : chunks.slice(first), retainedBytes: retained };
}

/** Merge neighbours that are contiguous and still fit one chunk; positions do not change. */
function mergeChunks(chunks: TerminalOutputChunk[]): TerminalOutputChunk[] {
  const merged: TerminalOutputChunk[] = [];
  for (const chunk of chunks) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      last.byteLength + chunk.byteLength <= MAX_CHUNK_BYTES &&
      last.startOffset + last.data.length === chunk.startOffset
    ) {
      merged[merged.length - 1] = {
        startOffset: last.startOffset,
        data: last.data + chunk.data,
        byteLength: last.byteLength + chunk.byteLength,
      };
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

export function appendOutput(
  state: TerminalOutputState,
  data: string,
  byteBudget: number,
): TerminalOutputState {
  if (data.length === 0) return state;
  const nextOffset = state.nextOffset + data.length;
  if (byteBudget <= 0) {
    // Nothing is kept, but offsets keep advancing so readers notice the gap.
    return {
      ...state,
      chunks: [],
      retainedBytes: 0,
      resetVersion: state.resetVersion + 1,
      nextOffset,
    };
  }

  const added = chunkText(data, chunkLimit(byteBudget), state.nextOffset);
  let chunks = [...state.chunks, ...added];
  let retained = state.retainedBytes + added.reduce((sum, chunk) => sum + chunk.byteLength, 0);

  ({ chunks, retainedBytes: retained } = trimToBudget(chunks, retained, byteBudget));

  if (chunks.length > MAX_CHUNKS) {
    chunks = mergeChunks(chunks);
    if (chunks.length > MAX_CHUNKS) {
      const dropped = chunks.slice(0, chunks.length - MAX_CHUNKS);
      retained -= dropped.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      chunks = chunks.slice(chunks.length - MAX_CHUNKS);
    }
  }
  return { ...state, chunks, retainedBytes: retained, nextOffset };
}

export function resetOutput(
  state: TerminalOutputState,
  data: string,
  byteBudget: number,
): TerminalOutputState {
  let kept = "";
  let chunks: TerminalOutputChunk[] = [];
  let retainedBytes = 0;
  if (byteBudget > 0 && data.length > 0) {
    const bytes = encoder.encode(data);
    if (bytes.length <= byteBudget) {
      kept = data;
    } else {
      // Keep the tail, moving forward to a code-point boundary.
      let start = bytes.length - byteBudget;
      while (start < bytes.length && isContinuation(bytes[start]!)) start += 1;
      kept = decoder.decode(bytes.subarray(start));
    }
    chunks = chunkText(kept, chunkLimit(byteBudget), 0);
    retainedBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  }
  return {
    generation: state.generation,
    chunks,
    retainedBytes,
    resetVersion: state.resetVersion + 1,
    nextOffset: kept.length,
  };
}

export function readTerminalOutputUpdate(
  state: TerminalOutputState,
  since: TerminalOutputCursor,
): TerminalOutputUpdate {
  const output = state;
  const cursor = since;
  const next: TerminalOutputCursor = {
    offset: output.nextOffset,
    resetVersion: output.resetVersion,
    generation: output.generation,
  };
  const firstOffset = output.chunks[0]?.startOffset ?? output.nextOffset;
  if (
    cursor.generation !== output.generation ||
    cursor.resetVersion !== output.resetVersion ||
    cursor.offset < firstOffset
  ) {
    return { type: "reset", data: terminalOutputText(output), cursor: next };
  }

  let unread = "";
  for (const chunk of output.chunks) {
    if (chunk.startOffset + chunk.data.length <= cursor.offset) continue;
    unread += chunk.data.slice(Math.max(0, cursor.offset - chunk.startOffset));
  }
  return unread.length === 0
    ? { type: "none", cursor: next }
    : { type: "append", data: unread, cursor: next };
}
