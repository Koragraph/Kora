/**
 * The desktop app's self-update state and the "report a bug" action, for Settings → About, the sidebar's
 * "Restart to update" button and the update-ready toast. The browser build has no shell: the update UI stays
 * hidden there and bug reports open the issue form in a new tab.
 */
import { useEffect, useState } from "react";
import { bugReportUrl } from "@kora/shared/koraRelease";
import type { ShellUpdateState } from "@kora/contracts";

import { APP_VERSION } from "./branding";

/** Null without a desktop shell (browser build) or with a desktop build that predates updates. */
export function useShellUpdateState(): ShellUpdateState | null {
  const [state, setState] = useState<ShellUpdateState | null>(null);
  useEffect(() => {
    const updates = window.shellBridge?.updates;
    if (!updates) return;
    let engaged = true;
    const unsubscribe = updates.onState((upcoming) => {
      if (engaged) setState(upcoming);
    });
    updates.getState().then(
      // A state pushed while this request was in flight is newer: keep it.
      (initial) => engaged && setState((live) => live ?? initial),
      () => undefined,
    );
    return () => {
      engaged = false;
      unsubscribe();
    };
  }, []);
  return state;
}

export type UpdateAction = "check" | "restart" | null;

/** One line for Settings → About, and the button it offers. */
export function describeUpdateStatus(snap: ShellUpdateState): {
  readonly text: string;
  readonly action: UpdateAction;
  readonly busy: boolean;
} {
  switch (snap.status) {
    case "disabled":
      return {
        text: snap.message ?? "This build doesn't update itself.",
        action: null,
        busy: false,
      };
    case "idle":
      return { text: "Kora checks for updates automatically.", action: "check", busy: false };
    case "checking":
      return { text: "Checking for updates…", action: "check", busy: true };
    case "up-to-date":
      return { text: "You're on the latest version.", action: "check", busy: false };
    case "available":
    case "downloading": {
      const version = snap.availableVersion ? `Kora ${snap.availableVersion}` : "the update";
      const percent = snap.downloadPercent === null ? "" : ` · ${snap.downloadPercent}%`;
      return { text: `Downloading ${version}${percent}`, action: null, busy: true };
    }
    case "downloaded": {
      const what = snap.downloadedVersion ? `Kora ${snap.downloadedVersion}` : "The update";
      return {
        text: `${what} is ready. Restart to finish updating; running agents restart too.`,
        action: "restart",
        busy: false,
      };
    }
    case "error":
      return {
        text: snap.message ?? "The last update check failed.",
        action: snap.errorContext === "install" && snap.canRetry ? "restart" : "check",
        busy: false,
      };
  }
}

export function checkForUpdates(): Promise<unknown> {
  return window.shellBridge?.updates?.check() ?? Promise.resolve(null);
}

export function restartToUpdate(): Promise<unknown> {
  return window.shellBridge?.updates?.install() ?? Promise.resolve(null);
}

/** The desktop fills in macOS version and chip; the browser build can only say which Kora it is. */
export function reportBug(): void {
  const reportFromShell = window.shellBridge?.reportBug;
  if (reportFromShell) {
    void reportFromShell();
    return;
  }
  window.open(bugReportUrl({ appVersion: APP_VERSION }), "_blank", "noopener,noreferrer");
}
