// Starts Electron on macOS under the Kora name. In development the stock Electron.app is copied and re-branded
// (display name, bundle id, URL schemes, icon) so the Dock and menu bar say "Kora (Dev)" rather than "Electron".
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureElectronInstalled } from "./electron-runtime.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
export const desktopDir = join(scriptsDir, "..");
const repoRoot = join(desktopDir, "..", "..");

const isDevelopment = (process.env.VITE_DEV_SERVER_URL ?? "").trim() !== "";
const displayName = isDevelopment ? "Kora (Dev)" : "Kora";
const bundleSuffix =
  basename(repoRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "") || "local";
const bundleId = isDevelopment ? `com.koraplex.kora.dev.${bundleSuffix}` : "com.koraplex.kora";
const urlSchemes = isDevelopment ? ["kora-dev"] : ["kora"];
const LAUNCHER_VERSION = 19; // bump to invalidate every cached branded bundle
const runtimeDir = join(desktopDir, ".electron-runtime");
const devEnvFile = join(runtimeDir, "dev-environment.sh");
const metadataFile = join(runtimeDir, "metadata.json");
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

// Values captured from the shell that started the dev server. They are only fallbacks for the launcher.
const CAPTURED_ENV = [
  "VITE_DEV_SERVER_URL",
  "KORA_PORT",
  "KORA_HOME",
  "KORA_COMMIT_HASH",
  "KORA_OTLP_TRACES_URL",
  "KORA_OTLP_EXPORT_INTERVAL_MS",
  "KORA_OTLP_HEADERS",
  "KORA_OTLP_PROTOCOL",
];

const shQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function codesignArgs(appBundlePath) {
  return ["--force", "--deep", "--sign", "-", "--timestamp=none", appBundlePath];
}

export function launcherEnvScript(environment) {
  const wanted = [
    ...CAPTURED_ENV.map((name) => [name, environment[name]]),
    ["KORA_DESKTOP_APP_USER_MODEL_ID", bundleId],
  ];
  const lines = [];
  for (const [name, value] of wanted) {
    if (typeof value !== "string" || value.trim() === "") continue;
    lines.push(`if [ -z "\${${name}:-}" ]; then export ${name}=${shQuote(value)}; fi`);
  }
  return `${lines.join("\n")}\n`;
}

export function launcherShellScript({ electronBin, mainEntry, desktopRoot, envFile }) {
  return [
    "#!/bin/sh",
    `if [ -f ${shQuote(envFile)} ]; then . ${shQuote(envFile)}; fi`,
    `exec ${shQuote(electronBin)} --kora-dev-root=${shQuote(desktopRoot)} ${shQuote(mainEntry)} "$@"`,
    "",
  ].join("\n");
}

export function writeLauncherShellScript(launcherPath, electronBin) {
  const script = launcherShellScript({
    electronBin,
    mainEntry: join(desktopDir, "dist-electron", "main.cjs"),
    desktopRoot: desktopDir,
    envFile: devEnvFile,
  });
  const unchanged = existsSync(launcherPath) && readFileSync(launcherPath, "utf8") === script;
  if (!unchanged) writeFileSync(launcherPath, script);
  chmodSync(launcherPath, 0o755);
  return !unchanged;
}

export function launcherIconPaths(dir, development = isDevelopment) {
  return {
    sourceIconPath: join(
      repoRoot,
      `assets/icons/${development ? "checkout" : "release"}/mac-1024.png`,
    ),
    generatedIconPath: posix.join(dir, development ? "icon-dev.icns" : "icon-prod.icns"),
  };
}

export function infoPlistStrings(executableName) {
  return {
    CFBundleDisplayName: displayName,
    CFBundleName: displayName,
    CFBundleIdentifier: bundleId,
    CFBundleExecutable: executableName,
    CFBundleIconFile: "icon.icns",
    NSScreenCaptureUsageDescription: "Kora captures the active window when you take a snapshot.",
    NSDocumentsFolderUsageDescription: "Kora reads project files you open in the desktop app.",
  };
}

