// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Early boot persistence before/outside Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as NativeApp from "../native/NativeApp.ts";
import * as NativeDialog from "../native/NativeDialog.ts";
import * as NativeShell from "../native/NativeShell.ts";
import * as ShellUpdater from "./ShellUpdater.ts";
import { releaseNotesUrl } from "@kora/shared/koraRelease";

export const CRASH_LOOP_WINDOW_MS = 2 * 60 * 1000; // ~2 minutes
export const CRASH_LOOP_THRESHOLD = 2; // 2+ consecutive failed launches
export const LAUNCH_RECORD_FILE = "launch-record.json";

export async function readLaunchTimestamps(filePath: string): Promise<readonly number[]> {
  try {
    const raw = await NodeFSP.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.timestamps)) {
      return parsed.timestamps.filter((t: unknown): t is number => typeof t === "number");
    }
    return [];
  } catch {
    return [];
  }
}

export function filterRecentTimestamps(
  timestamps: readonly number[],
  now: number = Date.now(),
  windowMs: number = CRASH_LOOP_WINDOW_MS,
): readonly number[] {
  return timestamps.filter((t) => now - t >= 0 && now - t <= windowMs);
}

export function shouldTriggerCrashLoop(
  recentTimestamps: readonly number[],
  threshold: number = CRASH_LOOP_THRESHOLD,
): boolean {
  return recentTimestamps.length >= threshold;
}

export async function recordLaunchAttempt(
  filePath: string,
  now: number = Date.now(),
  windowMs: number = CRASH_LOOP_WINDOW_MS,
): Promise<void> {
  const existing = await readLaunchTimestamps(filePath);
  const recent = filterRecentTimestamps(existing, now, windowMs);
  const updated = [...recent, now];
  try {
    await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
    await NodeFSP.writeFile(filePath, JSON.stringify({ timestamps: updated }), "utf-8");
  } catch {
    // best-effort persistence
  }
}

export async function clearLaunchRecord(filePath: string): Promise<void> {
  try {
    await NodeFSP.unlink(filePath);
  } catch {
    // ignored if file does not exist
  }
}

export const runCrashLoopRecovery = (userDataPath: string) =>
  Effect.gen(function* () {
    const dialog = yield* NativeDialog.NativeDialog;
    const application = yield* NativeApp.NativeApp;
    const nativeShell = yield* NativeShell.NativeShell;
    const updater = yield* ShellUpdater.ShellUpdater;

    const { response } = yield* dialog.showMessageBox({
      type: "error",
      title: "Kora",
      message: "Kora crashed on startup",
      detail:
        "The app failed to start several times in a row. You can check for an update, visit the releases page, or quit.",
      buttons: ["Check for update now", "Open download page", "Quit"],
      defaultId: 0,
      cancelId: 2,
    });

    if (response === 0) {
      // Check for update now: force an update check + download + install
      yield* updater.start;
      const checkResult = yield* updater.check;
      if (checkResult.state.status === "downloaded") {
        yield* updater.install;
        return;
      }
      if (checkResult.state.status === "error") {
        yield* dialog.showErrorBox(
          "Update failed",
          checkResult.state.message || "Failed to check for updates.",
        );
        yield* application.quit;
        return;
      }
      if (checkResult.state.status === "up-to-date") {
        yield* dialog.showMessageBox({
          type: "info",
          message: "You're up to date",
          detail: `Kora ${checkResult.state.currentVersion} is already the newest version.`,
          buttons: ["Quit"],
        });
        yield* application.quit;
        return;
      }

      // If downloading, wait up to 60s for download to complete
      let state = yield* updater.state;
      let waited = 0;
      while (state.status === "downloading" && waited < 60) {
        yield* Effect.sleep(Duration.seconds(1));
        waited += 1;
        state = yield* updater.state;
      }
      if (state.status === "downloaded") {
        yield* updater.install;
        return;
      }
      yield* dialog.showErrorBox(
        "Update could not complete",
        state.message || "The update did not complete. Please visit the releases page.",
      );
      yield* application.quit;
    } else if (response === 1) {
      // Open download page
      yield* nativeShell.openExternal(releaseNotesUrl(null));
      yield* application.quit;
    } else {
      // Quit
      yield* application.quit;
    }
  });
