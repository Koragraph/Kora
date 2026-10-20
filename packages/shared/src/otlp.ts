// @effect-diagnostics globalDate:off -- span attributes may carry Date values that are normalised to ISO strings.
import { OtlpSerialization } from "effect/unstable/observability";
import * as Tracer from "effect/Tracer";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Cause from "effect/Cause";

import { RollingLogSink } from "./rollingLog.ts";

// ---------------------------------------------------------------------------
// OTLP configuration
// ---------------------------------------------------------------------------

/** The two OTLP/HTTP encodings an exporter can speak. */
const OTLP_WIRE_FORMATS = ["http/json", "http/protobuf"] as const;

export type OtlpProtocol = typeof OtlpProtocol.Type;
export const OtlpProtocol = Schema.Literals(OTLP_WIRE_FORMATS);

export function otlpSerializationLayer(protocol: OtlpProtocol) {
  if (protocol === "http/protobuf") return OtlpSerialization.layerProtobuf;
  return OtlpSerialization.layerJson;
}

/**
 * `key=value,key2=value2` with percent-encoded values, the wire format of
 * `OTEL_EXPORTER_OTLP_HEADERS` (W3C Baggage style); the `KORA_OTLP_HEADERS` variable uses it too.
 */
function parseOtlpHeaderList(
  input: string,
): Effect.Effect<Record<string, string>, SchemaIssue.Issue> {
  const parsed: Record<string, string> = {};
  const entries = input.split(",").filter((entry) => entry.trim() !== "");
  for (const entry of entries) {
    // Split at the first "=" only: values may contain "=".
    const eq = entry.indexOf("=");
    const name = (eq < 0 ? entry : entry.slice(0, eq)).trim();
    if (eq < 0 || name === "") {
      return Effect.fail(
        new SchemaIssue.InvalidValue({
          message: `Expected key=value but received ${JSON.stringify(entry.trim())}.`,
        }),
      );
    }
    const raw = entry.slice(eq + 1).trim();
    try {
      parsed[name] = decodeURIComponent(raw);
    } catch {
      return Effect.fail(
        new SchemaIssue.InvalidValue({
          message: `Header ${JSON.stringify(name)} has a malformed percent-encoded value.`,
        }),
      );
    }
  }
  return Effect.succeed(parsed);
}

const formatOtlpHeaders = (headers: Readonly<Record<string, string>>): string =>
  Object.entries(headers)
    .map(([name, value]) => name + "=" + encodeURIComponent(value))
    .join(",");

const otlpHeaderTransformation = SchemaTransformation.transformOrFail({
  decode: parseOtlpHeaderList,
  encode: (headers: Readonly<Record<string, string>>) => Effect.succeed(formatOtlpHeaders(headers)),
});
const otlpHeaderRecord = Schema.Record(Schema.String, Schema.String);

export const OtlpHeadersFromString = Schema.String.pipe(
  Schema.decodeTo(otlpHeaderRecord, otlpHeaderTransformation),
);

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

type AttributeBag = Record<string, unknown>;

export type TraceAttributes = Readonly<AttributeBag>;

export interface TraceRecordEvent {
  readonly attributes: AttributeBag;
  readonly timeUnixNano: string;
  readonly name: string;
}

export interface TraceRecordLink {
  readonly attributes: AttributeBag;
  readonly spanId: string;
  readonly traceId: string;
}

interface TraceRecordCommon {
  readonly name: string;
  readonly kind: string;
  readonly durationMs: number;
  readonly endTimeUnixNano: string;
  readonly startTimeUnixNano: string;
  readonly sampled: boolean;
  readonly parentSpanId?: string;
  readonly spanId: string;
  readonly traceId: string;
  readonly attributes: AttributeBag;
  readonly events: ReadonlyArray<TraceRecordEvent>;
  readonly links: ReadonlyArray<TraceRecordLink>;
}

export interface EffectTraceRecord extends TraceRecordCommon {
  readonly type: "effect-span";
  readonly exit:
    | { readonly _tag: "Success" }
    | { readonly _tag: "Interrupted"; readonly cause: string }
    | { readonly _tag: "Failure"; readonly cause: string };
}

export interface OtlpTraceRecord extends TraceRecordCommon {
  readonly type: "otlp-span";
  readonly resourceAttributes: Record<string, unknown>;
  readonly scope: {
    readonly name?: string;
    readonly version?: string;
    readonly attributes: Record<string, unknown>;
  };
  readonly status?: { readonly code?: string; readonly message?: string };
}

export type TraceRecord = EffectTraceRecord | OtlpTraceRecord;

// ---------------------------------------------------------------------------
// Error tags
// ---------------------------------------------------------------------------

const STRUCTURAL_TAG = /^[A-Za-z][A-Za-z0-9._:/-]*$/;
const isStructuralTag = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length < 129 &&
  STRUCTURAL_TAG.test(value);

