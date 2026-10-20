// "Report a Bug…" and "Show Logs in Finder" (Help menu, Settings → About). The bug form lives on Kora's public issue
// tracker; its URL carries build facts only — version, build id, macOS version, chip.
import { bugReportUrl } from "@kora/shared/koraRelease";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as Electron from "electron";

import * as NativeShell from "../native/NativeShell.ts";
import * as ShellContext from "./ShellContext.ts";

/** The bundled runtime's build id (`<version>-<commit>-<utc stamp>`, written by package-app.sh), if any. */
const readBuildId = Effect.gen(function* () {
  const environment = yield* ShellContext.ShellContext;
  const fileSystem = yield* FileSystem.FileSystem;
  if (!environment.isPackaged) return null;
  const text = yield* fileSystem
    .readFileString(environment.path.join(environment.resourcesPath, "runtime", "BUILD_ID"))
    .pipe(Effect.orElseSucceed(() => ""));
  return text.trim() || null;
});

export const reportBug = Effect.gen(function* () {
  const environment = yield* ShellContext.ShellContext;
  const nativeShell = yield* NativeShell.NativeShell;
  const systemVersion = yield* Effect.sync(() => process.getSystemVersion());
  yield* nativeShell.openExternal(
    bugReportUrl({
      appVersion: environment.appVersion,
      build: yield* readBuildId,
      os: environment.platform === "darwin" ? `macOS ${systemVersion}` : systemVersion,
      arch: environment.runtimeInfo.appArch,
    }),
  );
}).pipe(Effect.withSpan("shell.support.reportBug"));

/** Opens Finder on the Kora home with the daemon's server.log selected (desktop logs are in userdata/logs). */
export const revealLogs = Effect.gen(function* () {
  const environment = yield* ShellContext.ShellContext;
  const serverLog = environment.path.join(environment.baseDir, "server.log");
  yield* Effect.sync(() => Electron.shell.showItemInFolder(serverLog));
}).pipe(Effect.withSpan("shell.support.revealLogs"));