export function launcherPaths(appBundlePath, name = displayName) {
  const macosDir = posix.join(appBundlePath, "Contents", "MacOS");
  const launcherExecutableName = `${name} Launcher`;
  return {
    launcherExecutableName,
    launcherBinaryPath: posix.join(macosDir, launcherExecutableName),
    runtimeElectronBinaryPath: posix.join(macosDir, "Electron"),
  };
}

export function electronBinary({
  ensureRuntime = ensureElectronInstalled,
  createRequire: makeRequire = createRequire,
  moduleUrl = import.meta.url,
} = {}) {
  ensureRuntime();
  return makeRequire(moduleUrl)("electron");
}

function run(command, args, label = `${command} ${args.join(" ")}`) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `Failed to run ${label}: ${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()}`,
    );
  }
  return result.stdout ?? "";
}

function ensureIcns() {
  mkdirSync(runtimeDir, { recursive: true });
  const { sourceIconPath, generatedIconPath } = launcherIconPaths(runtimeDir);
  if (!existsSync(sourceIconPath))
    throw new Error(`Desktop macOS icon source is missing at ${sourceIconPath}`);
  if (
    existsSync(generatedIconPath) &&
    statSync(generatedIconPath).mtimeMs >= statSync(sourceIconPath).mtimeMs
  ) {
    return generatedIconPath;
  }
  const scratch = mkdtempSync(join(runtimeDir, "dev-iconset-"));
  try {
    const iconset = join(scratch, "icon.iconset");
    mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      run("sips", [
        "-z",
        String(size),
        String(size),
        sourceIconPath,
        "--out",
        join(iconset, `icon_${size}x${size}.png`),
      ]);
      run("sips", [
        "-z",
        String(size * 2),
        String(size * 2),
        sourceIconPath,
        "--out",
        join(iconset, `icon_${size}x${size}@2x.png`),
      ]);
    }
    run("iconutil", ["-c", "icns", iconset, "-o", generatedIconPath]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return generatedIconPath;
}

function setPlistValue(plistPath, key, value) {
  const replaced = spawnSync("plutil", ["-replace", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (replaced.status === 0) return;
  const inserted = spawnSync("plutil", ["-insert", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (inserted.status !== 0) {
    throw new Error(
      `Failed to update plist key "${key}" at ${plistPath}: ${(inserted.stderr ?? "").trim()}`,
    );
  }
}

function patchMainPlist(bundlePath, executableName) {
  const plist = join(bundlePath, "Contents", "Info.plist");
  for (const [key, value] of Object.entries(infoPlistStrings(executableName))) {
    setPlistValue(plist, key, value);
  }
  const urlTypes = JSON.stringify([{ CFBundleURLName: bundleId, CFBundleURLSchemes: urlSchemes }]);
  const written = spawnSync("plutil", ["-replace", "CFBundleURLTypes", "-json", urlTypes, plist], {
    encoding: "utf8",
  });
  if (written.status !== 0) {
    run("plutil", ["-insert", "CFBundleURLTypes", "-json", urlTypes, plist]);
  }
}

const HELPERS = [
  ["Electron Helper", "", ".helper"],
  ["Electron Helper (GPU)", " (GPU)", ".helper.gpu"],
  ["Electron Helper (Plugin)", " (Plugin)", ".helper.plugin"],
  ["Electron Helper (Renderer)", " (Renderer)", ".helper.renderer"],
];

function patchHelpers(bundlePath) {
  for (const [folder, suffix, idSuffix] of HELPERS) {
    const helperApp = join(bundlePath, "Contents", "Frameworks", `${folder}.app`);
    if (!existsSync(helperApp)) continue;
    const plist = join(helperApp, "Contents", "Info.plist");
    const name = `${displayName} Helper${suffix}`;
    setPlistValue(plist, "CFBundleDisplayName", name);
    setPlistValue(plist, "CFBundleName", name);
    setPlistValue(plist, "CFBundleIdentifier", `${bundleId}${idSuffix}`);
  }
}

function writeEnvFile() {
  writeFileSync(devEnvFile, launcherEnvScript(process.env));
}

function registerBundle(bundlePath) {
  run(LSREGISTER, ["-f", bundlePath]);
  if (!isDevelopment) return;
  for (const scheme of urlSchemes) {
    const script = `ObjC.import("CoreServices"); const s = $.LSSetDefaultHandlerForURLScheme($(${JSON.stringify(scheme)}), $(${JSON.stringify(bundleId)})); if (s !== 0) { throw new Error("status " + s); }`;
    run(
      "osascript",
      ["-l", "JavaScript", "-e", script],
      `LSSetDefaultHandlerForURLScheme(${scheme})`,
    );
  }
}

function signBundle(bundlePath) {
  run("codesign", codesignArgs(bundlePath));
}

function readMetadata() {
  try {
    return JSON.parse(readFileSync(metadataFile, "utf8"));
  } catch {
    return null;
  }
}

function buildMacLauncher(electronBin) {
  const sourceBundle = dirname(dirname(dirname(electronBin)));
  const targetBundle = join(runtimeDir, `${displayName}.app`);
  const { launcherBinaryPath, runtimeElectronBinaryPath } = launcherPaths(targetBundle);
  const entryPoint = isDevelopment ? launcherBinaryPath : runtimeElectronBinaryPath;

  const iconPath = ensureIcns();
  const expected = {
    launcherVersion: LAUNCHER_VERSION,
    sourceAppBundlePath: sourceBundle,
    sourceAppMtimeMs: statSync(sourceBundle).mtimeMs,
    iconMtimeMs: statSync(iconPath).mtimeMs,
    appBundleId: bundleId,
    appProtocolSchemes: urlSchemes,
  };

  const cached =
    existsSync(launcherBinaryPath) &&
    (!isDevelopment || existsSync(runtimeElectronBinaryPath)) &&
    JSON.stringify(readMetadata()) === JSON.stringify(expected);
  if (cached) {
    if (isDevelopment) {
      writeEnvFile();
      if (writeLauncherShellScript(launcherBinaryPath, runtimeElectronBinaryPath))
        signBundle(targetBundle);
    }
    registerBundle(targetBundle);
    return entryPoint;
  }

  rmSync(targetBundle, { recursive: true, force: true });
  // Symlinks must stay relative: rewriting them to absolute paths lets sandboxed helpers escape the bundle
  // and fail with "icudtl.dat not found".
  cpSync(sourceBundle, targetBundle, { recursive: true, verbatimSymlinks: true });
  patchMainPlist(targetBundle, isDevelopment ? `${displayName} Launcher` : "Electron");
  const resources = join(targetBundle, "Contents", "Resources");
  cpSync(iconPath, join(resources, "icon.icns"));
  cpSync(iconPath, join(resources, "electron.icns"));
  patchHelpers(targetBundle);
  if (isDevelopment) {
    writeEnvFile();
    writeLauncherShellScript(launcherBinaryPath, runtimeElectronBinaryPath);
  }
  signBundle(targetBundle);
  writeFileSync(metadataFile, `${JSON.stringify(expected, null, 2)}\n`);
  registerBundle(targetBundle);
  return entryPoint;
}

export function electronLaunchCommand(args = []) {
  if (process.platform !== "darwin") {
    throw new Error(`Kora desktop is macOS only (platform: ${process.platform})`);
  }
  return { electronPath: buildMacLauncher(electronBinary()), args };
}

export function devProtocolClient() {
  if (process.platform !== "darwin" || !isDevelopment) return null;
  const launcher = buildMacLauncher(electronBinary());
  return { appBundlePath: dirname(dirname(dirname(launcher))), appBundleId: bundleId };
}
