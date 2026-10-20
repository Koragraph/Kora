#!/usr/bin/env node
"use strict";
// QA stack controller. Usage: node qa/stacks/stack.cjs <start|stop|status|web|webstop|seed|up|down|reset> <N|all>
//   start/stop     the isolated daemon (kora server run) for stack N
//   web/webstop    the Vite dev server for stack N (single-origin dev, proxy injects the stack home's UI token)
//   seed           repos + projects + threads (stops the daemon while it writes the UI projection, then restarts it)
//   up/down        start+web / webstop+stop;  reset = down + delete the stack folder
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const { ROOT, BIN, NODE_BIN, stack, childEnv, prepareHome } = require("./env.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function socketUp(sock) {
  return new Promise((resolve) => {
    const s = net.createConnection(sock);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}
function httpUp(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(300);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

async function start(s) {
  if (await socketUp(s.env.KORA_SOCKET_PATH)) {
    console.log(`stack${s.n}: daemon already up`);
    return;
  }
  prepareHome(s, { swarmConsent: s.n !== 4 }); // stack 4 keeps Swarm un-consented so the setup wizard is testable
  const out = fs.openSync(path.join(s.base, "daemon.out"), "a");
  const p = spawn(process.execPath, [BIN, "server", "run"], {
    env: childEnv(s),
    detached: true,
    stdio: ["ignore", out, out],
    cwd: s.base,
  });
  p.unref();
  fs.writeFileSync(path.join(s.base, "daemon.pid"), String(p.pid));
  await waitFor(() => socketUp(s.env.KORA_SOCKET_PATH), 30_000, `stack${s.n} socket`);
  await waitFor(() => httpUp(`http://127.0.0.1:${s.uiPort}/`), 30_000, `stack${s.n} ui port`);
  console.log(
    `stack${s.n}: daemon up pid ${p.pid} (ui :${s.uiPort}, sock ${s.env.KORA_SOCKET_PATH})`,
  );
}

async function stop(s) {
  if (!(await socketUp(s.env.KORA_SOCKET_PATH))) {
    console.log(`stack${s.n}: daemon already down`);
    return;
  }
  try {
    execFileSync(process.execPath, [BIN, "server", "stop"], {
      env: childEnv(s),
      stdio: "ignore",
      timeout: 20_000,
    });
  } catch {
    /* fall through to pid */
  }
  const pidFile = path.join(s.base, "daemon.pid");
  for (let i = 0; i < 50 && (await socketUp(s.env.KORA_SOCKET_PATH)); i++) await sleep(200);
  if (await socketUp(s.env.KORA_SOCKET_PATH)) {
    const pid = Number(fs.readFileSync(pidFile, "utf8")); // exact PID, never a pattern kill
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
    await sleep(1000);
  }
  // The socket closes before the daemon finishes persisting; a seed written now would be overwritten by that last
  // flush (projects.json came back with only the Kora blob). Wait for the process itself to go.
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    for (let i = 0; pid > 0 && i < 50; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await sleep(200);
    }
  } catch {
    /* no pid file */
  }
  console.log(`stack${s.n}: daemon down`);
}

async function web(s) {
  if (await httpUp(s.url)) {
    console.log(`stack${s.n}: web already up at ${s.url}`);
    return;
  }
  fs.mkdirSync(s.base, { recursive: true });
  const out = fs.openSync(path.join(s.base, "web.out"), "a");
  const env = { ...childEnv(s), KORA_SINGLE_ORIGIN_DEV: "1", KORA_PORT: String(s.uiPort) };
  const pnpm = path.join(NODE_BIN, "pnpm");
  const p = spawn(
    fs.existsSync(pnpm) ? pnpm : "pnpm",
    ["vp", "dev", "--port", String(s.webPort), "--strictPort"],
    {
      cwd: path.join(ROOT, "apps/web"),
      env,
      detached: true,
      stdio: ["ignore", out, out],
    },
  );
  p.unref();
  fs.writeFileSync(path.join(s.base, "web.pid"), String(p.pid));
  await waitFor(() => httpUp(s.url), 120_000, `stack${s.n} web ${s.url}`);
  console.log(`stack${s.n}: web up at ${s.url} (pid ${p.pid})`);
}

async function webstop(s) {
  const pidFile = path.join(s.base, "web.pid");
  if (!fs.existsSync(pidFile)) {
    console.log(`stack${s.n}: no web pid`);
    return;
  }
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  fs.rmSync(pidFile, { force: true });
  console.log(`stack${s.n}: web stopped`);
}

async function status(s) {
  console.log(
    `stack${s.n}: daemon ${(await socketUp(s.env.KORA_SOCKET_PATH)) ? "UP" : "down"}  web ${(await httpUp(s.url)) ? "UP" : "down"}  ${s.url}  home ${s.home}`,
  );
}

const CMDS = {
  start,
  stop,
  web,
  webstop,
  status,
  seed: async (s) => {
    await require("./seed.cjs").seed(s, { start, stop });
  },
  up: async (s) => {
    await start(s);
    await web(s);
  },
  down: async (s) => {
    await webstop(s);
    await stop(s);
  },
  reset: async (s) => {
    await webstop(s);
    await stop(s);
    fs.rmSync(s.base, { recursive: true, force: true });
    console.log(`stack${s.n}: removed`);
  },
};

(async () => {
  const [cmd, which = "all"] = process.argv.slice(2);
  if (!CMDS[cmd]) {
    console.error("usage: stack.cjs <start|stop|status|web|webstop|seed|up|down|reset> <N|all>");
    process.exit(2);
  }
  const ns = which === "all" ? [1, 2, 3, 4] : String(which).split(",").map(Number);
  // web servers start serially (each cold Vite start is heavy); daemons are cheap.
  for (const n of ns) {
    const s = stack(n);
    fs.mkdirSync(s.base, { recursive: true });
    await CMDS[cmd](s);
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
