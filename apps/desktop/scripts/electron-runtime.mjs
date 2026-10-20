// Makes sure the `electron` package has a usable macOS runtime in its dist/ folder.
// pnpm sometimes skips the package's postinstall download, which leaves a missing or truncated binary.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAC_EXECUTABLE = "Electron.app/Contents/MacOS/Electron";
const requireHere = createRequire(import.meta.url);

function runChecked(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`,
    );
  }
}

function looksLikeMachO(file) {
  const probe = spawnSync("file", ["-b", file], { encoding: "utf8" });
  return (probe.stdout ?? "").includes("Mach-O");
}

function inspect(distDir) {
  const mustExist = [
    join(distDir, MAC_EXECUTABLE),
    join(distDir, "Electron.app/Contents/Info.plist"),
    join(
      distDir,
      "Electron.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
    ),
  ];
  const missing = mustExist.filter((file) => !existsSync(file));
  const binaries = [mustExist[0], mustExist[2]];
  const invalid = binaries.filter((file) => existsSync(file) && !looksLikeMachO(file));
  return { missing, invalid };
}

function download(version, packageDir) {
  const scratch = mkdtempSync(join(tmpdir(), "kora-electron-"));
  try {
    const archive = join(scratch, "electron.zip");
    const url = `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-darwin-${process.arch}.zip`;
    runChecked("curl", ["-fsSL", "-o", archive, url]);
    runChecked("ditto", ["-x", "-k", archive, join(packageDir, "dist")]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function ensureElectronInstalled() {
  if (process.platform !== "darwin") {
    throw new Error(`Electron builds are not available on platform: ${process.platform}`);
  }
  const manifestPath = requireHere.resolve("electron/package.json");
  const packageDir = dirname(manifestPath);
  const version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
  const distDir = join(packageDir, "dist");

  let state = inspect(distDir);
  if (state.missing.length > 0 || state.invalid.length > 0) {
    rmSync(distDir, { recursive: true, force: true });
    rmSync(join(packageDir, "path.txt"), { force: true });
    download(version, packageDir);
    state = inspect(distDir);
    if (state.missing.length > 0 || state.invalid.length > 0) {
      const list = (items) => items.map((item) => `- ${item}`).join("\n");
      throw new Error(
        `Electron runtime is incomplete after install.\nMissing:\n${list(state.missing)}\nInvalid:\n${list(state.invalid)}`,
      );
    }
  }

  const executable = join(distDir, MAC_EXECUTABLE);
  chmodSync(executable, 0o755);
  const pathFile = join(packageDir, "path.txt");
  const current = existsSync(pathFile) ? readFileSync(pathFile, "utf8") : null;
  if (current !== MAC_EXECUTABLE) writeFileSync(pathFile, MAC_EXECUTABLE);
  return executable;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${ensureElectronInstalled()}\n`);
}
