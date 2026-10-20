import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import { parseLenientJson } from "@kora/shared/lenientJson";
import { migrateLegacyHostKeysInJsonText } from "@kora/contracts";

import { readStateFileString } from "./legacyStateFiles.ts";
import * as ShellContext from "../app/ShellContext.ts";

/** Smallest window the app accepts; anything smaller in the file is ignored. */
const MIN_WIDTH = 840;
const MIN_HEIGHT = 620;

export const ShellWindowBoundsSchema = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_WIDTH)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_HEIGHT)),
});
export type ShellWindowBounds = typeof ShellWindowBoundsSchema.Type;

export const DEFAULT_MAIN_WINDOW_SIZE = { width: 1100, height: 780 } as const;

export interface ShellPrefs {
  readonly localHostEnabled: boolean;
  readonly mainWindowBounds: ShellWindowBounds | null;
  readonly mainWindowMaximized: boolean;
}

export interface ShellPrefsChange {
  readonly settings: ShellPrefs;
  readonly changed: boolean;
}

export const DEFAULT_SHELL_PREFS: ShellPrefs = {
  localHostEnabled: true,
  mainWindowBounds: null,
  mainWindowMaximized: false,
};

export class ShellPrefsWriteError extends Schema.TaggedError<ShellPrefsWriteError>()(
  "ShellPrefsWriteError",
  {
    cause: Schema.Defect(),
    path: Schema.String,
    operation: Schema.Literals([
      "replace-settings-file",
      "write-temporary-file",
      "create-directory",
      "encode-document",
      "create-temporary-file-name",
    ]),
  },
) {
  override get message() {
    return `Desktop settings write failed during ${this.operation} at ${this.path}.`;
  }
}

export class ShellAppPrefs extends Context.Service<
  ShellAppPrefs,
  {
    readonly load: Effect.Effect<ShellPrefs>;
    readonly get: Effect.Effect<ShellPrefs>;
    readonly setLocalHostEnabled: (
      on: boolean,
    ) => Effect.Effect<ShellPrefsChange, ShellPrefsWriteError>;
    readonly setMainWindowBounds: (
      edges: ShellWindowBounds,
      isMaximized: boolean,
    ) => Effect.Effect<ShellPrefsChange, ShellPrefsWriteError>;
  }
>()("@kora/desktop/prefs/ShellAppPrefs") {}

/** The version is accepted for symmetry with earlier builds; the defaults do not depend on it. */
export const resolveDefaultShellPrefs = (_appVersion: string): ShellPrefs => DEFAULT_SHELL_PREFS;

const decodeBounds = Schema.decodeUnknownOption(ShellWindowBoundsSchema);

export function normalizeMainWindowBounds(val: unknown): ShellWindowBounds | null {
  const decoded = decodeBounds(val);
  return decoded._tag === "Some" ? decoded.value : null;
}

const StoredDocument = Schema.Struct({
  localHostEnabled: Schema.optional(Schema.Boolean),
  mainWindowBounds: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        height: Schema.Number,
        width: Schema.Number,
        y: Schema.Number,
        x: Schema.Number,
      }),
    ),
  ),
  mainWindowMaximized: Schema.optional(Schema.Boolean),
});

const encodeDocument = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeStored = Schema.decodeUnknownOption(parseLenientJson(StoredDocument));

const sameBounds = (current: ShellWindowBounds | null, incoming: ShellWindowBounds | null) =>
  current === incoming ||
  (current !== null &&
    incoming !== null &&
    current.x === incoming.x &&
    current.y === incoming.y &&
    current.width === incoming.width &&
    current.height === incoming.height);

const sameSettings = (current: ShellPrefs, incoming: ShellPrefs) =>
  current.localHostEnabled === incoming.localHostEnabled &&
  current.mainWindowMaximized === incoming.mainWindowMaximized &&
  sameBounds(current.mainWindowBounds, incoming.mainWindowBounds);

// Only values that differ from the defaults reach the file.
const toDocument = (prefsObj: ShellPrefs) => ({
  ...(prefsObj.localHostEnabled === DEFAULT_SHELL_PREFS.localHostEnabled
    ? {}
    : { localHostEnabled: prefsObj.localHostEnabled }),
  ...(prefsObj.mainWindowBounds === null ? {} : { mainWindowBounds: prefsObj.mainWindowBounds }),
  ...(prefsObj.mainWindowMaximized ? { mainWindowMaximized: true } : {}),
});

