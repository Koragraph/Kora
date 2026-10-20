import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

/** Which webContents has keyboard focus, and which window owns it. */
const focus = vi.hoisted(() => ({
  contents: null as { paste: () => void; isDestroyed: () => boolean } | null,
  owner: null as unknown,
}));
vi.mock("electron", () => ({
  webContents: { getFocusedWebContents: () => focus.contents },
  BrowserWindow: { fromWebContents: () => focus.owner },
}));

import * as ShellKoraDaemon from "../../backend/ShellKoraDaemon.ts";
import * as NativeWindow from "../../native/NativeWindow.ts";
import { getLocalHostBootstraps, getWindowFullscreenState, pasteAsText } from "./windowInfo.ts";

const withMain = (main: unknown) =>
  Layer.mock(NativeWindow.NativeWindow)({
    main: Effect.succeed(Option.some(main as Electron.BrowserWindow)),
    mainOrAnyWindow: Effect.succeed(Option.some(main as Electron.BrowserWindow)),
  });

it.effect(
  "the renderer is told about exactly one host: this Mac's daemon, with no token in it",
  () =>
    Effect.map(getLocalHostBootstraps.handler(), (hosts) =>
      assert.deepEqual(hosts, [
        {
          id: "primary",
          label: "Local environment",
          httpBaseUrl: "http://127.0.0.1:8797/",
          wsBaseUrl: "ws://127.0.0.1:8797/",
        },
      ]),
    ).pipe(
      Effect.provide(
        Layer.mock(ShellKoraDaemon.ShellKoraDaemon)({
          httpBaseUrl: new URL("http://127.0.0.1:8797/"),
        }),
      ),
    ),
);

it.effect("fullscreen is read from the window itself", () =>
  Effect.map(getWindowFullscreenState.handler(), (full) => assert.isTrue(full)).pipe(
    Effect.provide(withMain({ isFullScreen: () => true })),
  ),
);

describe("Edit › Paste as Text", () => {
  // The main renderer answers the menu item; the paste then goes to whatever inside the main window has focus
  // (a preview, say), and only there.
  const pasted: string[] = [];
  const target = (closed = false) => ({
    paste: () => void pasted.push("preview"),
    isDestroyed: () => closed,
  });
  const main = { webContents: { id: 42 }, isDestroyed: () => false };
  const fromMain = { sender: { id: 42 } };

  it.effect.each([
    ["the focused preview in the main window", (): void => {}, fromMain, ["preview"]],
    ["nothing when another renderer asks", (): void => {}, { sender: { id: 7 } }, []],
    ["nothing when focus is in another window", (): void => void (focus.owner = {}), fromMain, []],
    [
      "nothing when the focused contents have no window",
      (): void => void (focus.owner = null),
      fromMain,
      [],
    ],
    [
      "nothing when the focused contents closed",
      (): void => void (focus.contents = target(true)),
      fromMain,
      [],
    ],
    ["nothing when nothing has focus", (): void => void (focus.contents = null), fromMain, []],
  ] as const)("pastes into %s", ([, arrange, event, expected]) => {
    pasted.length = 0;
    focus.contents = target();
    focus.owner = main;
    arrange();
    return Effect.map(pasteAsText.handler(undefined, event), () =>
      assert.deepEqual(pasted, [...expected]),
    ).pipe(Effect.provide(withMain(main)));
  });
});
