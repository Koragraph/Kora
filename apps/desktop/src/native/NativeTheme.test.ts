import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

/** A nativeTheme double: `refuse` makes the next themeSource assignment throw. */
const theme = vi.hoisted(() => ({
  dark: false,
  source: "system",
  refuse: null as Error | null,
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  nativeTheme: Object.defineProperties(
    { on: theme.on, removeListener: theme.removeListener },
    {
      themeSource: {
        set(next: string) {
          if (theme.refuse) throw theme.refuse;
          theme.source = next;
        },
      },
      shouldUseDarkColors: { get: () => theme.dark },
    },
  ),
}));

import * as NativeTheme from "./NativeTheme.ts";

const withTheme = <A, E>(body: (t: NativeTheme.NativeTheme["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(NativeTheme.NativeTheme, body).pipe(Effect.provide(NativeTheme.layer));

beforeEach(() => {
  Object.assign(theme, { dark: false, source: "system", refuse: null });
  theme.on.mockClear();
  theme.removeListener.mockClear();
});

describe("NativeTheme", () => {
  it.effect("reads the OS appearance and sets the source", () =>
    withTheme((t) =>
      Effect.gen(function* () {
        theme.dark = true;
        assert.isTrue(yield* t.shouldUseDarkColors);
        yield* t.setSource("light");
        assert.equal(theme.source, "light");
      }),
    ),
  );

  it.effect("an update listener is removed when its scope closes", () =>
    withTheme((t) =>
      Effect.gen(function* () {
        const onChange = vi.fn();
        yield* Effect.scoped(t.onUpdated(onChange));
        assert.deepEqual(theme.on.mock.calls, [["updated", onChange]]);
        assert.deepEqual(theme.removeListener.mock.calls, [["updated", onChange]]);
      }),
    ),
  );

  it.effect("a refused source is a typed error naming the source, not the cause", () =>
    withTheme((t) =>
      Effect.gen(function* () {
        theme.refuse = new Error("themeSource rejected");
        const failure = yield* Effect.flip(t.setSource("dark"));
        assert.instanceOf(failure, NativeTheme.NativeThemeSetSourceError);
        assert.deepInclude(failure, { source: "dark", cause: theme.refuse });
        assert.include(failure.message, "dark");
        assert.notInclude(failure.message, "themeSource rejected");
      }),
    ),
  );
});
