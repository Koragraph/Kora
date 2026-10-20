import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";

import { MachineEnv } from "./hostMachine.ts";

export interface CommandAvailabilityOptions {
  /** Accepted for callers that pass it; the lookup is always on the given env. */
  readonly extendEnv?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

class CommandResolutionError extends Data.TaggedError("CommandResolutionError")<{
  readonly command: string;
  readonly reason: "not-found";
}> {}

interface CachedResolution {
  readonly resolvedPath: string | null;
  readonly expiresAtNanos: bigint;
}

// Session bootstrap resolves the same few commands thousands of times, so answers (misses
// included) are remembered for a short while. The clock is monotonic: a wall-clock change
// must not keep a stale answer alive.
const CACHE_TTL_NANOS = 30_000_000_000n;
const CACHE_MAX_ENTRIES = 512;

export const CommandResolutionCache = Context.Reference<Map<string, CachedResolution>>(
  "@kora/shared/commandLookup/CommandResolutionCache",
  { defaultValue: () => new Map() },
);

const pathVariable = (env: NodeJS.ProcessEnv): string => env.PATH ?? env.Path ?? env.path ?? "";

// oxlint-disable-next-line kora/no-global-process-runtime -- a module-level constant read before any Effect runtime exists
const isWindows = process.platform === "win32";
/** Windows: the extensions PATH lookups try (`codex` finds `codex.cmd`); a file is executable by its extension. */
const pathExts = (env: NodeJS.ProcessEnv): string[] =>
  (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((e) => e.length > 0)
    .map((e) => e.toLowerCase());

const isExecutableFile = (fs: FileSystem.FileSystem, candidate: string): Effect.Effect<boolean> =>
  fs.stat(candidate).pipe(
    // A regular file with any execute bit set (Windows has none: a PATHEXT extension).
    Effect.map(
      (info) =>
        info.type === "File" &&
        (isWindows
          ? pathExts(process.env).some((e) => candidate.toLowerCase().endsWith(e))
          : (info.mode & 0o111) !== 0),
    ),
    Effect.orElseSucceed(() => false),
  );

const notFound = (command: string) => new CommandResolutionError({ command, reason: "not-found" });

/** The first executable named `command` on PATH, or an explicit path if it is one. */
export const resolveCommandPath = Effect.fn("shell.resolveCommandPath")(function* (
  command: string,
  options?: CommandAvailabilityOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnv = yield* MachineEnv;
  const pathValue = pathVariable(options?.env ?? hostEnv);

  // Callers probe files they just wrote, so an explicit path is never cached.
  if (command.includes("/") || command.includes("\\")) {
    return (yield* isExecutableFile(fs, command)) ? command : yield* Effect.fail(notFound(command));
  }
  if (pathValue.length === 0) return yield* Effect.fail(notFound(command));

  const cache = yield* CommandResolutionCache;
  const now = yield* Clock.currentTimeNanos;
  const key = `${pathValue}\0${command}`;
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAtNanos > now) {
    return cached.resolvedPath ?? (yield* Effect.fail(notFound(command)));
  }

  const directories = [
    ...new Set(
      pathValue
        .split(isWindows ? ";" : ":")
        .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
        .filter((entry) => entry.length > 0),
    ),
  ];
  let resolved: string | null = null;
  const names = isWindows
    ? [...pathExts(options?.env ?? hostEnv).map((e) => command + e), command]
    : [command];
  search: for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (yield* isExecutableFile(fs, candidate)) {
        resolved = candidate;
        break search;
      }
    }
  }

  if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { resolvedPath: resolved, expiresAtNanos: now + CACHE_TTL_NANOS });

  return resolved ?? (yield* Effect.fail(notFound(command)));
});

export const isCommandAvailable = Effect.fn("shell.isCommandAvailable")(function* (
  name: string,
  lookup?: CommandAvailabilityOptions,
) {
  const outcome = yield* Effect.result(resolveCommandPath(name, lookup));
  if (outcome._tag === "Success") return true;
  if (outcome.failure._tag === "CommandResolutionError") return false;
  return yield* Effect.fail(outcome.failure);
});
