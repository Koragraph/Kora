#!/usr/bin/env node
// package-win.mjs: build the Windows installer (dist/win/Kora-Setup-<version>.exe, NSIS) from this checkout's build.
// The Windows counterpart of package-app.sh, with the same layout under the install folder's resources\:
//
//   resources\app\                the desktop main/preload bundles (dist-electron) + package.json
//   resources\web\                the built web client, served over kora://app
//   resources\runtime\            the kora runtime: bin\kora.js, dist\, ui\, koragraph\, production node_modules and
//                                 bin\node.exe, the pinned Node the native modules were installed for
//   resources\kora-runtime.cjs    syncs runtime\ to %USERPROFILE%\.kora\app and starts the daemon (run on every launch)
//
// Usage (on Windows; the Windows CI job runs it):
//   node scripts/package-win.mjs [--no-build] [--flavor dev|qa] [--version <x.y.z>] [--dir]
//                                [--update-feed github:<owner>/<repo>|generic:<https url>]
//     --dir          stop at the unpacked folder (dist/win/win-unpacked), no installer
//     --update-feed  writes resources\app-update.yml (turns on self-update, ShellUpdater.ts) and the feed file
//                    dist/win/latest.yml beside the installer; only release builds pass it (the Release workflow)
// Authenticode signing happens when its secrets are in the environment (scripts/lib/win-release.mjs names them);
// without them the installer is unsigned and SmartScreen warns on first run.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  updateFeedFiles,
  updateFeedRefusal,
  updatePublishConfig,
  winSigning,
} from "./lib/win-release.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "apps", "desktop");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const say = (m) => console.log(`\x1b[1mkora\x1b[0m ${m}`);
const die = (m) => {
  console.error(m);
  process.exit(1);
};

if (process.platform !== "win32")
  die(
    "package-win.mjs builds the Windows installer and must run on Windows (the Windows CI job does)",
  );
const FLAVOR = opt("--flavor") ?? "";
const FLAVORS = {
  "": { name: "Kora", appId: "com.koraplex.kora", scheme: "kora" },
  dev: {
    name: "Kora Dev",
    appId: "com.koraplex.kora.devapp",
    scheme: "kora-dev",
    env: 'KORA_APP_FLAVOR=dev\nKORA_APP_NAME="Kora Dev"\nKORA_HOME_NAME=.kora-dev\nKORA_PORT=8790\nKORA_CLI_NAME=kora-dev\nKORA_BLOBS_ROOT="$HOME/Blobs-Dev"\n',
  },
  qa: {
    name: "Kora QA",
    appId: "com.koraplex.kora.qa",
    scheme: "kora-qa",
    env: 'KORA_APP_FLAVOR=qa\nKORA_APP_NAME="Kora QA"\nKORA_HOME_NAME=.kora-qa\nKORA_PORT=8791\nKORA_CLI_NAME=kora-qa\nKORA_BLOBS_ROOT="$HOME/Blobs-QA"\n',
  },
};
const F = FLAVORS[FLAVOR] ?? die(`unknown flavor ${FLAVOR} (dev, qa)`);
let PUBLISH, SIGNING;
try {
  PUBLISH = updatePublishConfig(opt("--update-feed"));
  SIGNING = winSigning(process.env);
} catch (e) {
  die(e.message);
}
// Kora Dev / QA update by reinstalling, as on macOS: a feed in them would pull the public release over the flavor.
if (PUBLISH && FLAVOR) die("--update-feed is for release builds only (no --flavor)");
{
  const why = updateFeedRefusal(PUBLISH, SIGNING);
  if (why) die(why);
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    shell: process.platform === "win32" && /^(pnpm|npx)$/.test(cmd),
    ...opts,
  });
  if (r.status !== 0) die(`${cmd} ${cmdArgs.join(" ")} failed (${r.status ?? r.error?.message})`);
  return r;
}

// Node must satisfy the workspace engines range: it is what pnpm built the native modules with, and what ships.
const want = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).engines.node;
const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(want);
const [maj, min, pat] = process.versions.node.split(".").map(Number);
if (m && !(maj === +m[1] && (min > +m[2] || (min === +m[2] && pat >= +m[3]))))
  die(`node ${process.versions.node} does not satisfy engines ${want}`);

