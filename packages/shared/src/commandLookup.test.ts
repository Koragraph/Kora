import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import { CommandResolutionCache, isCommandAvailable, resolveCommandPath } from "./commandLookup.ts";

// oxlint-disable-next-line kora/no-global-process-runtime -- host conventions decided before any runtime exists
const ON_WINDOWS = process.platform === "win32";
const NOWHERE = "kora-no-such-binary";

/** Did resolving `command` fail? */
const misses = (command: string, options: Parameters<typeof resolveCommandPath>[1]) =>
  resolveCommandPath(command, options).pipe(
    Effect.result,
    Effect.map((result) => result._tag === "Failure"),
  );

const freshCache = Effect.provideService(CommandResolutionCache, new Map());

effectIt.layer(NodeServices.layer)("command lookup", (it) => {
  it.effect("an empty PATH finds nothing", () =>
    Effect.gen(function* () {
      expect(yield* isCommandAvailable(NOWHERE, { env: { PATH: "" } })).toBe(false);
      expect(yield* misses(NOWHERE, { env: { PATH: "" } })).toBe(true);
    }),
  );

  it.effect("duplicate PATH entries are probed once", () => {
    const stats: string[] = [];
    const recordingFs = FileSystem.layerNoop({
      stat: (target) =>
        Effect.sync(() => {
          stats.push(target);
          return { type: "Directory" } as FileSystem.File.Info;
        }),
    });
    const PATH = ["/usr/bin", "/opt/x", "/usr/bin", "/opt/x", "/usr/bin"].join(
      ON_WINDOWS ? ";" : ":",
    );
    return Effect.gen(function* () {
      expect(yield* misses(NOWHERE, { env: { PATH } })).toBe(true);
      // No candidate twice (Windows tries each PATHEXT name per directory).
      expect(stats.length).toBe(new Set(stats).size);
      const parents = new Set(stats.map((candidate) => candidate.replace(/[\\/][^\\/]*$/, "")));
      expect(parents.size).toBe(2);
    }).pipe(freshCache, Effect.provide(recordingFs));
  });

  // POSIX exec bits only; Windows decides by PATHEXT extension.
  it.effect.skipIf(ON_WINDOWS)("only an executable regular file counts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const bin = yield* fs.makeTempDirectoryScoped({ prefix: "kora-which-" });
      const write = (name: string, mode: number) =>
        fs
          .writeFileString(join(bin, name), "#!/bin/sh\n")
          .pipe(Effect.andThen(fs.chmod(join(bin, name), mode)));
      yield* write("runner", 0o755);
      yield* write("readme", 0o644);
      yield* fs.makeDirectory(join(bin, "folder"));

      const env = { PATH: bin };
      expect(yield* resolveCommandPath("runner", { env })).toBe(join(bin, "runner"));
      expect(yield* misses("readme", { env })).toBe(true);
      expect(yield* misses("folder", { env })).toBe(true);
    }).pipe(freshCache),
  );

  it.effect("a cached miss lasts until it expires, but explicit paths bypass it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const bin = yield* fs.makeTempDirectoryScoped({ prefix: "kora-which-cache-" });
      const target = join(bin, ON_WINDOWS ? "later.exe" : "later");
      const lookup = { env: { PATH: bin } };

      expect(yield* misses("later", lookup)).toBe(true);
      yield* fs.writeFileString(target, "#!/bin/sh\n");
      yield* fs.chmod(target, 0o755);

      expect(yield* misses("later", lookup)).toBe(true);
      expect(yield* resolveCommandPath(target, lookup)).toBe(target);

      yield* TestClock.adjust("30 seconds");
      expect(yield* resolveCommandPath("later", lookup)).toBe(target);
    }).pipe(freshCache),
  );
});
