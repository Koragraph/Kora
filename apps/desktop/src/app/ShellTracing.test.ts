import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";

import * as ShellConfig from "./ShellConfig.ts";
import * as ShellContext from "./ShellContext.ts";
import * as ShellTracing from "./ShellTracing.ts";

// One JSON line of server-child.log, and one span of shell.trace.ndjson, as far as these tests read them.
const Bag = Schema.Record(Schema.String, Schema.Unknown);
const parseChildLogLine = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      fiberId: Schema.String,
      timestamp: Schema.String,
      level: Schema.Literals(["ERROR", "INFO"]),
      message: Schema.String,
      spans: Bag,
      annotations: Bag,
    }),
  ),
);
const SpanEvent = Schema.Struct({ attributes: Bag, name: Schema.String });
const parseTraceLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ events: Schema.Array(SpanEvent), attributes: Bag, name: Schema.String }),
  ),
);

const MAX_BUFFERED_BYTES = 1024 * 1024;

/** An unpackaged checkout on Apple Silicon, with its home in `baseDir`. */
const hostInputIn = (baseDir: string): ShellContext.MakeShellContextInput => {
  const checkout = "/src/kora";
  return {
    homeDirectory: baseDir,
    appPath: checkout,
    dirname: `${checkout}/apps/desktop/dist-electron`,
    resourcesPath: `${checkout}/resources`,
    isPackaged: false,
    runningUnderArm64Translation: false,
    appVersion: "0.9.0",
    processArch: "arm64",
    platform: "darwin",
  };
};

/** The context for that host; `development` adds a dev-server URL (which makes the run a dev run). */
const hostLayerIn = (baseDir: string, development = true) => {
  const env = development
    ? { KORA_HOME: baseDir, VITE_DEV_SERVER_URL: "http://127.0.0.1:5733" }
    : { KORA_HOME: baseDir };
  return ShellContext.layer(hostInputIn(baseDir)).pipe(
    Layer.provide(Layer.merge(ShellConfig.layerTest(env), NodeServices.layer)),
  );
};

/** Opens the "primary" backend output log with one session started, runs `steps` on it, inside the tracing layer. */
const withOutputLog = <A, E>(
  hostLayer: ReturnType<typeof hostLayerIn>,
  details: string,
  steps: (
    log: Effect.Success<
      ReturnType<ShellTracing.ShellBackendOutputLogFactory["Service"]["forInstance"]>
    >,
  ) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    ShellTracing.ShellBackendOutputLogFactory.pipe(
      Effect.flatMap((factory) => factory.forInstance("primary")),
      Effect.tap((log) => log.beginSession({ details })),
      Effect.flatMap(steps),
      Effect.annotateLogs({ runId: "test-run" }),
      Effect.provide(ShellTracing.layer.pipe(Layer.provideMerge(hostLayer))),
    ),
  );

const testServices = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici);

/** Where the shell writes `fileName` under the log directory for this host layer. */
const logFileIn = (hostLayer: ReturnType<typeof hostLayerIn>, fileName: string) =>
  Effect.gen(function* () {
    const environment = yield* ShellContext.ShellContext;
    return environment.path.join(environment.logDir, fileName);
  }).pipe(Effect.provide(hostLayer));

const readLines = (fs: FileSystem.FileSystem, path: string) =>
  fs.readFileString(path).pipe(Effect.map((text) => text.trimEnd().split("\n")));

const readTraceRecords = (fs: FileSystem.FileSystem, path: string) =>
  fs.readFileString(path).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => parseTraceLine(line)),
    ),
  );

const withTempHost = <A, E, R>(
  prefix: string,
  development: boolean,
  body: (ctx: {
    readonly fs: FileSystem.FileSystem;
    readonly hostLayer: ReturnType<typeof hostLayerIn>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix });
    return yield* body({ fs, hostLayer: hostLayerIn(baseDir, development) });
  }).pipe(Effect.scoped, Effect.provide(testServices));

