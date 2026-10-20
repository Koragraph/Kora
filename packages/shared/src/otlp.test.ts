import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

import * as Obs from "./otlp.ts";

const MARK = "…[truncated]";
const LOG_NAME = "spans.ndjson";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const Attrs = Schema.Record(Schema.String, Schema.Unknown);
const Id = Schema.String;
const WrittenSpan = Schema.Struct({
  spanId: Id,
  name: Schema.String,
  attributes: Attrs,
  parentSpanId: Schema.optional(Id),
  events: Schema.Array(Schema.Struct({ name: Schema.String, attributes: Attrs })),
  exit: Schema.optional(Schema.Struct({ _tag: Schema.String })),
});
const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(WrittenSpan));

function record(name: string, payload = ""): Obs.TraceRecord {
  return {
    type: "effect-span",
    kind: "internal",
    name,
    traceId: `t:${name}:${payload}`,
    spanId: `s:${name}:${payload}`,
    sampled: true,
    startTimeUnixNano: "10",
    endTimeUnixNano: "20",
    durationMs: 1,
    attributes: { payload },
    events: [],
    links: [],
    exit: { _tag: "Success" },
  };
}

const readSpans = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const body = yield* fs.readFileString(file);
    return body.split("\n").flatMap((line) => (line.trim() === "" ? [] : [decodeLine(line)]));
  });

const spanNames = (file: string) =>
  readSpans(file).pipe(Effect.map((spans) => spans.map(({ name }) => name)));

/** Temp folder + log path, cleaned up with the scope. */
const withLogDir = <A, E, R>(
  use: (where: { fs: FileSystem.FileSystem; dir: string; file: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const [fs, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path]);
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "kora-obs-" });
    return yield* use({ fs, dir, file: path.join(dir, LOG_NAME) });
  }).pipe(Effect.scoped);

const sinkConfig = (file: string, maxBytes = 1024) => ({
  filePath: file,
  maxBytes,
  maxFiles: 2,
  batchWindowMs: 10_000,
});

const logFilesIn = (fs: FileSystem.FileSystem, dir: string) =>
  fs
    .readDirectory(dir)
    .pipe(
      Effect.map((names) => names.filter((n) => n === LOG_NAME || n.startsWith(`${LOG_NAME}.`))),
    );

const fileTracing = (file: string) =>
  Layer.mergeAll(
    Layer.effect(Tracer.Tracer, Obs.makeFileTracer({ ...sinkConfig(file, 1024 * 1024) })),
    Logger.layer([Logger.tracerLogger], { mergeWithExisting: false }),
    Layer.succeed(References.MinimumLogLevel, "Info"),
  );

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("error tags", () => {
  it("keeps tag-like names and replaces anything else", () => {
    expect(Obs.errorTag({ _tag: "SocketClosed" })).toBe("SocketClosed");
    expect(Obs.errorTag(new RangeError("password=hunter2"))).toBe("RangeError");
    expect(Obs.errorTag({ _tag: "has spaces in it" })).toBe("TaggedError");
  });
});

describe("attribute truncation", () => {
  it("shortens long strings at every depth without mutating the input", () => {
    const trace = "t".repeat(1_500);
    const attrs = {
      "db.query.text": "select ".repeat(400),
      tiny: "fine",
      error: { name: "Boom", stack: trace, nested: ["n".repeat(1_500)] },
    };

    const out = Obs.truncateTraceAttributes(attrs);
    const error = out["error"] as { stack: string; nested: string[] };

    expect((out["db.query.text"] as string).length).toBe(200 + MARK.length);
    expect(out["tiny"]).toBe("fine");
    expect(error.stack.length).toBe(500 + MARK.length);
    expect(error.nested[0]!.length).toBe(500 + MARK.length);
    // The span still holds the original object.
    expect(attrs.error.stack).toBe(trace);
  });

  it("returns the input itself when nothing is long", () => {
    const attrs = { a: "x", b: { c: "y" } };
    expect(Obs.truncateTraceAttributes(attrs)).toBe(attrs);
  });
});

describe("attribute compaction", () => {
  it("marks self-references in arrays, maps and sets", () => {
    const list: unknown[] = [1];
    list.push(list);
    const map = new Map<string, unknown>([["me", null]]);
    map.set("me", map);
    const set = new Set<unknown>();
    set.add(set);

    expect(Obs.compactTraceAttributes({ list, map, set })).toStrictEqual({
      list: [1, "[Circular]"],
      map: { me: "[Circular]" },
      set: ["[Circular]"],
    });
  });

  it("prints an invalid Date as text", () => {
    // @effect-diagnostics-next-line globalDate:off
    const when = new Date(Number.NaN);
    expect(Obs.compactTraceAttributes({ when })).toStrictEqual({ when: "Invalid Date" });
  });
});

