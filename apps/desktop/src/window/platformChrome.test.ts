import { assert, describe, it } from "@effect/vitest";
import type * as Electron from "electron";

import { fileManagerName, mainWindowChrome, shapeMenuForPlatform } from "./platformChrome.ts";

type MenuItem = Electron.MenuItemConstructorOptions;
const divider: MenuItem = { type: "separator" };
const settings: MenuItem = { label: "Settings..." };
const updates: MenuItem = { label: "Check for Updates…" };
const macTemplate: MenuItem[] = [
  {
    label: "Kora",
    submenu: [
      { role: "about" },
      updates,
      divider,
      settings,
      divider,
      { role: "services" },
      divider,
      ...(["hide", "hideOthers", "unhide"] as const).map((role) => ({ role })),
      divider,
      { role: "quit" },
    ],
  },
  { label: "File", submenu: [{ role: "close" }] },
  {
    label: "Edit",
    submenu: [
      { role: "copy" },
      divider,
      { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] },
    ],
  },
  { role: "windowMenu" },
  { role: "help", submenu: [{ label: "Report a Bug…" }, { label: "Show Logs in Finder" }] },
];

const labels = (items: unknown): string[] =>
  (items as MenuItem[]).map((i) => i.label ?? i.role ?? i.type ?? "?");

describe("mainWindowChrome", () => {
  it("keeps the inset title bar and centred traffic lights on macOS", () => {
    assert.deepEqual(mainWindowChrome("darwin", true), {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 19 },
    });
  });
  it("gives Windows a title bar overlay (native caption buttons) of the top bar's height", () => {
    const chrome = mainWindowChrome("win32", true);
    assert.equal(chrome.titleBarStyle, "hidden");
    assert.deepEqual(chrome.titleBarOverlay, {
      color: "#000000",
      symbolColor: "#f2f2f4",
      height: 52,
    });
    assert.isUndefined(chrome.trafficLightPosition);
    assert.equal(
      (mainWindowChrome("win32", false).titleBarOverlay as { color: string }).color,
      "#efeff1",
    );
  });
  it("leaves Linux on its native frame", () => {
    assert.deepEqual(mainWindowChrome("linux", true), {});
  });
});

describe("shapeMenuForPlatform", () => {
  it("returns the macOS template unchanged", () => {
    assert.deepEqual(shapeMenuForPlatform(macTemplate, "darwin"), macTemplate);
  });
  it("folds the app menu into File, drops macOS-only roles and names Explorer on Windows", () => {
    const menu = shapeMenuForPlatform(macTemplate, "win32");
    assert.deepEqual(labels(menu), ["File", "Edit", "windowMenu", "help"]);
    assert.deepEqual(labels(menu[0]!.submenu), [
      "Check for Updates…",
      "separator",
      "Settings...",
      "separator",
      "close",
      "quit",
    ]);
    assert.deepEqual(labels(menu[1]!.submenu), ["copy"]);
    assert.deepEqual(labels(menu[3]!.submenu), [
      "Report a Bug…",
      "Show Logs in File Explorer",
      "separator",
      "about",
    ]);
    const all = JSON.stringify(menu);
    for (const gone of ["services", "hideOthers", '"hide"', "unhide", "Speech", "Finder"])
      assert.notInclude(all, gone);
  });
  it("names the file manager per OS", () => {
    assert.equal(fileManagerName("darwin"), "Finder");
    assert.equal(fileManagerName("win32"), "File Explorer");
    assert.equal(fileManagerName("linux"), "File Manager");
  });
});
