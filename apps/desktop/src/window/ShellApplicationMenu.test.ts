import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { KORA_SOURCE_REPO_URL } from "@kora/shared/koraRelease";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import * as ShellUpdater from "../app/ShellUpdater.ts";
import * as NativeApp from "../native/NativeApp.ts";
import * as NativeDialog from "../native/NativeDialog.ts";
import * as NativeMenu from "../native/NativeMenu.ts";
import * as NativeShell from "../native/NativeShell.ts";
import { packagedContextLayer } from "../testing/contextLayer.ts";
import * as ShellApplicationMenu from "./ShellApplicationMenu.ts";
import * as ShellWindow from "./ShellWindow.ts";

type Item = Electron.MenuItemConstructorOptions;
const unused = (what: string) => Effect.die(`the menu should not ${what}`);

/**
 * Builds the application menu over fakes. Whatever a click does is reported to `heard` as a short string
 * ("open-settings", "zoom-in", "open:<url>", "check-for-updates"), so a test can click an item and read what happened.
 */
function buildMenu() {
  return Effect.gen(function* () {
    const heard = yield* Deferred.make<string>();
    const installed = yield* Deferred.make<readonly Item[]>();
    const say = (what: string) => Deferred.succeed(heard, what).pipe(Effect.asVoid);

    const fakes = Layer.mergeAll(
      Layer.succeed(NativeMenu.NativeMenu, {
        setApplicationMenu: (t) => Deferred.succeed(installed, t).pipe(Effect.asVoid),
        popupTemplate: () => Effect.void,
        showContextMenu: () => Effect.succeed(Option.none()),
      }),
      Layer.succeed(ShellWindow.ShellWindow, {
        sendMenuAction: (action) => say(action),
        zoomMain: (direction) => say(`zoom-${direction}`),
        syncAppearance: Effect.void,
        showStartupSplash: Effect.void,
        setSplashMessage: () => Effect.void,
        handleBackendReady: () => Effect.void,
        handleBackendNotReady: Effect.void,
        saveMainWindowPlace: Effect.void,
        activate: Effect.void,
        openMainWhenDaemonReady: Effect.void,
        revealOrCreateMain: unused("open a window"),
        ensureMain: unused("open a window"),
        createMain: unused("create a window"),
      }),
      Layer.succeed(NativeShell.NativeShell, {
        openExternal: (u) => say(`open:${String(u)}`).pipe(Effect.as(true)),
        copyText: () => Effect.void,
      }),
      Layer.succeed(ShellUpdater.ShellUpdater, {
        checkInteractively: say("check-for-updates"),
        state: unused("read update state"),
        ensureInstalledLocation: Effect.succeed(false),
        start: Effect.void,
        check: unused("check silently"),
        install: unused("install"),
        subscribe: () => Effect.void,
      }),
      Layer.succeed(NativeDialog.NativeDialog, {
        pickFolder: () => Effect.succeed(Option.none()),
        showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
        showErrorBox: () => Effect.void,
      }),
      Layer.succeed(NativeApp.NativeApp, {
        name: Effect.succeed("Kora"),
      } as unknown as NativeApp.NativeApp["Service"]),
      packagedContextLayer("/Users/sam", { isPackaged: false, appVersion: "0.1.14" }),
      NodeServices.layer,
    );
    yield* Effect.flatMap(ShellApplicationMenu.ShellApplicationMenu, (m) => m.configure).pipe(
      Effect.provide(ShellApplicationMenu.layer.pipe(Layer.provideMerge(fakes))),
    );
    const menu = yield* Deferred.await(installed);

    /** The submenu item at `path` (a top menu's label or role, then an item label). */
    const find = (top: string, label: string): Item => {
      const menuEntry = menu.find((m) => m.label === top || m.role === top);
      const items = Array.isArray(menuEntry?.submenu) ? (menuEntry.submenu as Item[]) : [];
      const item = items.find((i) => i.label === label);
      if (!item) throw new Error(`no "${label}" in ${top}`);
      return item;
    };
    const click = (top: string, label: string) =>
      Effect.suspend(() => {
        const onClick = find(top, label).click;
        if (typeof onClick !== "function") return Effect.die(`"${label}" is not clickable`);
        onClick({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
        return Deferred.await(heard);
      });
    return { menu, find, click };
  });
}

const everyItem = (items: readonly Item[]): Item[] =>
  items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? everyItem(i.submenu as Item[]) : [])]);

describe("the application menu", () => {
  it.effect.each([
    ["Kora", "Settings...", "open-settings"],
    ["Kora", "Check for Updates…", "check-for-updates"],
    ["Edit", "Paste as Text", "paste-as-text"],
    ["View", "Zoom In", "zoom-in"],
    ["View", "Actual Size", "zoom-reset"],
  ] as const)("%s › %s does its own thing (%s)", ([top, label, expected]) =>
    Effect.gen(function* () {
      const m = yield* buildMenu();
      assert.equal(yield* m.click(top, label), expected);
    }),
  );

  it.effect(
    "zoom is plain items, not Electron's zoom roles (those zoom whatever has focus, e.g. a preview)",
    () =>
      Effect.gen(function* () {
        const m = yield* buildMenu();
        const view = m.menu.find((x) => x.label === "View")?.submenu as Item[];
        assert.isTrue(
          view.every((i) => i.role === undefined),
          "no roles in View at all",
        );
      }),
  );

  it.effect("no item carries a keyboard accelerator (the renderer owns shortcuts)", () =>
    Effect.gen(function* () {
      const m = yield* buildMenu();
      const withShortcut = everyItem(m.menu).filter((i) => i.accelerator !== undefined);
      assert.deepEqual(
        withShortcut.map((i) => i.label ?? i.role),
        [],
      );
    }),
  );

  it.effect(
    "Help lists the guide, bug report, logs, this version's notes, and the source repository",
    () =>
      Effect.gen(function* () {
        const m = yield* buildMenu();
        const labels = (m.menu.find((x) => x.role === "help")?.submenu as Item[]).map(
          (i) => i.label,
        );
        for (const wanted of [
          "Getting Started",
          "Report a Bug…",
          "Show Logs in Finder",
          "Release Notes for 0.1.14",
          "Kora on GitHub",
        ]) {
          assert.include(labels, wanted);
        }
        assert.equal(yield* m.click("help", "Kora on GitHub"), `open:${KORA_SOURCE_REPO_URL}`);
      }),
  );
});