if (!flag("--no-build")) run("bash", [path.join(ROOT, "scripts", "build.sh")]);
for (const f of [
  "apps/desktop/dist-electron/main.cjs",
  "apps/desktop/dist-electron/preload.cjs",
  "apps/web/dist/index.html",
  "packages/runtime/dist/cli/main.js",
  "packages/runtime/ui/ui-server.cjs",
]) {
  if (!fs.existsSync(path.join(ROOT, f))) die(`missing ${f}: run pnpm build`);
}

const VERSION =
  opt("--version") ??
  JSON.parse(fs.readFileSync(path.join(ROOT, "packages/runtime/package.json"), "utf8")).version;
const git = (a) => spawnSync("git", ["-C", ROOT, ...a], { encoding: "utf8" }).stdout?.trim() ?? "";
const COMMIT = git(["rev-parse", "--short", "HEAD"]) || "unknown";
const DIRTY = git(["status", "--porcelain"]) ? "-dirty" : "";
const BUILD_ID = `${VERSION}-${COMMIT}${DIRTY}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
const OUT = path.join(ROOT, "dist", "win");
const STAGE = fs.mkdtempSync(path.join(os.tmpdir(), "kora-package-win-"));
process.on("exit", () => {
  try {
    fs.rmSync(STAGE, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
const noMaps = (src) => !src.endsWith(".map");

// ── 1. desktop app + web client ─────────────────────────────────────────────────────────────────
say("staging the desktop bundles and the web client");
const APP = path.join(STAGE, "app");
fs.cpSync(path.join(DESKTOP, "dist-electron"), path.join(APP, "dist-electron"), {
  recursive: true,
  filter: noMaps,
});
fs.writeFileSync(
  path.join(APP, "package.json"),
  JSON.stringify(
    {
      name: "kora",
      productName: F.name,
      version: VERSION,
      private: true,
      description: F.name,
      author: "Koragraph",
      main: "dist-electron/main.cjs",
      koraCommitHash: COMMIT,
    },
    null,
    2,
  ) + "\n",
);
const WEB = path.join(STAGE, "web");
fs.cpSync(path.join(ROOT, "apps", "web", "dist"), WEB, { recursive: true, filter: noMaps });

// ── 2. kora runtime + node.exe ──────────────────────────────────────────────────────────────────
say("deploying the kora runtime (production node_modules)");
// `pnpm deploy --prod` flips the workspace state file to production (see package-app.sh): keep it as it was.
const WS_STATE = path.join(ROOT, "node_modules", ".pnpm-workspace-state-v1.json");
const wsState = fs.existsSync(WS_STATE) ? fs.readFileSync(WS_STATE) : null;
const RT = path.join(STAGE, "runtime");
run("pnpm", ["--filter", "@kora/runtime", "deploy", "--prod", "--legacy", RT], { cwd: ROOT });
if (wsState) fs.writeFileSync(WS_STATE, wsState);
for (const f of ["dist", "ui", "bin", "koragraph", "manifests", "scripts"]) {
  const src = path.join(ROOT, "packages", "runtime", f);
  if (!fs.existsSync(path.join(RT, f)) && fs.existsSync(src))
    fs.cpSync(src, path.join(RT, f), { recursive: true });
}
for (const f of ["dist", "ui"]) {
  fs.rmSync(path.join(RT, f), { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "packages", "runtime", f), path.join(RT, f), { recursive: true });
}
const walk = (dir, fn) => {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (fn(p, e) !== false && e.isDirectory() && !e.isSymbolicLink()) walk(p, fn);
  }
};
walk(path.join(RT, "dist"), (p, e) => {
  if (e.isFile() && p.endsWith(".test.js")) fs.rmSync(p);
});
walk(RT, (p, e) => {
  if (e.isFile() && p.endsWith(".map")) fs.rmSync(p);
});
fs.rmSync(path.join(RT, "node_modules", ".package-map.json"), { force: true });
fs.rmSync(path.join(RT, "node_modules", ".modules.yaml"), { force: true });
// Other platforms' prebuilds are dead weight.
const ARCH = process.arch;
walk(path.join(RT, "node_modules"), (p, e) => {
  if (e.isDirectory() && e.name === "prebuilds") {
    for (const d of fs.readdirSync(p))
      if (!d.startsWith(`win32-${ARCH}`))
        fs.rmSync(path.join(p, d), { recursive: true, force: true });
    return false;
  }
});
// Links that leave the runtime tree (pnpm links the workspace package itself) would point at this checkout.
walk(RT, (p, e) => {
  if (!e.isSymbolicLink()) return;
  let target;
  try {
    target = fs.realpathSync(p);
  } catch {
    fs.rmSync(p, { force: true, recursive: true });
    return false;
  }
  if (!target.startsWith(fs.realpathSync(RT))) fs.rmSync(p, { force: true, recursive: true });
  return false;
});
fs.copyFileSync(process.execPath, path.join(RT, "bin", "node.exe"));
fs.writeFileSync(path.join(RT, "BUILD_ID"), BUILD_ID + "\n");
run(path.join(RT, "bin", "node.exe"), ["-e", "require('better-sqlite3'); require('node-pty')"], {
  cwd: RT,
});
// The SDK's native claude binary ships as a platform optional package; an empty store entry leaves an empty folder.
run(
  path.join(RT, "bin", "node.exe"),
  [
    "-e",
    `
  const p = require('node:path'), fs = require('node:fs');
  const sdk = fs.realpathSync('node_modules/@anthropic-ai/claude-agent-sdk');
  const dir = fs.realpathSync(p.join(sdk, '..', 'claude-agent-sdk-win32-${ARCH}'));
  const bin = fs.readdirSync(dir).find((f) => /^claude(\\.exe)?$/.test(f));
  if (!bin || fs.statSync(p.join(dir, bin)).size < 1e6) throw new Error('claude binary missing or truncated in ' + dir);
