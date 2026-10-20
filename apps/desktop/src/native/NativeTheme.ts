import * as Electron from "electron";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import { ShellThemeSchema, type ShellTheme } from "@kora/contracts";

export class NativeThemeSetSourceError extends Schema.TaggedError<NativeThemeSetSourceError>()(
  "NativeThemeSetSourceError",
  {
    source: ShellThemeSchema,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to set the Electron theme source to ${this.source}.`;
  }
}

export class NativeTheme extends Context.Service<
  NativeTheme,
  {
    readonly shouldUseDarkColors: Effect.Effect<boolean>;
    readonly setSource: (palette: ShellTheme) => Effect.Effect<void, NativeThemeSetSourceError>;
    readonly onUpdated: (subscriber: () => void) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@kora/desktop/native/NativeTheme") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = NativeTheme.of({
  shouldUseDarkColors: Effect.sync(() => Electron.nativeTheme.shouldUseDarkColors),
  setSource: (palette) =>
    Effect.try({
      try: () => {
        Electron.nativeTheme.themeSource = palette;
      },
      catch: (reason) => new NativeThemeSetSourceError({ source: palette, cause: reason }),
    }),
  onUpdated: (subscriber) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        Electron.nativeTheme.on("updated", subscriber);
        return Effect.void;
      }),
      () =>
        Effect.suspend(() => {
          Electron.nativeTheme.removeListener("updated", subscriber);
          return Effect.void;
        }),
    ),
});

export const layer = Layer.succeed(NativeTheme, make);
