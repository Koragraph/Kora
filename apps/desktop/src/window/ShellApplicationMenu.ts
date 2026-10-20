import type * as Electron from "electron";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import { KORA_SOURCE_REPO_URL, releaseNotesUrl } from "@kora/shared/koraRelease";

import * as ShellWindow from "./ShellWindow.ts";
import * as NativeShell from "../native/NativeShell.ts";
import * as NativeMenu from "../native/NativeMenu.ts";
import * as NativeApp from "../native/NativeApp.ts";
import * as ShellUpdater from "../app/ShellUpdater.ts";
import * as ShellTracing from "../app/ShellTracing.ts";
import * as ShellSupport from "../app/ShellSupport.ts";
import * as ShellContext from "../app/ShellContext.ts";
import { shapeMenuForPlatform } from "./platformChrome.ts";

const { logError } = ShellTracing.makeScopedLogger("desktop-menu");

export class ShellApplicationMenuActionError extends Schema.TaggedError<ShellApplicationMenuActionError>()(
  "ShellApplicationMenuActionError",
  { action: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class ShellApplicationMenu extends Context.Service<
  ShellApplicationMenu,
  { readonly configure: Effect.Effect<void> }
>()("@kora/desktop/window/ShellApplicationMenu") {}

type MenuItem = Electron.MenuItemConstructorOptions;
type ActionServices =
  | ShellWindow.ShellWindow
  | NativeShell.NativeShell
  | ShellContext.ShellContext
  | ShellUpdater.ShellUpdater
  | FileSystem.FileSystem;

const divider: MenuItem = { type: "separator" };

const make = Effect.gen(function* () {
  const application = yield* NativeApp.NativeApp;
  const nativeMenu = yield* NativeMenu.NativeMenu;
  const envVars = yield* ShellContext.ShellContext;
  const context1 = yield* Effect.context<ActionServices>();
  const runFork = Effect.runForkWith(context1);

  // Clicks are fire-and-forget: a failing action is logged and never reaches Electron.
  const actionName = <Err>(name: string, effect: Effect.Effect<unknown, Err, ActionServices>) => ({
    click: () => {
      runFork(
        effect.pipe(
          Effect.catchCause((reason) =>
            logError(new ShellApplicationMenuActionError({ action: name, cause: reason }).message),
          ),
          Effect.annotateLogs({ action: name }),
          Effect.withSpan("shell.menu.action"),
        ),
      );
    },
  });

  const menuAction = (caption: string, ident: string, reveal = true): MenuItem => ({
    label: caption,
    ...actionName(
      ident,
      Effect.flatMap(ShellWindow.ShellWindow, (w) => w.sendMenuAction(ident, { reveal })),
    ),
  });
  const zoomLevel = (caption: string, dir: ShellWindow.MainWindowZoomDirection): MenuItem => ({
    label: caption,
    ...actionName(
      `zoom-${dir}`,
      Effect.flatMap(ShellWindow.ShellWindow, (w) => w.zoomMain(dir)),
    ),
  });
  const withMainContents = (use: (inner: Electron.WebContents) => void) =>
    Effect.flatMap(ShellWindow.ShellWindow, (w) => w.ensureMain).pipe(
      Effect.flatMap((main) =>
        Effect.sync(() => {
          if (!main.isDestroyed()) use(main.webContents);
        }),
      ),
    );
  const external = (caption: string, address: string): MenuItem => ({
    label: caption,
    ...actionName(
      `open:${caption}`,
      Effect.flatMap(NativeShell.NativeShell, (sh) => sh.openExternal(address)),
    ),
  });
  const checkForUpdates: MenuItem = {
    label: "Check for Updates…",
    ...actionName(
      "check-for-updates",
      Effect.flatMap(ShellUpdater.ShellUpdater, (updater) => updater.checkInteractively),
    ),
  };

  /** Hide Kora, Hide Others, Show All. */
  const windowHiding = (["hide", "hideOthers", "unhide"] as const).map((role): MenuItem => ({
    role,
  }));

  const configure = Effect.gen(function* () {
    const appName = yield* application.name;
    const template: MenuItem[] = [
      {
        label: appName,
        submenu: [
          { role: "about" },
          checkForUpdates,
          divider,
          menuAction("Settings...", "open-settings"),
          divider,
          { role: "services" },
          divider,
          ...windowHiding,
          divider,
          { role: "quit" },
        ],
      },
      { label: "File", submenu: [{ role: "close" }] },
      {
        label: "Edit",
        submenu: [
          ...(["undo", "redo"] as const).map((role) => ({ role })),
          divider,
          ...(["cut", "copy", "paste"] as const).map((role) => ({ role })),
          menuAction("Paste as Text", "paste-as-text", false),
          { role: "delete" },
          divider,
          { role: "selectAll" },
          divider,
          {
            label: "Speech",
            submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
          },
        ],
      },
      {
        label: "View",
        // Plain items rather than zoom roles: a role zooms whichever view has focus, so with the embedded
        // preview focused the app UI would appear stuck.
        submenu: [
          {
            label: "Reload",
            ...actionName(
              "reload",
              withMainContents((inner) => inner.reload()),
            ),
          },
          {
            label: "Toggle Developer Tools",
            ...actionName(
              "toggle-devtools",
              withMainContents((inner) => inner.toggleDevTools()),
            ),
          },
          divider,
          zoomLevel("Actual Size", "reset"),
          zoomLevel("Zoom In", "in"),
          zoomLevel("Zoom Out", "out"),
        ],
      },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          external("Getting Started", `${KORA_SOURCE_REPO_URL}#readme`),
          { label: "Report a Bug…", ...actionName("report-bug", ShellSupport.reportBug) },
          { label: "Show Logs in Finder", ...actionName("reveal-logs", ShellSupport.revealLogs) },
          divider,
          external(`Release Notes for ${envVars.appVersion}`, releaseNotesUrl(envVars.appVersion)),
          external("Kora on GitHub", KORA_SOURCE_REPO_URL),
        ],
      },
    ];
    yield* nativeMenu.setApplicationMenu(shapeMenuForPlatform(template, envVars.platform));
  }).pipe(Effect.withSpan("shell.menu.configure"));

  return ShellApplicationMenu.of({ configure });
});

export const layer = Layer.effect(ShellApplicationMenu, make);