/** Only the tag of an error: its message could carry anything. */
export function errorTag(error: unknown): string {
  try {
    if (error !== null && typeof error === "object" && "_tag" in error) {
      const tag = error._tag;
      return isStructuralTag(tag) ? tag : "TaggedError";
    }
    if (error instanceof Error) return isStructuralTag(error.name) ? error.name : "Error";
    return typeof error;
  } catch {
    return "UnknownError";
  }
}

// ---------------------------------------------------------------------------
// Attribute normalisation
// ---------------------------------------------------------------------------

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** JSON-safe form of a value; a reference to one of its own ancestors becomes "[Circular]". */
const toJsonValue = (value: unknown, ancestors: Set<object>): unknown => {
  if (value === null || value === undefined) return null;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return value;
  if (kind === "bigint") return String(value);
  if (kind !== "object") return String(value);
  if (value instanceof Date) {
    const time = value.getTime();
    return time !== time ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
    };
  }
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value) || value instanceof Set) {
      return Array.from(value as Iterable<unknown>, (item) => toJsonValue(item, ancestors));
    }
    if (value instanceof Map) {
      return Object.fromEntries(
        Array.from(value, ([key, item]) => [String(key), toJsonValue(item, ancestors)]),
      );
    }
    if (!isPlainObject(value)) return String(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJsonValue(item, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
};

export function compactTraceAttributes(attributes: Record<string, unknown>): TraceAttributes {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) out[key] = toJsonValue(value, new Set());
  }
  return out;
}

const TRUNCATED_SUFFIX = "…[truncated]";
const QUERY_TEXT_KEY = "db.query.text";
const QUERY_TEXT_LIMIT = 200;
const STRING_LIMIT = 500;

/** Clamp long strings at any depth. Never mutates (live span attributes are shared); returns the input itself when nothing was clamped. */
const clamp = (value: unknown, limit: number): unknown => {
  if (typeof value === "string") {
    return value.length > limit ? value.slice(0, limit) + TRUNCATED_SUFFIX : value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const clamped = clamp(item, STRING_LIMIT);
      if (clamped !== item) changed = true;
      return clamped;
    });
    return changed ? next : value;
  }
  if (typeof value === "object" && value !== null && isPlainObject(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const clamped = clamp(item, STRING_LIMIT);
      if (clamped !== item) changed = true;
      next[key] = clamped;
    }
    return changed ? next : value;
  }
  return value;
};

export function truncateTraceAttributes(attributes: TraceAttributes): TraceAttributes {
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    // SQL text dominates file size, so it is clamped much harder.
    const clamped = clamp(value, key === QUERY_TEXT_KEY ? QUERY_TEXT_LIMIT : STRING_LIMIT);
    if (clamped !== value) changed = true;
    next[key] = clamped;
  }
  return changed ? next : attributes;
}

const prepareAttributes = (attributes: Record<string, unknown>): Record<string, unknown> =>
  truncateTraceAttributes(compactTraceAttributes(attributes)) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

export interface TraceSinkFlushStats {
  readonly durationMs: number;
  readonly count: number;
  readonly logicalWriteBytes: number;
}

export interface TraceSinkOptions {
  readonly onFlush?: (stats: TraceSinkFlushStats) => Effect.Effect<void>;
  readonly batchWindowMs: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly filePath: string;
}

export interface TraceSink {
  readonly filePath: string;
  push(record: TraceRecord): void;
  readonly flush: Effect.Effect<void>;
  close(): Effect.Effect<void>;
}

const FLUSH_THRESHOLD = 256;

export const makeSpanSink = Effect.fn("makeSpanSink")(function* (options: TraceSinkOptions) {
  const file = new RollingLogSink({
    throwOnError: true,
    maxFiles: options.maxFiles,
    maxBytes: options.maxBytes,
    filePath: options.filePath,
  });

  let buffer: string[] = [];
  let stats = { logicalWriteBytes: 0, count: 0, durationMs: 0 };

  /** Write the buffered lines; a failed write puts the rest back and stops until the next flush. */
  const writeBuffered = (): void => {
    if (buffer.length === 0) return;
    const lines = buffer;
    buffer = [];

    let index = 0;
    while (index < lines.length) {
      let chunk = "";
      let chunkBytes = 0;
      let count = 0;
      while (index + count < lines.length) {
        const bytes = Buffer.byteLength(lines[index + count]!);
        if (chunkBytes + bytes > options.maxBytes) break;
        chunk += lines[index + count];
        chunkBytes += bytes;
        count += 1;
      }
      if (count === 0) {
        index += 1; // a single line that can never fit is dropped
        continue;
      }
      const startedAt = performance.now();
      try {
        file.write(chunk);
      } catch {
        buffer = lines.slice(index).concat(buffer);
        return;
      }
      stats = {
        logicalWriteBytes: stats.logicalWriteBytes + chunkBytes,
        count: stats.count + count,
        durationMs: stats.durationMs + (performance.now() - startedAt),
      };
      index += count;
    }
  };

  const flush: Effect.Effect<void> = Effect.suspend(() => {
    writeBuffered();
    const reported = stats;
    stats = { logicalWriteBytes: 0, count: 0, durationMs: 0 };
    return reported.count > 0 && options.onFlush !== undefined
      ? options.onFlush(reported).pipe(Effect.ignore)
      : Effect.void;
    // Flushing must not trace itself.
  }).pipe(Effect.withTracerEnabled(false));

  yield* Effect.addFinalizer(() => flush.pipe(Effect.ignore));
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.sleep(Duration.millis(options.batchWindowMs)).pipe(Effect.andThen(flush)),
    ),
  );

  const sink: TraceSink = {
    filePath: options.filePath,
    push(record) {
      let line: string;
      try {
        line = `${JSON.stringify(record)}\n`;
      } catch {
        return; // a record that cannot be serialised is dropped on its own
      }
      buffer.push(line);
      if (buffer.length >= FLUSH_THRESHOLD) writeBuffered();
    },
    flush,
    close: () => flush,
  };
  return sink;
});