`,
  ],
  { cwd: RT },
);

const EXTRA = path.join(STAGE, "extra");
fs.mkdirSync(EXTRA);
fs.copyFileSync(
  path.join(DESKTOP, "resources", "kora-runtime.cjs"),
  path.join(EXTRA, "kora-runtime.cjs"),
);
fs.copyFileSync(
  path.join(ROOT, "THIRD_PARTY_NOTICES.md"),
  path.join(EXTRA, "THIRD_PARTY_NOTICES.md"),
);
fs.copyFileSync(
  path.join(ROOT, "assets", "icons", "release", "square-1024.png"),
  path.join(EXTRA, "icon.png"),
);
if (F.env) fs.writeFileSync(path.join(EXTRA, "flavor.env"), F.env);
fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(STAGE, "LICENSE.txt"));

// ── 3. secrets gate: never ship a key, env or credential file a local build may have picked up ───────────────
const SECRET =
  /^(\.env(\..+)?|.*\.(p8|p12|pfx|pem|key)|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa).*|credentials\.json|ui-token)$/;
const leaks = [];
walk(STAGE, (p, e) => {
  if (e.isFile() && SECRET.test(e.name) && e.name !== ".env.example") leaks.push(p);
});
if (leaks.length) die(`the staged app contains key / env / credential files:\n${leaks.join("\n")}`);

// ── 4. electron-builder: the Electron shell + NSIS installer ────────────────────────────────────────────────
say(
  `packaging ${F.name} ${VERSION} (${BUILD_ID}); signing: ${SIGNING.mode}; update feed: ${PUBLISH ? opt("--update-feed") : "none"}`,
);
const require = createRequire(path.join(DESKTOP, "package.json"));
const builder = require("electron-builder");
const electronVersion = JSON.parse(
  fs.readFileSync(require.resolve("electron/package.json"), "utf8"),
).version;
fs.rmSync(OUT, { recursive: true, force: true });
await builder.build({
  targets: builder.Platform.WINDOWS.createTarget(
    flag("--dir") ? "dir" : "nsis",
    builder.Arch[ARCH] ?? builder.Arch.x64,
  ),
  publish: "never", // the Release workflow uploads; electron-builder still writes the feed files from `config.publish`
  config: {
    ...(PUBLISH ? { publish: [PUBLISH] } : {}),
    forceCodeSigning: SIGNING.force,
    appId: F.appId,
    productName: F.name,
    executableName: F.name.replace(/ /g, ""),
    copyright: "Copyright © Koragraph",
    electronVersion,
    directories: { app: APP, output: OUT },
    asar: false, // same layout as Kora.app: resources\app\dist-electron\main.cjs
    npmRebuild: false, // the app has no node_modules; the runtime's natives were built by pnpm for node.exe
    nodeGypRebuild: false,
    electronLanguages: ["en-US"],
    extraResources: [
      { from: WEB, to: "web" },
      { from: RT, to: "runtime", filter: ["**/*"] },
      { from: EXTRA, to: ".", filter: ["**/*"] },
    ],
    protocols: [{ name: F.name, schemes: [F.scheme] }],
    // Signing (when configured) covers Kora.exe, every .exe under resources (node.exe, the SDK's claude.exe), the
    // uninstaller and the installer.
    win: {
      icon: path.join(ROOT, "assets", "icons", "release", "windows.ico"),
      target: [],
      ...SIGNING.win,
    },
    nsis: {
      oneClick: false,
      perMachine: false, // per-user: no admin prompt, installs under %LOCALAPPDATA%\Programs
      allowToChangeInstallationDirectory: true,
      artifactName: `${F.name.replace(/ /g, "-")}-Setup-${VERSION}.\${ext}`,
      shortcutName: F.name,
      license: path.join(STAGE, "LICENSE.txt"), // NSIS shows .txt/.rtf/.html
    },
    // Security fuses as on macOS (apps/desktop/scripts/flip-fuses.mjs): no Electron-as-node / NODE_OPTIONS / --inspect.
    electronFuses: {
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      grantFileProtocolExtraPrivileges: false,
    },
  },
});
const outs = fs.readdirSync(OUT).filter((f) => f.endsWith(".exe"));

// A release build must carry its feed both ways, or installed copies silently never update.
if (PUBLISH && !flag("--dir")) {
  const unpacked =
    fs.readdirSync(OUT).find((d) => /^win-(?:.+-)?unpacked$/.test(d)) ?? "win-unpacked";
  const appFeed = path.join(OUT, unpacked, "resources", "app-update.yml");
  if (!fs.existsSync(appFeed)) die(`--update-feed given but ${appFeed} was not written`);
  const feeds = updateFeedFiles(fs.readdirSync(OUT));
  if (!feeds.length) die(`--update-feed given but no latest.yml in ${OUT}`);
  if (!outs.length) die(`no installer in ${OUT}`);
  say(`update feed: ${feeds.join(", ")} + resources\\app-update.yml`);
}
// Checksums for every release-shaped build, feed or not: an unsigned release (no signing secrets, so no feed) ships them too.
if (!flag("--dir") && outs.length) {
  const sums = [...outs, ...(PUBLISH ? updateFeedFiles(fs.readdirSync(OUT)) : [])].map((f) => {
    const h = crypto.createHash("sha256").update(fs.readFileSync(path.join(OUT, f)));
    return `${h.digest("hex")}  ${f}`;
  });
  fs.writeFileSync(path.join(OUT, "SHA256SUMS-windows.txt"), sums.join("\n") + "\n");
}
if (SIGNING.mode !== "none" && !flag("--dir")) {
  // Belt and braces: forceCodeSigning already fails an unsigned build; this names what Windows sees.
  for (const f of outs) {
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-AuthenticodeSignature -LiteralPath '${path.join(OUT, f).replace(/'/g, "''")}').Status`,
      ],
      { encoding: "utf8" },
    );
    const status = (r.stdout ?? "").trim();
    if (status !== "Valid") die(`${f}: Authenticode signature is ${status || "unreadable"}`);
  }
  say(`signed (${SIGNING.mode}): ${outs.join(", ")}`);
}
say(
  `built ${flag("--dir") ? path.join(OUT, "win-unpacked") : outs.map((f) => path.join(OUT, f)).join(", ")}`,
);