const encode = (text: string) => new TextEncoder().encode(text);

describe("ShellTracing", () => {
  it("moves an offset through a retained head chunk instead of copying it again", () => {
    const first = ShellTracing.appendBoundedOutputChunk(
      { runId: "test-run", startDetails: "pid=123", chunks: [], byteLength: 0 },
      "stderr",
      new Uint8Array(MAX_BUFFERED_BYTES),
    );
    const backing = first.chunks[0]?.chunk.buffer;

    const second = ShellTracing.appendBoundedOutputChunk(first, "stderr", Uint8Array.of(1));

    assert.equal(second.chunks[0]?.chunk.buffer, backing);
    assert.equal(second.chunks[0]?.offset, 1);
    assert.equal(second.byteLength, MAX_BUFFERED_BYTES);
  });

  it.effect("writes desktop Effect logs as span events to the shell trace file", () =>
    withTempHost("kora-desktop-observability-test-", true, ({ fs, hostLayer }) =>
      Effect.gen(function* () {
        const tracePath = yield* logFileIn(hostLayer, "shell.trace.ndjson");
        const logPath = yield* logFileIn(hostLayer, "desktop-main.log");

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan({ "shell.test": true });
            yield* Effect.logInfo("desktop trace event");
          }).pipe(
            Effect.withSpan("desktop-observability-test"),
            Effect.provide(ShellTracing.layer.pipe(Layer.provideMerge(hostLayer))),
          ),
        );

        const records = yield* readTraceRecords(fs, tracePath);
        const record = records.find((entry) => entry.name === "desktop-observability-test");

        assert.notEqual(record, undefined);
        if (!record) return;
        assert.equal(record.attributes["shell.test"], true);
        assert.isTrue(record.events.some((event) => event.name === "desktop trace event"));
        assert.isFalse(yield* fs.exists(logPath));
      }),
    ),
  );

  describe("backend child output log", () => {
    it.effect("keeps child output in memory and only writes it out on a reported failure", () =>
      withTempHost("kora-desktop-backend-output-log-test-", false, ({ fs, hostLayer }) =>
        Effect.gen(function* () {
          const logPath = yield* logFileIn(hostLayer, "server-child.log");
          const tracePath = yield* logFileIn(hostLayer, "shell.trace.ndjson");

          yield* Effect.gen(function* () {
            const factory = yield* ShellTracing.ShellBackendOutputLogFactory;
            const outputLog = yield* factory.forInstance("primary");
            yield* outputLog.beginSession({ details: "pid=123 port=3773 cwd=/repo" });
            yield* outputLog.writeOutputChunk("stdout", encode("hello server\n"));
            assert.isFalse(yield* fs.exists(logPath));
            yield* outputLog.persistFailure({ details: "code=1" });
            yield* outputLog.beginSession({ details: "pid=456" });
            yield* outputLog.writeOutputChunk("stderr", encode("normal shutdown\n"));
            yield* outputLog.discardSession;
          }).pipe(
            Effect.annotateLogs({ runId: "test-run" }),
            Effect.provide(ShellTracing.layer.pipe(Layer.provideMerge(hostLayer))),
          );

          const lines = yield* readLines(fs, logPath);
          const start = yield* parseChildLogLine(lines[0] ?? "");
          const output = yield* parseChildLogLine(lines[1] ?? "");
          const end = yield* parseChildLogLine(lines[2] ?? "");

          assert.lengthOf(lines, 3, "start, one output line, end");
          const shared = {
            component: "desktop-backend-child",
            runId: "test-run",
            instanceId: "primary",
          };
          assert.deepInclude(start, {
            level: "ERROR",
            message: "backend child process failure output start",
          });
          assert.deepInclude(start.annotations, {
            ...shared,
            phase: "START",
            details: "pid=123 port=3773 cwd=/repo",
          });
          assert.deepInclude(output, { level: "INFO", message: "backend child process output" });
          assert.deepInclude(output.annotations, {
            ...shared,
            stream: "stdout",
            text: "hello server\n",
          });
          assert.deepInclude(end, {
            level: "ERROR",
            message: "backend child process failure output end",
          });
          assert.deepInclude(end.annotations, {
            instanceId: "primary",
            phase: "END",
            details: "code=1",
          });

          const traced = yield* readTraceRecords(fs, tracePath);
          assert.isFalse(
            traced.some(
              (record) => record.name === "shell.observability.backendOutput.writeOutputChunk",
            ),
          );
        }),
      ),
    );

    it.effect("goes on buffering after a snapshot that is not the final failure", () =>
      withTempHost("kora-desktop-backend-output-snapshot-test-", false, ({ fs, hostLayer }) =>
        Effect.gen(function* () {
          const logPath = yield* logFileIn(hostLayer, "server-child.log");

          yield* Effect.gen(function* () {
            const factory = yield* ShellTracing.ShellBackendOutputLogFactory;
            const outputLog = yield* factory.forInstance("primary");
            yield* outputLog.beginSession({ details: "pid=123" });
            yield* outputLog.writeOutputChunk("stdout", encode("before timeout\n"));
            yield* outputLog.persistFailureSnapshot({ details: "readiness timeout" });
            yield* outputLog.writeOutputChunk("stderr", encode("after timeout\n"));
            yield* outputLog.persistFailure({ details: "code=1" });
          }).pipe(
            Effect.annotateLogs({ runId: "test-run" }),
            Effect.provide(ShellTracing.layer.pipe(Layer.provideMerge(hostLayer))),
          );

          const records = yield* Effect.forEach(yield* readLines(fs, logPath), (line) =>
            parseChildLogLine(line),
          );
          assert.isTrue(records.some((record) => record.annotations.text === "after timeout\n"));
          assert.equal(records.at(-1)?.annotations.details, "code=1");
        }),
      ),
    );

    it.effect("keeps only the last mebibyte of child output", () =>
      withTempHost("kora-desktop-backend-output-bound-test-", false, ({ fs, hostLayer }) =>
        Effect.gen(function* () {
          const logPath = yield* logFileIn(hostLayer, "server-child.log");
          const discardedPrefix = 128;
          const output = new Uint8Array(MAX_BUFFERED_BYTES + discardedPrefix);
          output.fill("x".charCodeAt(0));
          output.fill("y".charCodeAt(0), 0, discardedPrefix);

          yield* withOutputLog(hostLayer, "pid=123", (log) =>
            log
              .writeOutputChunk("stderr", output)
              .pipe(Effect.andThen(log.persistFailure({ details: "code=1" }))),
          );

          const record = yield* parseChildLogLine((yield* readLines(fs, logPath))[1] ?? "");
          const kept = String(record.annotations.text);
          // Exactly the newest mebibyte survives: the "y" prefix written first is gone.
          assert.deepEqual([encode(kept).byteLength, kept.indexOf("y")], [MAX_BUFFERED_BYTES, -1]);
        }),
      ),
    );

    it.effect("limits how many output chunks it holds on to", () =>
      withTempHost("kora-desktop-backend-output-chunks-test-", false, ({ fs, hostLayer }) =>
        Effect.gen(function* () {
          const logPath = yield* logFileIn(hostLayer, "server-child.log");

          // 300 one-byte writes: the log keeps a bounded number of chunks, so the file has start + 256 + end lines.
          yield* withOutputLog(hostLayer, "pid=123", (log) =>
            Effect.forEach(
              Array.from({ length: 300 }, (_, n) => Uint8Array.of(n % 128)),
              (b) => log.writeOutputChunk("stderr", b),
              { discard: true },
            ).pipe(Effect.andThen(log.persistFailure({ details: "code=1" }))),
          );

          assert.equal((yield* readLines(fs, logPath)).length, 258);
        }),
      ),
    );
  });
});