// ---------------------------------------------------------------------------
// The tracer
// ---------------------------------------------------------------------------

export interface LocalFileTracerOptions extends TraceSinkOptions {
  readonly sink?: TraceSink;
  readonly delegate?: Tracer.Tracer;
}

const nativeTracer = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) });

const exitOf = (exit: Exit.Exit<unknown, unknown>): EffectTraceRecord["exit"] => {
  if (Exit.isSuccess(exit)) return { _tag: "Success" };
  return Cause.hasInterruptsOnly(exit.cause)
    ? { _tag: "Interrupted", cause: Cause.pretty(exit.cause) }
    : { _tag: "Failure", cause: Cause.pretty(exit.cause) };
};

const recordOf = (span: RecordingSpan): EffectTraceRecord | null => {
  if (span.status._tag !== "Ended") return null;
  const { startTime, endTime, exit } = span.status;
  const parent = Option.getOrUndefined(span.parent);
  return {
    type: "effect-span",
    name: span.name,
    kind: span.kind,
    traceId: span.traceId,
    spanId: span.spanId,
    ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
    sampled: span.sampled,
    startTimeUnixNano: String(startTime),
    endTimeUnixNano: String(endTime),
    durationMs: Number(endTime - startTime) / 1_000_000,
    attributes: prepareAttributes(Object.fromEntries(span.attributes)),
    events: span.events.map(([name, time, attributes]) => ({
      name,
      timeUnixNano: String(time),
      attributes: prepareAttributes(attributes),
    })),
    links: span.links.map(({ span: linked, attributes: linkAttributes }) => ({
      attributes: prepareAttributes({ ...linkAttributes }),
      spanId: linked.spanId,
      traceId: linked.traceId,
    })),
    exit: exitOf(exit),
  };
};

/** A span that forwards everything to a delegate and keeps its own copy, to write out when it ends. */
class RecordingSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly annotations: Tracer.Span["annotations"];
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;
  readonly links: Array<Tracer.SpanLink>;
  readonly attributes = new Map<string, unknown>();
  readonly events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown>]> =
    [];
  status: Tracer.SpanStatus;

  private readonly delegate: Tracer.Span;
  private readonly sink: TraceSink;

  constructor(delegate: Tracer.Span, sink: TraceSink, startTime: bigint) {
    this.delegate = delegate;
    this.sink = sink;
    this.traceId = delegate.traceId;
    this.spanId = delegate.spanId;
    this.name = delegate.name;
    this.parent = delegate.parent;
    this.annotations = delegate.annotations;
    this.sampled = delegate.sampled;
    this.kind = delegate.kind;
    this.links = [...delegate.links];
    this.status = { _tag: "Started", startTime };
    for (const [key, value] of delegate.attributes) this.attributes.set(key, value);
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.status = { _tag: "Ended", startTime: this.status.startTime, endTime, exit };
    this.delegate.end(endTime, exit);
    if (!this.sampled) return;
    const record = recordOf(this);
    if (record !== null) this.sink.push(record);
  }

  attribute(key: string, value: unknown): void {
    this.delegate.attribute(key, value);
    this.attributes.set(key, value);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.delegate.event(name, startTime, attributes);
    this.events.push([name, startTime, attributes ?? {}]);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.delegate.addLinks(links);
    this.links.push(...links);
  }
}

export const makeFileTracer = Effect.fn("makeFileTracer")(function* (
  options: LocalFileTracerOptions,
) {
  const sink = options.sink ?? (yield* makeSpanSink(options));
  const delegate = options.delegate ?? nativeTracer;
  return Tracer.make({
    span(spanOptions) {
      return new RecordingSpan(delegate.span(spanOptions), sink, spanOptions.startTime);
    },
    ...(delegate.context === undefined ? {} : { context: delegate.context }),
  });
});
