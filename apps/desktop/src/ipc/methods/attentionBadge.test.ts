import { it } from "@effect/vitest";
import { MachinePlatform } from "@kora/shared/hostMachine";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, vi } from "vite-plus/test";

/** A desktop to badge: what the dock and the taskbar show, and whether Kora has focus. */
const desktop = vi.hoisted(() => {
  const state = {
    focused: false,
    dock: [] as number[],
    taskbar: [] as Array<[picture: unknown, description: string]>,
    windowClosed: false,
    pictureBroken: false,
    dockBroken: false,
    pings: 0,
    appEvents: new Map<string, () => void>(),
  };
  const picture = { isEmpty: () => state.pictureBroken };
  const win = {
    isDestroyed: () => state.windowClosed,
    setOverlayIcon: (p: unknown, d: string) => void state.taskbar.push([p, d]),
    webContents: { send: () => void state.pings++ },
  };
  return { state, picture, win };
});
vi.mock("electron", () => ({
  app: {
    setBadgeCount: (n: number) => {
      if (desktop.state.dockBroken) throw new Error("no dock here");
      desktop.state.dock.push(n);
      return true;
    },
    on: (name: string, fn: () => void) => desktop.state.appEvents.set(name, fn),
    removeListener: (name: string) => desktop.state.appEvents.delete(name),
  },
  BrowserWindow: {
    getFocusedWindow: () => (desktop.state.focused ? desktop.win : null),
    getAllWindows: () => [desktop.win],
  },
  nativeImage: { createFromDataURL: () => desktop.picture },
}));

import * as NativeApp from "../../native/NativeApp.ts";
import * as ShellIpc from "../ShellIpc.ts";
import { installAttentionBadge, showAttentionBadge } from "./attentionBadge.ts";

const three = { count: 3, image: "data:image/png;base64,S29yYQ==" };
const none = { count: 0, image: null };

beforeEach(() => {
  const { appEvents } = desktop.state;
  appEvents.clear();
  Object.assign(desktop.state, {
    focused: false,
    dock: [],
    taskbar: [],
    windowClosed: false,
    pictureBroken: false,
    dockBroken: false,
    pings: 0,
    appEvents,
  });
});

describe("showing the count", () => {
  it.each(["darwin", "linux"] as const)(
    "%s: the number goes on the dock and comes off again",
    (os) => {
      showAttentionBadge(os, three);
      showAttentionBadge(os, none);
      expect(desktop.state.dock).toEqual([3, 0]);
      expect(desktop.state.taskbar).toEqual([]);
    },
  );

  it("win32: the picture is overlaid on the taskbar button with a spoken description", () => {
    showAttentionBadge("win32", three);
    showAttentionBadge("win32", none);
    expect(desktop.state.taskbar).toEqual([
      [desktop.picture, "3 threads with new notifications"],
      [null, ""],
    ]);
  });

  it("win32: a picture that did not decode clears the overlay; a closed window is skipped", () => {
    desktop.state.pictureBroken = true;
    showAttentionBadge("win32", three);
    desktop.state.windowClosed = true;
    showAttentionBadge("win32", three);
    expect(desktop.state.taskbar).toEqual([[null, "3 threads with new notifications"]]);
  });

  it.each(["darwin", "linux", "win32"] as const)("%s: nothing shows while Kora has focus", (os) => {
    desktop.state.focused = true;
    showAttentionBadge(os, three);
    expect([...desktop.state.dock, ...desktop.state.taskbar]).toEqual(
      os === "win32" ? [[null, ""]] : [0],
    );
  });

  it("a desktop without a badge API is not an error", () => {
    desktop.state.dockBroken = true;
    expect(() => showAttentionBadge("linux", three)).not.toThrow();
  });
});

it.effect(
  "over IPC: bad requests are refused, and focus, quit and shutdown all clear the badge",
  () => {
    const channels = new Map<string, ShellIpc.ShellIpcHandleListener>();
    const ask = (payload: unknown) =>
      Effect.promise(async () =>
        channels.get("shell:set-notification-badge")!({ sender: { id: 1 } }, payload),
      );
    const refused = (payload: unknown) =>
      Effect.promise(() =>
        Promise.resolve()
          .then(() => channels.get("shell:set-notification-badge")!({ sender: { id: 1 } }, payload))
          .then(
            () => false,
            () => true,
          ),
      );
    const ipc = ShellIpc.layer({
      handle: (channel, fn) => void channels.set(channel, fn),
      removeHandler: (channel) => void channels.delete(channel),
      on: () => undefined,
      removeAllListeners: () => undefined,
    });

    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* installAttentionBadge();
        const bad = [
          { ...three, count: -2 },
          { ...three, count: 1.5 },
          { ...three, count: Number.POSITIVE_INFINITY },
          { ...three, image: "https://example.com/badge.png" },
          { ...three, image: `data:image/png;base64,${"A".repeat(16_400)}` },
        ];
        for (const payload of bad)
          expect(yield* refused(payload), String(payload.count)).toBe(true);
        expect(desktop.state.dock).toEqual([]);

        yield* ask(three);
        desktop.state.appEvents.get("browser-window-focus")!();
        expect(desktop.state.dock).toEqual([3, 0]);
        expect(desktop.state.pings).toBe(1);

        // A count arriving while focused clears (and pings) instead; a zero just clears quietly.
        desktop.state.focused = true;
        yield* ask(three);
        yield* ask(none);
        expect(desktop.state.dock.slice(2)).toEqual([0, 0]);
        expect(desktop.state.pings).toBe(2);

        desktop.state.focused = false;
        yield* ask(three);
        desktop.state.appEvents.get("before-quit")!();
        expect(desktop.state.dock.slice(-2)).toEqual([3, 0]);
      }).pipe(Effect.scoped);

      expect(desktop.state.dock.at(-1)).toBe(0);
      expect([desktop.state.appEvents.size, channels.size]).toEqual([0, 0]);
    }).pipe(
      Effect.provideService(MachinePlatform, "linux"),
      Effect.provide([NativeApp.layer, ipc]),
    );
  },
);
