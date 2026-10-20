// Dev runner: waits for the bundles and the Vite dev server, starts Electron, and restarts it
// whenever the main or preload bundle is rebuilt.
import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { desktopDir, devProtocolClient, electronLaunchCommand } from "./mac-launcher.mjs";
import { waitForDevServer } from "./await-dev-server.mjs";

const devServerUrl = (process.env.VITE_DEV_SERVER_URL ?? "").trim();
if (!devServerUrl) throw new Error("VITE_DEV_SERVER_URL is required for desktop development.");
const devServer = new URL(devServerUrl);
const devPort = Number(devServer.port);
if (!(devPort > 0))
  throw new Error(`VITE_DEV_SERVER_URL must include an explicit port: ${devServerUrl}`);

const bundleDir = join(desktopDir, "dist-electron");
const WATCHED = new Set(["main.cjs", "preload.cjs"]);
const rootFlag = `--kora-dev-root=${desktopDir}`;

const { ELECTRON_RUN_AS_NODE: _drop, ...baseEnv } = process.env;
const protocolClient = devProtocolClient();
const childEnv = protocolClient
  ? {
      ...baseEnv,
      KORA_DESKTOP_APP_USER_MODEL_ID: protocolClient.appBundleId,
      KORA_DESKTOP_PROTOCOL_REGISTRATION_MANAGED: "1",
    }
  : baseEnv;
const debugFlag = process.env.KORA_DESKTOP_REMOTE_DEBUGGING_PORT
  ? [`--remote-debugging-port=${process.env.KORA_DESKTOP_REMOTE_DEBUGGING_PORT}`]
  : [];

await waitForDevServer({
  baseDir: desktopDir,
  files: ["dist-electron/main.cjs", "dist-electron/preload.cjs"],
  tcpHost: devServer.hostname,
  tcpPort: devPort,
});

let app = null;
let quitting = false;
let expectedStop = false;
let restartTimer = null;
let queue = Promise.resolve();

const pkill = (signal, ...selector) =>
  spawnSync("pkill", [signal, ...selector], { stdio: "ignore" });
const killStaleApps = () => pkill("-TERM", "-f", "--", rootFlag);

function startApp() {
  if (quitting || app) return;
  const launchArgs = protocolClient
    ? debugFlag
    : [...debugFlag, rootFlag, "dist-electron/main.cjs"];
  const { electronPath, args } = electronLaunchCommand(launchArgs);
  const child = spawn(electronPath, args, { cwd: desktopDir, env: childEnv, stdio: "inherit" });
  app = child;
  child.once("error", () => {
    app = null;
    if (!quitting) scheduleRestart();
  });
  child.once("exit", (code, signal) => {
    app = null;
    const abnormal = signal !== null || (code ?? 0) !== 0;
    if (!quitting && !expectedStop && abnormal) scheduleRestart();
    expectedStop = false;
  });
}

async function stopApp() {
  const child = app;
  if (!child) {
    killStaleApps();
    return;
  }
  expectedStop = true;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  pkill("-TERM", "-P", String(child.pid));
  killStaleApps();
  const outcome = await Promise.race([exited.then(() => "exited"), sleep(1500).then(() => "slow")]);
  if (outcome === "slow") {
    child.kill("SIGKILL");
    pkill("-KILL", "-P", String(child.pid));
    killStaleApps();
  }
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    queue = queue
      .catch(() => {})
      .then(async () => {
        await stopApp();
        if (!quitting) startApp();
      });
  }, 120);
}

const watcher = watch(bundleDir, (_event, name) => {
  if (name && WATCHED.has(String(name))) scheduleRestart();
});

async function shutdown(exitCode) {
  if (quitting) return;
  quitting = true;
  clearTimeout(restartTimer);
  watcher.close();
  await stopApp();
  pkill("-TERM", "-P", String(process.pid));
  await sleep(1200);
  pkill("-KILL", "-P", String(process.pid));
  process.exit(exitCode);
}
process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));
process.once("SIGHUP", () => void shutdown(129));

killStaleApps();
startApp();