const make = Effect.gen(function* () {
  const envVars = yield* ShellContext.ShellContext;
  const fsys = yield* FileSystem.FileSystem;
  const loc = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const filePath = envVars.desktopSettingsPath;
  const prefsRef = yield* SynchronizedRef.make<ShellPrefs>(envVars.defaultDesktopSettings);

  const writeFailure =
    (operation1: ShellPrefsWriteError["operation"], when: string) => (reason: unknown) =>
      new ShellPrefsWriteError({ operation: operation1, path: when, cause: reason });

  // Write beside the target, then rename over it, so a crash never leaves half a file.
  const persist = Effect.fn("shell.settings.writePrefs")(function* (prefsObj: ShellPrefs) {
    const tempName = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(writeFailure("create-temporary-file-name", filePath)),
    );
    const str = yield* encodeDocument(toDocument(prefsObj)).pipe(
      Effect.map((json) => `${json}\n`),
      Effect.mapError(writeFailure("encode-document", filePath)),
    );
    const temporary = `${filePath}.${process.pid}.${tempName.replaceAll("-", "")}.tmp`;
    yield* fsys
      .makeDirectory(loc.dirname(filePath), { recursive: true })
      .pipe(Effect.mapError(writeFailure("create-directory", loc.dirname(filePath))));
    yield* fsys
      .writeFileString(temporary, str)
      .pipe(Effect.mapError(writeFailure("write-temporary-file", temporary)));
    yield* fsys
      .rename(temporary, filePath)
      .pipe(Effect.mapError(writeFailure("replace-settings-file", filePath)));
  });

  const change = (
    upcoming: (live: ShellPrefs) => ShellPrefs,
  ): Effect.Effect<ShellPrefsChange, ShellPrefsWriteError> =>
    SynchronizedRef.modifyEffect(
      prefsRef,
      (live): Effect.Effect<[ShellPrefsChange, ShellPrefs], ShellPrefsWriteError> => {
        const cand = upcoming(live);
        if (sameSettings(live, cand)) {
          return Effect.succeed([{ settings: live, changed: false }, live]);
        }
        return persist(cand).pipe(
          Effect.as<[ShellPrefsChange, ShellPrefs]>([{ settings: cand, changed: true }, cand]),
        );
      },
    );

  const load = Effect.gen(function* () {
    const str = yield* readStateFileString(fsys, filePath).pipe(Effect.orElseSucceed(() => null));
    let loaded = envVars.defaultDesktopSettings;
    if (str !== null) {
      const stored = decodeStored(migrateLegacyHostKeysInJsonText(str));
      if (stored._tag === "Some") {
        const edges = normalizeMainWindowBounds(stored.value.mainWindowBounds);
        loaded = {
          localHostEnabled: stored.value.localHostEnabled !== false,
          mainWindowBounds: edges,
          mainWindowMaximized: edges !== null && stored.value.mainWindowMaximized === true,
        };
      }
    }
    yield* SynchronizedRef.set(prefsRef, loaded);
    return loaded;
  }).pipe(Effect.withSpan("shell.settings.load"));

  return ShellAppPrefs.of({
    load,
    get: SynchronizedRef.get(prefsRef),
    setLocalHostEnabled: (on) =>
      change((live) => ({ ...live, localHostEnabled: on })).pipe(
        Effect.withSpan("shell.settings.setLocalHostEnabled", { attributes: { enabled: on } }),
      ),
    setMainWindowBounds: (edges, isMaximized) =>
      change((live) => ({
        ...live,
        mainWindowBounds: edges,
        mainWindowMaximized: isMaximized,
      })).pipe(
        Effect.withSpan("shell.settings.setMainWindowBounds", {
          attributes: { ...edges, isMaximized },
        }),
      ),
  });
});

export const layer = Layer.effect(ShellAppPrefs, make);

/** In-memory prefs with the same change semantics and no file access. */
export const layerTest = (initialPrefs: ShellPrefs = DEFAULT_SHELL_PREFS) =>
  Layer.effect(
    ShellAppPrefs,
    Effect.gen(function* () {
      const prefsRef = yield* SynchronizedRef.make<ShellPrefs>(initialPrefs);
      const change = (upcoming: (live: ShellPrefs) => ShellPrefs) =>
        SynchronizedRef.modify(prefsRef, (live): [ShellPrefsChange, ShellPrefs] => {
          const cand = upcoming(live);
          return sameSettings(live, cand)
            ? [{ settings: live, changed: false }, live]
            : [{ settings: cand, changed: true }, cand];
        });
      return ShellAppPrefs.of({
        load: SynchronizedRef.get(prefsRef),
        get: SynchronizedRef.get(prefsRef),
        setLocalHostEnabled: (on) => change((live) => ({ ...live, localHostEnabled: on })),
        setMainWindowBounds: (edges, isMaximized) =>
          change((live) => ({
            ...live,
            mainWindowBounds: edges,
            mainWindowMaximized: isMaximized,
          })),
      });
    }),
  );
