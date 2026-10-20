// The update state the renderer sees (ShellUpdateState), as a pure reducer over electron-updater's events.
import type { ShellRuntimeInfo, ShellUpdateState } from "@kora/contracts";

export interface UpdateStateInit {
  readonly currentVersion: string;
  readonly runtimeInfo: ShellRuntimeInfo;
  /** Null when this build updates itself; otherwise why it doesn't (shown in Settings and the menu dialog). */
  readonly disabledReason: string | null;
}

export type UpdateEvent =
  | { readonly type: "checking" }
  | { readonly type: "available"; readonly version: string }
  | { readonly type: "not-available" }
  | { readonly type: "progress"; readonly percent: number }
  /** electron-updater has the zip and its checksum matches; Squirrel still has to accept the signature. */
  | { readonly type: "fetched"; readonly version: string }
  /** Squirrel accepted and staged it: quitting (or Restart) installs it. */
  | { readonly type: "downloaded"; readonly version: string | null }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "install-failed"; readonly message: string }
  | { readonly type: "paused"; readonly message: string };

export function initialUpdateState(init: UpdateStateInit): ShellUpdateState {
  const on = init.disabledReason === null;
  return {
    canRetry: false,
    errorContext: null,
    message: init.disabledReason,
    checkedAt: null,
    downloadPercent: null,
    omittedReleaseCount: 0,
    releaseNotes: [],
    downloadedVersion: null,
    availableVersion: null,
    runningUnderArm64Translation: init.runtimeInfo.runningUnderArm64Translation,
    appArch: init.runtimeInfo.appArch,
    hostArch: init.runtimeInfo.hostArch,
    currentVersion: init.currentVersion,
    channel: "latest",
    status: on ? "idle" : "disabled",
    enabled: on,
  };
}

const cleared = { message: null, errorContext: null, canRetry: false } as const;

export function applyUpdateEvent(
  snap: ShellUpdateState,
  evt: UpdateEvent,
  clock: string,
): ShellUpdateState {
  if (!snap.enabled) return snap;
  switch (evt.type) {
    case "checking":
      // A later check never hides an update that is downloading or ready to install.
      if (snap.status === "downloading" || snap.status === "downloaded") return snap;
      return { ...snap, ...cleared, status: "checking" };
    case "available":
      // autoDownload is on: an available update starts downloading at once.
      return {
        ...snap,
        ...cleared,
        status: "downloading",
        availableVersion: evt.version,
        downloadPercent: 0,
        checkedAt: clock,
      };
    case "not-available":
      if (snap.status === "downloaded") return { ...snap, checkedAt: clock };
      return {
        ...snap,
        ...cleared,
        status: "up-to-date",
        availableVersion: null,
        downloadPercent: null,
        checkedAt: clock,
      };
    case "progress":
      if (snap.status !== "downloading") return snap;
      return { ...snap, downloadPercent: Math.max(0, Math.min(100, Math.round(evt.percent))) };
    case "fetched":
      return {
        ...snap,
        ...cleared,
        status: "downloading",
        availableVersion: evt.version || snap.availableVersion,
        downloadPercent: 100,
      };
    case "downloaded": {
      const version = evt.version || snap.availableVersion;
      return {
        ...snap,
        ...cleared,
        downloadPercent: 100,
        downloadedVersion: version,
        availableVersion: version,
        status: "downloaded",
      };
    }
    case "error":
      // A failed re-check does not take away an update that is already downloaded.
      if (snap.status === "downloaded") return snap;
      return {
        ...snap,
        status: "error",
        downloadPercent: null,
        checkedAt: clock,
        message: describeUpdateError(evt.message),
        errorContext: snap.status === "downloading" ? "download" : "check",
        canRetry: true,
      };
    case "install-failed":
      return {
        ...snap,
        status: snap.downloadedVersion === null ? "error" : "downloaded",
        message: describeUpdateError(evt.message),
        errorContext: "install",
        canRetry: snap.downloadedVersion !== null,
      };
    case "paused":
      if (snap.status === "downloaded") return snap;
      return {
        ...snap,
        status: "idle",
        message: evt.message,
        checkedAt: clock,
        downloadPercent: null,
        errorContext: null,
        canRetry: false,
      };
  }
}

export function isRateLimitError(unparsed: string): boolean {
  return /HttpError: (?:403|429)|status code (?:403|429)|API rate limit|rate limit exceeded/i.test(
    unparsed,
  );
}

/** One readable sentence for an electron-updater / Squirrel error (their messages are stack-like and long). */
export function describeUpdateError(unparsed: string): string {
  const msg = unparsed.trim();
  if (isRateLimitError(msg)) {
    return "GitHub rate limit reached. Checking for updates will retry later.";
  }
  if (/read-only volume|AppTranslocation|cannot update while running/i.test(msg)) {
    return "Move Kora to the Applications folder to get updates.";
  }
  if (/code signature|did not pass validation|code failed to satisfy/i.test(msg)) {
    return "The downloaded update failed the code-signature check and was not installed.";
  }
  if (/No published versions|latest-mac\.yml|HttpError: 404|status code 404/i.test(msg)) {
    return "No published release was found.";
  }
  if (
    /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION/i.test(
      msg,
    )
  ) {
    return "Couldn't reach GitHub to check for updates. Check your connection.";
  }
  const firstLine = msg.split("\n")[0] ?? "";
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine || "The update failed.";
}

/** The menu dialog's sentence for a state, after a check the user asked for. */
export function describeUpdateStateForDialog(snap: ShellUpdateState): {
  readonly message: string;
  readonly detail: string;
} {
  switch (snap.status) {
    case "disabled":
      return { message: "Updates are off in this build", detail: snap.message ?? "" };
    case "up-to-date":
    case "idle":
      return {
        message: snap.message ? "Updates are paused" : "You're up to date",
        detail: snap.message ?? `Kora ${snap.currentVersion} is the newest version.`,
      };
    case "checking":
      return { message: "Checking for updates…", detail: "" };
    case "available":
    case "downloading":
      return {
        message: snap.availableVersion
          ? `Downloading Kora ${snap.availableVersion}`
          : "Downloading an update",
        detail: "It installs the next time Kora restarts. You can keep working.",
      };
    case "downloaded":
      return {
        message: snap.downloadedVersion
          ? `Kora ${snap.downloadedVersion} is ready to install`
          : "An update is ready to install",
        detail: "Restart Kora to finish updating. Running agents are restarted with it.",
      };
    case "error":
      return { message: "Couldn't update Kora", detail: snap.message ?? "" };
  }
}