describe("OTLP header strings", () => {
  const parse = Schema.decodeUnknownSync(Obs.OtlpHeadersFromString);

  it("percent-decodes values and trims around separators", () => {
    expect(parse("api-key=a%2Bb%20c,x-org=acme")).toEqual({ "api-key": "a+b c", "x-org": "acme" });
    expect(parse(" api-key = a%2Bb%20c ,x-org= acme ,")).toEqual({
      "api-key": "a+b c",
      "x-org": "acme",
    });
  });

  it("splits only on the first equals sign and allows empty values", () => {
    expect(parse("token=abc=def==")).toEqual({ token: "abc=def==" });
    expect(parse("x-blank=")).toEqual({ "x-blank": "" });
  });

  it.each(["no-equals-here", "=orphan", "bad=%ZZ"])("throws on %j", (raw) => {
    expect(() => parse(raw)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// sink and tracer against a real file system
// ---------------------------------------------------------------------------

it.layer(NodeServices.layer)("span sink on disk", (it) => {
  it.effect("flushes what is buffered on close", () =>
    withLogDir(({ file }) =>
      Effect.gen(function* () {
        const sink = yield* Obs.makeSpanSink(sinkConfig(file));
        for (const name of ["one", "two"]) sink.push(record(name));
        yield* sink.close();
        assert.deepStrictEqual(yield* spanNames(file), ["one", "two"]);
      }),
    ),
  );

  it.effect("calls onFlush once per write with its size", () =>
    withLogDir(({ file }) =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<Obs.TraceSinkFlushStats[]>([]);
        const sink = yield* Obs.makeSpanSink({
          ...sinkConfig(file),
          onFlush: (stats) => Ref.update(seen, (all) => [...all, stats]),
        });
        sink.push(record("measured"));
        yield* sink.flush;

        const stats = yield* Ref.get(seen);
        assert.strictEqual(stats.length, 1);
        assert.strictEqual(stats[0]!.count, 1);
        assert.isAbove(stats[0]!.logicalWriteBytes, 0);
      }),
    ),
  );

  it.effect("rotates past the cap and keeps at most maxFiles backups", () =>
    withLogDir(({ fs, dir, file }) =>
      Effect.gen(function* () {
        const sink = yield* Obs.makeSpanSink(sinkConfig(file, 500));
        for (let i = 0; i < 8; i++) {
          sink.push(record("roll", `${i}:${"p".repeat(48)}`));
          yield* sink.flush;
        }
        yield* sink.close();

        const files = new Set(yield* logFilesIn(fs, dir));
        assert.isTrue(files.has(`${LOG_NAME}.1`));
        assert.isFalse(files.has(`${LOG_NAME}.3`));
      }),
    ),
  );

  it.effect("never lets a size-triggered flush overshoot the cap", () =>
    withLogDir(({ fs, dir, file }) =>
      Effect.gen(function* () {
        const cap = 1024;
        const sink = yield* Obs.makeSpanSink(sinkConfig(file, cap));
        for (let i = 0; i < 256; i++) sink.push(record("burst", `${i}:${"p".repeat(48)}`));
        yield* sink.close();

        const files = yield* logFilesIn(fs, dir);
        assert.include(files, `${LOG_NAME}.1`);
        for (const name of files) {
          const { size } = yield* fs.stat(`${dir}/${name}`);
          assert.isAtMost(Number(size), cap, name);
        }
      }),
    ),
  );

  it.effect("drops a record larger than the cap but writes the next one", () =>
    withLogDir(({ fs, file }) =>
      Effect.gen(function* () {
        const cap = 1024;
        const sink = yield* Obs.makeSpanSink(sinkConfig(file, cap));
        sink.push(record("huge", "h".repeat(cap * 2)));
        sink.push(record("kept"));
        yield* sink.close();

        assert.deepStrictEqual(yield* spanNames(file), ["kept"]);
        assert.isAtMost(Number((yield* fs.stat(file)).size), cap);
      }),
    ),
  );

  it.effect("drops only a record that cannot be serialised", () =>
    withLogDir(({ file }) =>
      Effect.gen(function* () {
        const cyclic: unknown[] = [];
        cyclic.push(cyclic);
        const sink = yield* Obs.makeSpanSink(sinkConfig(file));
        sink.push(record("before"));
        sink.push({ ...record("broken"), attributes: { cyclic } } as Obs.TraceRecord);
        sink.push(record("after"));
        yield* sink.close();

        assert.deepStrictEqual(yield* spanNames(file), ["before", "after"]);
      }),
    ),
  );

  it.effect("file tracer: writes parent/child spans with their logs as events", () =>
    withLogDir(({ file }) =>
      Effect.gen(function* () {
        const inner = Effect.annotateCurrentSpan({ "test.inner": true }).pipe(
          Effect.andThen(Effect.logInfo("inner log")),
          Effect.withSpan("inner"),
        );
        const outer = Effect.annotateCurrentSpan({ "test.outer": true }).pipe(
          Effect.andThen(Effect.logInfo("outer log")),
          Effect.andThen(inner),
          Effect.withSpan("outer"),
        );
        yield* Effect.scoped(outer.pipe(Effect.provide(fileTracing(file))));

        const spans = yield* readSpans(file);
        assert.strictEqual(spans.length, 2);
        const byName = new Map(spans.map((span) => [span.name, span]));
        const o = byName.get("outer");
        const i = byName.get("inner");
        assert.ok(o && i);

        assert.strictEqual(i.parentSpanId, o.spanId);
        assert.isTrue(o.attributes["test.outer"]);
        assert.isTrue(i.attributes["test.inner"]);
        assert.ok(o.events.find((event) => event.name === "outer log"));
        assert.ok(i.events.find((event) => event.name === "inner log"));
        assert.ok(i.events.find((event) => event.attributes["effect.logLevel"] === "INFO"));
      }),
    ),
  );

  it.effect("file tracer: an interrupted span is written with an Interrupted exit", () =>
    withLogDir(({ file }) =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.exit(
            Effect.interrupt.pipe(Effect.withSpan("cut"), Effect.provide(fileTracing(file))),
          ),
        );
        const spans = yield* readSpans(file);
        assert.deepStrictEqual(
          spans.map((span) => [span.name, span.exit?._tag]),
          [["cut", "Interrupted"]],
        );
      }),
    ),
  );
});
