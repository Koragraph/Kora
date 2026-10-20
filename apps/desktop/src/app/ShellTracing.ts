import * as OtlpTracer from "effect/unstable/observability/OtlpTracer";
import * as OtlpExporter from "effect/unstable/observability/OtlpExporter";
import * as Tracer from "effect/Tracer";
import * as Semaphore from "effect/Semaphore";
import * as References from "effect/References";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import { makeFileTracer, otlpSerializationLayer } from "@kora/shared/otlp";
import { parsePersistedDaemonTracingPrefs } from "@kora/shared/daemonPrefs";
import { PRIMARY_LOCAL_HOST_ID } from "@kora/contracts";

import * as ShellContext from "./ShellContext.ts";

const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const TRACE_BATCH_WINDOW_MS = 1_000;
const BACKEND_OUTPUT_MAX_BYTES = 1024 * 1024;
const BACKEND_OUTPUT_MAX_CHUNKS = 256;
const BACKEND_CHILD_FIBER_ID = "#backend-child";

// ---------------------------------------------------------------------------------------------------------------
// Component loggers

export type ShellLogAnnotations = Record<string, unknown>;

export interface ShellComponentLogger {
  readonly annotate: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    notes?: ShellLogAnnotations,
  ) => Effect.Effect<A, E, R>;
  readonly logDebug: (msg: string, notes?: ShellLogAnnotations) => Effect.Effect<void>;
  readonly logInfo: (msg: string, notes?: ShellLogAnnotations) => Effect.Effect<void>;
  readonly logWarning: (msg: string, notes?: ShellLogAnnotations) => Effect.Effect<void>;
  readonly logError: (msg: string, notes?: ShellLogAnnotations) => Effect.Effect<void>;
}

