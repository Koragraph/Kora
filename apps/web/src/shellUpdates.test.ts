import { describeUpdateStatus } from "./shellUpdates";
import { describe, expect, it } from "vite-plus/test";
import { bugReportUrl } from "@kora/shared/koraRelease";
import type { ShellUpdateState } from "@kora/contracts";

const base: ShellUpdateState = {
  canRetry: false,
  errorContext: null,
  message: null,
  checkedAt: null,
  downloadPercent: null,
  omittedReleaseCount: 0,
  releaseNotes: [],
  downloadedVersion: null,
  availableVersion: null,
  runningUnderArm64Translation: false,
  appArch: "arm64",
  hostArch: "arm64",
  currentVersion: "0.2.0",
  channel: "latest",
  status: "idle",
  enabled: true,
};

describe("bugReportUrl", () => {
  it("leaves out what it doesn't know", () => {
    const url = new URL(bugReportUrl({ appVersion: "0.2.0" }));
    expect(url.searchParams.get("version")).toBe("0.2.0");
    expect(url.searchParams.has("macos")).toBe(false);
  });
  it("prefills the bug form with build facts only", () => {
    const url = new URL(
      bugReportUrl({
        arch: "arm64",
        os: "macOS 26.0",
        build: "0.2.0-abc1234-20261004100000",
        appVersion: "0.2.0",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://github.com/Koragraph/Kora/issues/new");
    expect(url.searchParams.get("template")).toBe("bug_report.yml");
    expect(url.searchParams.get("version")).toBe("0.2.0 (0.2.0-abc1234-20261004100000)");
    expect(url.searchParams.get("macos")).toBe("macOS 26.0, arm64");
  });
});

describe("describeUpdateStatus", () => {
  it("offers a retry after a failed check", () => {
    expect(
      describeUpdateStatus({
        ...base,
        status: "error",
        message: "Couldn't reach GitHub to check for updates. Check your connection.",
        errorContext: "check",
        canRetry: true,
      }),
    ).toMatchObject({ action: "check", busy: false });
  });

  it("offers a restart once downloaded", () => {
    const status = describeUpdateStatus({
      ...base,
      status: "downloaded",
      downloadedVersion: "0.3.0",
    });
    expect(status.action).toBe("restart");
    expect(status.text).toMatch(/^Kora 0\.3\.0 is ready\./);
  });

  it("shows download progress without a button", () => {
    expect(
      describeUpdateStatus({
        ...base,
        status: "downloading",
        availableVersion: "0.3.0",
        downloadPercent: 42,
      }),
    ).toEqual({ text: "Downloading Kora 0.3.0 · 42%", action: null, busy: true });
  });
  it("a local build explains itself and offers no button", () => {
    const status = describeUpdateStatus({
      ...base,
      enabled: false,
      status: "disabled",
      message: "This is a local build: it updates by reinstalling (pnpm app:install).",
    });
    expect(status).toEqual({
      busy: false,
      action: null,
      text: "This is a local build: it updates by reinstalling (pnpm app:install).",
    });
  });
});
