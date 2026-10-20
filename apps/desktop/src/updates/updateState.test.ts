import { describe, expect, it } from "vite-plus/test";

import {
  applyUpdateEvent,
  describeUpdateError,
  describeUpdateStateForDialog,
  initialUpdateState,
} from "./updateState.ts";

const runtimeInfo = {
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
} as const;
const now = "2026-10-04T10:00:00.000Z";
const enabled = initialUpdateState({ currentVersion: "0.2.0", runtimeInfo, disabledReason: null });

describe("update state", () => {
  it("a build without a feed is disabled and says why", () => {
    const state = initialUpdateState({
      currentVersion: "0.2.0",
      runtimeInfo,
      disabledReason: "This is a local build: install Kora from its releases page to get updates.",
    });
    expect(state.enabled).toBe(false);
    expect(state.status).toBe("disabled");
    expect(applyUpdateEvent(state, { type: "available", version: "0.3.0" }, now)).toBe(state);
    expect(describeUpdateStateForDialog(state).detail).toMatch(/local build/);
  });

  it("check → available → progress → downloaded", () => {
    let state = applyUpdateEvent(enabled, { type: "checking" }, now);
    expect(state.status).toBe("checking");
    state = applyUpdateEvent(state, { type: "available", version: "0.3.0" }, now);
    expect(state).toMatchObject({
      status: "downloading",
      availableVersion: "0.3.0",
      downloadPercent: 0,
    });
    state = applyUpdateEvent(state, { type: "progress", percent: 41.6 }, now);
    expect(state.downloadPercent).toBe(42);
    // The zip is in and its checksum matches, but Squirrel hasn't checked the signature yet: not installable.
    state = applyUpdateEvent(state, { type: "fetched", version: "0.3.0" }, now);
    expect(state).toMatchObject({
      status: "downloading",
      downloadPercent: 100,
      downloadedVersion: null,
    });
    state = applyUpdateEvent(state, { type: "downloaded", version: null }, now);
    expect(state).toMatchObject({
      status: "downloaded",
      downloadedVersion: "0.3.0",
      downloadPercent: 100,
    });
    expect(describeUpdateStateForDialog(state).message).toBe("Kora 0.3.0 is ready to install");
  });

  it("an update Squirrel rejects ends in an error, never in Restart", () => {
    // The order seen live (Kora QA, ad-hoc signed): electron-updater's update-downloaded, then Squirrel's error.
    let state = applyUpdateEvent(enabled, { type: "available", version: "0.0.2" }, now);
    state = applyUpdateEvent(state, { type: "fetched", version: "0.0.2" }, now);
    state = applyUpdateEvent(
      state,
      {
        type: "error",
        message:
          "Code signature at URL file:///…/Kora%20QA.app/ did not pass validation: code failed to satisfy specified code requirement(s)",
      },
      now,
    );
    expect(state).toMatchObject({
      status: "error",
      errorContext: "download",
      downloadedVersion: null,
    });
    expect(state.message).toMatch(/code-signature check/);
  });

  it("a later check never hides a downloaded update, and a failed one doesn't either", () => {
    const downloaded = applyUpdateEvent(enabled, { type: "downloaded", version: "0.3.0" }, now);
    expect(downloaded.downloadedVersion).toBe("0.3.0");
    expect(applyUpdateEvent(downloaded, { type: "checking" }, now)).toBe(downloaded);
    expect(
      applyUpdateEvent(downloaded, { type: "error", message: "ENOTFOUND github.com" }, now),
    ).toBe(downloaded);
    expect(applyUpdateEvent(downloaded, { type: "not-available" }, now).status).toBe("downloaded");
  });

  it("errors carry their context and a readable message", () => {
    const downloading = applyUpdateEvent(enabled, { type: "available", version: "0.3.0" }, now);
    const failed = applyUpdateEvent(
      downloading,
      { type: "error", message: "net::ERR_INTERNET_DISCONNECTED\n    at …" },
      now,
    );
    expect(failed).toMatchObject({ status: "error", errorContext: "download", canRetry: true });
    expect(failed.message).toBe(
      "Couldn't reach GitHub to check for updates. Check your connection.",
    );
    const recovered = applyUpdateEvent(failed, { type: "not-available" }, now);
    expect(recovered).toMatchObject({ status: "up-to-date", message: null, errorContext: null });
  });

  it("a failed install keeps the downloaded update installable", () => {
    const downloaded = applyUpdateEvent(enabled, { type: "downloaded", version: "0.3.0" }, now);
    const state = applyUpdateEvent(downloaded, { type: "install-failed", message: "boom" }, now);
    expect(state).toMatchObject({ status: "downloaded", errorContext: "install", canRetry: true });
  });

  it("names the common Squirrel / electron-updater failures", () => {
    expect(describeUpdateError("Cannot update while running on a read-only volume.")).toMatch(
      /Applications folder/,
    );
    expect(
      describeUpdateError(
        "Code signature at URL file:///… did not pass validation: code failed to satisfy",
      ),
    ).toMatch(/code-signature check/);
    expect(describeUpdateError("Error: No published versions on GitHub")).toBe(
      "No published release was found.",
    );
    expect(describeUpdateError("HttpError: 403 Forbidden\n    at ...")).toMatch(/rate limit/i);
    expect(describeUpdateError("HttpError: 429 Too Many Requests\n    at ...")).toMatch(
      /rate limit/i,
    );
    expect(describeUpdateError("status code 429")).toMatch(/rate limit/i);
    expect(describeUpdateError("x".repeat(400))).toHaveLength(198);
  });

  it("handles paused updates and surfaces the message", () => {
    const paused = applyUpdateEvent(
      enabled,
      { type: "paused", message: "Updates are temporarily paused for maintenance." },
      now,
    );
    expect(paused).toMatchObject({
      status: "idle",
      message: "Updates are temporarily paused for maintenance.",
      canRetry: false,
    });
    const dialog = describeUpdateStateForDialog(paused);
    expect(dialog.message).toBe("Updates are paused");
    expect(dialog.detail).toBe("Updates are temporarily paused for maintenance.");

    // Does not override already downloaded update
    const downloaded = applyUpdateEvent(enabled, { type: "downloaded", version: "0.3.0" }, now);
    expect(applyUpdateEvent(downloaded, { type: "paused", message: "paused" }, now)).toBe(
      downloaded,
    );
  });
});