/** A logger whose every line carries `component`, plus any per-call annotations. */
export function makeScopedLogger(component: string): ShellComponentLogger {
  const annotate = <A, E, R>(effect: Effect.Effect<A, E, R>, notes?: ShellLogAnnotations) =>
    effect.pipe(Effect.annotateLogs({ component, ...notes }));
  const when =
    (write: (msg: string) => Effect.Effect<void>) => (msg: string, notes?: ShellLogAnnotations) =>
      annotate(write(msg), notes);
  return {
    annotate,
    logDebug: when(Effect.logDebug),
    logInfo: when(Effect.logInfo),
    logWarning: when(Effect.logWarning),
    logError: when(Effect.logError),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Rotating files

export interface RotatingLogFileWriter {
  readonly writeBytes: (piece: Uint8Array) => Effect.Effect<void>;
  readonly writeText: (piece: string) => Effect.Effect<void>;
}

const makeRotatingLogFileWriter = Effect.fn("shell.observability.rotatingWriter")(
  function* (options: {
    readonly maxFiles?: number;
    readonly maxBytes?: number;
    readonly filePath: string;
  }) {
    const maxBytes = options.maxBytes ?? LOG_FILE_MAX_BYTES;
    const maxFiles = options.maxFiles ?? LOG_FILE_MAX_FILES;
    if (maxBytes < 1)
      return yield* Effect.die(new Error(`maxBytes must be >= 1 (received ${maxBytes})`));
    if (maxFiles < 1)
      return yield* Effect.die(new Error(`maxFiles must be >= 1 (received ${maxFiles})`));

    const fsys = yield* FileSystem.FileSystem;
    const loc = yield* Path.Path;
    const lock = yield* Semaphore.make(1);
    const encoder = new TextEncoder();
    const { filePath } = options;

    yield* fsys.makeDirectory(loc.dirname(filePath), { recursive: true });

    const readSize = fsys.stat(filePath).pipe(
      Effect.map((meta) => Number(meta.size)),
      Effect.orElseSucceed(() => 0),
    );

    // Drop backups beyond the retention limit (left over from a run with a larger limit).
    const directory = loc.dirname(filePath);
    const fallbackBase = loc.basename(filePath);
    const names = yield* fsys.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    for (const label of names) {
      if (!label.startsWith(`${fallbackBase}.`)) continue;
      const ending = label.slice(fallbackBase.length + 1);
      if (/^\d+$/.test(ending) && Number(ending) > maxFiles) {
        yield* fsys.remove(loc.join(directory, label), { force: true }).pipe(Effect.ignore);
      }
    }

    let extent = yield* readSize;

    const rotate = Effect.gen(function* () {
      yield* fsys.remove(`${filePath}.${maxFiles}`, { force: true });
      for (let pos = maxFiles - 1; pos >= 1; pos -= 1) {
        const from = `${filePath}.${pos}`;
        if (yield* fsys.exists(from)) yield* fsys.rename(from, `${filePath}.${pos + 1}`);
      }
      if (yield* fsys.exists(filePath)) yield* fsys.rename(filePath, `${filePath}.1`);
      extent = 0;
    });

    const writeBytes = (piece: Uint8Array) =>
      piece.byteLength === 0
        ? Effect.void
        : lock.withPermits(1)(
            Effect.gen(function* () {
              if (extent > 0 && extent + piece.byteLength > maxBytes) yield* rotate;
              yield* fsys.writeFile(filePath, piece, { flag: "a" });
              extent += piece.byteLength;
              if (extent > maxBytes) yield* rotate;
            }).pipe(
              // Logging must never take the app down; resynchronise with the disk after any failure.
              Effect.catch(() =>
                readSize.pipe(
                  Effect.map((actual) => {
                    extent = actual;
                  }),
                ),
              ),
            ),
          );

    return {
      writeBytes,
      writeText: (str: string) => writeBytes(encoder.encode(str)),
    } satisfies RotatingLogFileWriter;
  },
);

// ---------------------------------------------------------------------------------------------------------------
// Backend child output

interface BufferedChunk {
  /** How many leading bytes of `chunk` were already discarded. */
  readonly offset: number;
  readonly chunk: Uint8Array;
  readonly streamName: "stdout" | "stderr";
}

interface BackendOutputSession {
  readonly byteLength: number;
  readonly chunks: ReadonlyArray<BufferedChunk>;
  readonly startDetails: string;
  readonly runId: string;
}

const retainedBytes = (rec: BufferedChunk) => rec.chunk.byteLength - rec.offset;

/** Pure: add a chunk, then trim from the front until both the byte and chunk-count bounds hold. */
export function appendBoundedOutputChunk(
  sess: BackendOutputSession,
  streamName: "stdout" | "stderr",
  piece: Uint8Array,
): BackendOutputSession {
  if (piece.byteLength === 0) return sess;
  const tail =
    piece.byteLength > BACKEND_OUTPUT_MAX_BYTES
      ? piece.subarray(piece.byteLength - BACKEND_OUTPUT_MAX_BYTES)
      : piece;
  const records = [...sess.chunks, { streamName, chunk: tail, offset: 0 }];
  let total = sess.byteLength + tail.byteLength;

  while (total > BACKEND_OUTPUT_MAX_BYTES) {
    const head = records[0]!;
    const excess = total - BACKEND_OUTPUT_MAX_BYTES;
    const available = retainedBytes(head);
    if (excess >= available) {
      records.shift();
      total -= available;
    } else {
      records[0] = { ...head, offset: head.offset + excess };
      total -= excess;
    }
  }
  while (records.length > BACKEND_OUTPUT_MAX_CHUNKS) {
    total -= retainedBytes(records.shift()!);
  }
  return { ...sess, chunks: records, byteLength: total };
}

export interface ShellBackendOutputLogShape {
  readonly beginSession: (info: { readonly details: string }) => Effect.Effect<void>;
  readonly writeOutputChunk: (
    streamName: "stdout" | "stderr",
    piece: Uint8Array,
  ) => Effect.Effect<void>;
  /** Write what was captured so far but keep capturing. */
  readonly persistFailureSnapshot: (info: { readonly details: string }) => Effect.Effect<void>;
  /** Write what was captured and end the session. */
  readonly persistFailure: (info: { readonly details: string }) => Effect.Effect<void>;
  readonly discardSession: Effect.Effect<void>;
}

export class ShellBackendOutputLogFactory extends Context.Service<
  ShellBackendOutputLogFactory,
  { readonly forInstance: (instanceId: string) => Effect.Effect<ShellBackendOutputLogShape> }
>()("@kora/desktop/app/ShellTracing/ShellBackendOutputLogFactory") {}

const collapseWhitespace = (str: string) => str.replace(/\s+/g, " ").trim();

const noopOutputLog: ShellBackendOutputLogShape = {
  discardSession: Effect.void,
  persistFailure: () => Effect.void,
  persistFailureSnapshot: () => Effect.void,
  writeOutputChunk: () => Effect.void,
  beginSession: () => Effect.void,
};

const backendLogFileName = (instanceId: string) =>
  instanceId === PRIMARY_LOCAL_HOST_ID
    ? "server-child.log"
    : `server-child-${instanceId.replace(/[^A-Za-z0-9._-]+/g, "_")}.log`;

const makeBackendOutputLogFactory = Effect.gen(function* () {
  const envVars = yield* ShellContext.ShellContext;
  const fsys = yield* FileSystem.FileSystem;
  const loc = yield* Path.Path;
  const cacheLock = yield* Semaphore.make(1);
  // One writer per resolved file: ids that sanitise to the same name must not race each other.
  const writers = new Map<string, RotatingLogFileWriter | null>();
  const { logWarning } = makeScopedLogger("desktop-backend-child");

  const writerFor = (filePath: string) =>
    cacheLock.withPermits(1)(
      Effect.gen(function* () {
        const recognised = writers.get(filePath);
        if (recognised !== undefined) return recognised;
        const created = yield* makeRotatingLogFileWriter({ filePath }).pipe(
          Effect.provideService(FileSystem.FileSystem, fsys),
          Effect.provideService(Path.Path, loc),
          Effect.map((writer): RotatingLogFileWriter | null => writer),
          Effect.catchCause(() => Effect.succeed(null)),
        );
        writers.set(filePath, created);
        return created;
      }),
    );

  return ShellBackendOutputLogFactory.of({
    forInstance: (instanceId) =>
      Effect.gen(function* () {
        const writer = yield* writerFor(loc.join(envVars.logDir, backendLogFileName(instanceId)));
        if (writer === null) return noopOutputLog;

        let sess: BackendOutputSession | null = null;

        const persist = (live: BackendOutputSession, endDetails: string) =>
          Effect.gen(function* () {
            const clock = yield* DateTime.now;
            const decoder = new TextDecoder();
            const fallbackBase = {
              component: "desktop-backend-child",
              runId: live.runId,
              instanceId: instanceId,
            };
            const ln = (msg: string, level: "INFO" | "ERROR", notes: Record<string, unknown>) =>
              `${JSON.stringify({
                message: msg,
                level,
                timestamp: DateTime.formatIso(clock),
                annotations: notes,
                spans: {},
                fiberId: BACKEND_CHILD_FIBER_ID,
              })}\n`;
            let str = ln("backend child process failure output start", "ERROR", {
              ...fallbackBase,
              phase: "START",
              details: live.startDetails,
            });
            for (const rec of live.chunks) {
              str += ln(
                "backend child process output",
                rec.streamName === "stderr" ? "ERROR" : "INFO",
                {
                  ...fallbackBase,
                  stream: rec.streamName,
                  text: decoder.decode(rec.chunk.subarray(rec.offset)),
                },
              );
            }
            str += ln("backend child process failure output end", "ERROR", {
              ...fallbackBase,
              phase: "END",
              details: collapseWhitespace(endDetails),
            });
            yield* writer.writeText(str);
          }).pipe(
            Effect.catchCause((reason) =>
              logWarning("failed to persist backend child output", { cause: String(reason) }),
            ),
          );

        return {
          beginSession: ({ details }) =>
            Effect.gen(function* () {
              const notes = yield* References.CurrentLogAnnotations;
              const runId = notes.runId;
              sess = {
                runId: typeof runId === "string" && runId.length > 0 ? runId : "unknown",
                startDetails: collapseWhitespace(details),
                chunks: [],
                byteLength: 0,
              };
            }),
          writeOutputChunk: (streamName, piece) =>
            Effect.sync(() => {
              if (envVars.isDevelopment) {
                try {
                  (streamName === "stderr" ? process.stderr : process.stdout).write(piece);
                } catch {
                  // A closed terminal is not worth reporting.
                }
              }
              if (sess) sess = appendBoundedOutputChunk(sess, streamName, piece);
            }),
          persistFailureSnapshot: ({ details }) =>
            Effect.suspend(() => (sess ? persist(sess, details) : Effect.void)),
          persistFailure: ({ details }) =>
            Effect.suspend(() => {
              const taken = sess;
              sess = null;
              return taken ? persist(taken, details) : Effect.void;
            }),
          discardSession: Effect.sync(() => {
            sess = null;
          }),
        } satisfies ShellBackendOutputLogShape;
      }),
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Layers

const backendOutputLayer = Layer.effect(ShellBackendOutputLogFactory, makeBackendOutputLogFactory);

const loggerLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty(), Logger.tracerLogger], { mergeWithExisting: false }),
  Layer.succeed(References.MinimumLogLevel, "Info"),
);

// The OTLP address comes from the environment first, then from the daemon's persisted settings.
const resolveOtlpTracesUrl = Effect.gen(function* () {
  const envVars = yield* ShellContext.ShellContext;
  const fsys = yield* FileSystem.FileSystem;
  if (Option.isSome(envVars.otlpTracesUrl)) return envVars.otlpTracesUrl;
  const unparsed = yield* fsys
    .readFileString(envVars.daemonSettingsPath)
    .pipe(Effect.orElseSucceed(() => ""));
  return Option.fromNullishOr(parsePersistedDaemonTracingPrefs(unparsed).otlpTracesUrl);
});

const makeShellTracer = Effect.gen(function* () {
  const envVars = yield* ShellContext.ShellContext;
  const address = yield* resolveOtlpTracesUrl;
  const delegate = Option.isSome(address)
    ? yield* OtlpTracer.make({
        url: address.value,
        exportInterval: Duration.millis(envVars.otlpExportIntervalMs),
        ...(Option.isSome(envVars.otlpHeaders) ? { headers: envVars.otlpHeaders.value } : {}),
        resource: {
          serviceName: "desktop",
          attributes: {
            "service.runtime": "desktop",
            "service.mode": envVars.isDevelopment ? "development" : "packaged",
          },
        },
      }).pipe(Effect.provide(otlpSerializationLayer(envVars.otlpProtocol)))
    : undefined;
  return yield* makeFileTracer({
    filePath: envVars.path.join(envVars.logDir, "shell.trace.ndjson"),
    maxBytes: LOG_FILE_MAX_BYTES,
    maxFiles: LOG_FILE_MAX_FILES,
    batchWindowMs: TRACE_BATCH_WINDOW_MS,
    ...(delegate ? { delegate } : {}),
  });
});

const tracerLayer = Layer.mergeAll(
  Layer.effect(Tracer.Tracer, makeShellTracer),
  Layer.succeed(Tracer.MinimumTraceLevel, "Info"),
  Layer.succeed(References.TracerTimingEnabled, true),
).pipe(Layer.provideMerge(OtlpExporter.layerFlusher));

export const layer = Layer.mergeAll(backendOutputLayer, loggerLayer, tracerLayer);
