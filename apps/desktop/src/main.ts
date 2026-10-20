// Electron main-process entry. It assembles every service layer and runs ShellApp.program.

// A launcher that closes our stdout/stderr (a terminal that went away) must not take the app down.
const rethrowUnlessBrokenPipe = (failure: NodeJS.ErrnoException): void => {
  if (failure.code === "EPIPE") return;
  throw failure;
};
process.stdout.on("error", rethrowUnlessBrokenPipe);
process.stderr.on("error", rethrowUnlessBrokenPipe);

// A "Kora Dev" bundle's flavor.env has to be in process.env before anything reads configuration.
import "./app/ShellFlavor.ts";
import { enforceAppleSiliconGuard } from "./app/IntelGuard.ts";

if (!enforceAppleSiliconGuard()) {
  process.exit(0);
}

import * as NodeOS from "node:os";
import * as Electron from "electron";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { MachineArchitecture, MachinePlatform } from "@kora/shared/hostMachine";
import * as Net from "@kora/shared/netService";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";

import * as ShellWindow from "./window/ShellWindow.ts";
import * as ShellApplicationMenu from "./window/ShellApplicationMenu.ts";
import * as WebPartitions from "./web/WebPartitions.ts";
import * as WebManager from "./web/Manager.ts";
import * as LoginEnv from "./shell/LoginEnv.ts";
import * as ShellClientPrefs from "./prefs/ShellClientPrefs.ts";
import * as ShellAppPrefs from "./prefs/ShellAppPrefs.ts";
import * as NativeWindow from "./native/NativeWindow.ts";
import * as NativeUpdater from "./native/NativeUpdater.ts";
import * as NativeTheme from "./native/NativeTheme.ts";
import * as NativeShell from "./native/NativeShell.ts";
import * as NativeProtocol from "./native/NativeProtocol.ts";
import * as NativeMenu from "./native/NativeMenu.ts";
import * as NativeDialog from "./native/NativeDialog.ts";
import * as NativeApp from "./native/NativeApp.ts";
import * as ShellIpc from "./ipc/ShellIpc.ts";
import * as ShellKoraDaemon from "./backend/ShellKoraDaemon.ts";
import * as ShellUpdater from "./app/ShellUpdater.ts";
import * as ShellTracing from "./app/ShellTracing.ts";
import * as ShellState from "./app/ShellState.ts";
import * as ShellShutdown from "./app/ShellShutdown.ts";
import * as ShellPreReadyPlatform from "./app/ShellPreReadyPlatform.ts";
import * as ShellLifecycle from "./app/ShellLifecycle.ts";
import * as ShellLaunch from "./app/ShellLaunch.ts";
import * as ShellContext from "./app/ShellContext.ts";
import * as ShellAssets from "./app/ShellAssets.ts";
import * as ShellAppIdentity from "./app/ShellAppIdentity.ts";
import * as ShellApp from "./app/ShellApp.ts";

// What Electron knows about this process, turned into the ShellContext every other service reads.
const shellContextLayer = Layer.unwrap(
  Effect.gen(function* () {
    const metadata = yield* (yield* NativeApp.NativeApp).metadata;
    return ShellContext.layer({
      dirname: __dirname,
      homeDirectory: NodeOS.homedir(),
      platform: yield* MachinePlatform,
      processArch: yield* MachineArchitecture,
      ...metadata,
    });
  }),
).pipe(Layer.provide(NativeApp.layer));

// Native wrappers. Only the app's own renderer frame may call the IPC surface.
const nativeLayer = Layer.mergeAll(
  NativeApp.layer,
  NativeDialog.layer,
  NativeMenu.layer,
  NativeProtocol.layer,
  NativeShell.layer,
  NativeTheme.layer,
  NativeUpdater.layer,
  NativeWindow.layer,
  ShellIpc.layer(Electron.ipcMain as unknown as ShellIpc.ShellIpcMain, ShellIpc.isShellAppFrame),
);

const shellFoundationLayer = Layer.mergeAll(
  ShellState.layer,
  ShellShutdown.layer,
  ShellAppPrefs.layer,
  ShellClientPrefs.layer,
  ShellAssets.layer,
  ShellTracing.layer,
).pipe(Layer.provideMerge(shellContextLayer));

const shellWebLayer = WebManager.layer.pipe(
  Layer.provideMerge(WebPartitions.layer),
  Layer.provideMerge(shellFoundationLayer),
);
const shellWindowLayer = ShellWindow.layer.pipe(Layer.provideMerge(shellWebLayer));
const shellLaunchLayer = ShellLaunch.layer.pipe(Layer.provide(shellWindowLayer));
// The daemon is a separate long-lived process; the desktop only makes sure it runs and attaches to it.
const shellDaemonLayer = ShellKoraDaemon.layer.pipe(Layer.provideMerge(shellWindowLayer));

const shellApplicationLayer = Layer.mergeAll(
  ShellLifecycle.layer,
  shellLaunchLayer,
  ShellApplicationMenu.layer,
  LoginEnv.layer,
).pipe(
  Layer.provideMerge(ShellAppIdentity.layer),
  Layer.provideMerge(ShellUpdater.layer),
  Layer.provideMerge(shellDaemonLayer),
);

// Built outermost-first, so the pre-ready platform setup (URL scheme privileges) runs before Electron says `ready`.
const shellRuntimeLayer = shellApplicationLayer.pipe(
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(Net.layer),
  Layer.provideMerge(nativeLayer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ShellPreReadyPlatform.layer),
);

NodeRuntime.runMain(Effect.provide(ShellApp.program, shellRuntimeLayer));
