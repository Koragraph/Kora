import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  launcherEnvScript,
  launcherShellScript,
  electronBinary,
  infoPlistStrings,
  codesignArgs,
  launcherIconPaths,
  launcherPaths,
  writeLauncherShellScript,
} from "./mac-launcher.mjs";

const scratch = [];
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true });
});

describe("environment script", () => {
  it("only offers captured values as fallbacks", () => {
    const text = launcherEnvScript({
      KORA_PORT: "8797",
      KORA_HOME: "/tmp/it's here",
      VITE_DEV_SERVER_URL: "   ",
      UNRELATED: "x",
    });
    expect(text).toContain(`if [ -z "\${KORA_PORT:-}" ]; then export KORA_PORT='8797'; fi`);
    expect(text).toContain("it'\\''s here");
    expect(text).not.toContain("UNRELATED");
    expect(text).not.toContain("VITE_DEV_SERVER_URL");
    expect(text).toContain("KORA_DESKTOP_APP_USER_MODEL_ID");
    expect(text.split("\n").some((line) => line.startsWith("export "))).toBe(false);
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("launcher script", () => {
  const make = () =>
    launcherShellScript({
      electronBin: "/bundle/Contents/MacOS/Electron",
      mainEntry: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      envFile: "/repo/apps/desktop/.electron-runtime/dev-environment.sh",
    });

  it("sources the env file then execs the bundled Electron", () => {
    const lines = make().split("\n");
    expect(lines[0]).toBe("#!/bin/sh");
    expect(lines[1]).toContain(". '/repo/apps/desktop/.electron-runtime/dev-environment.sh'");
    expect(lines[2]).toBe(
      `exec '/bundle/Contents/MacOS/Electron' --kora-dev-root='/repo/apps/desktop' '/repo/apps/desktop/dist-electron/main.cjs' "$@"`,
    );
  });

  it("keeps volatile values out of the script", () => {
    expect(make()).not.toContain("VITE_DEV_SERVER_URL");
  });

  it.skipIf(process.platform === "win32")(
    "restores the executable bit on an unchanged file and reports no rewrite",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "launcher-test-"));
      scratch.push(dir);
      const target = join(dir, "launcher");
      expect(writeLauncherShellScript(target, "/bundle/Electron")).toBe(true);
      chmodSync(target, 0o644);
      expect(writeLauncherShellScript(target, "/bundle/Electron")).toBe(false);
      expect(statSync(target).mode & 0o777).toBe(0o755);
      writeFileSync(target, "stale");
      expect(writeLauncherShellScript(target, "/bundle/Electron")).toBe(true);
    },
  );
});

describe("bundle metadata helpers", () => {
  it("names the launcher binary after the display name", () => {
    const paths = launcherPaths("/x/Kora.app", "Kora");
    expect(paths.launcherExecutableName).toBe("Kora Launcher");
    expect(paths.launcherBinaryPath).toBe("/x/Kora.app/Contents/MacOS/Kora Launcher");
    expect(paths.runtimeElectronBinaryPath).toBe("/x/Kora.app/Contents/MacOS/Electron");
  });

  it("carries the usage descriptions", () => {
    const strings = infoPlistStrings("Electron");
    expect(strings.CFBundleExecutable).toBe("Electron");
    expect(strings.CFBundleIconFile).toBe("icon.icns");
    expect(strings.NSScreenCaptureUsageDescription).toBe(
      "Kora captures the active window when you take a snapshot.",
    );
    expect(strings.NSDocumentsFolderUsageDescription).toBe(
      "Kora reads project files you open in the desktop app.",
    );
  });

  it.skipIf(process.platform === "win32")("picks icon sources by mode", () => {
    expect(launcherIconPaths("/rt", false).sourceIconPath).toMatch(
      /assets\/icons\/release\/mac-1024\.png$/,
    );
    expect(launcherIconPaths("/rt", true).sourceIconPath).toMatch(
      /assets\/icons\/checkout\/mac-1024\.png$/,
    );
    expect(launcherIconPaths("/rt", true).generatedIconPath).toBe("/rt/icon-dev.icns");
  });

  it("signs ad hoc without a timestamp", () => {
    expect(codesignArgs("/x/Kora.app")).toEqual([
      "--force",
      "--deep",
      "--sign",
      "-",
      "--timestamp=none",
      "/x/Kora.app",
    ]);
  });
});

describe("electronBinary", () => {
  it("repairs the runtime before requiring the package", () => {
    const calls = [];
    const result = electronBinary({
      ensureRuntime: () => calls.push("ensure"),
      createRequire: () => () => {
        calls.push("require");
        return "/path/to/Electron";
      },
      moduleUrl: "file:///unused.mjs",
    });
    expect(result).toBe("/path/to/Electron");
    expect(calls).toEqual(["ensure", "require"]);
  });
});
