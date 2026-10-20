// @effect-diagnostics nodeBuiltinImport:off globalRandom:off globalTimers:off -- Runs the shipped POSIX script against a fake bundle and home.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

// kora-runtime.sh with a fake bundle (a sh "node", stub native modules, a stub CLI) and a throwaway home: the real
// ~/.kora is never touched. Mode `sync` only, so no daemon is ever started.
const SCRIPT = NodePath.resolve(import.meta.dirname, "../../resources/kora-runtime.sh");
const MANIFEST_CJS = NodePath.resolve(
  import.meta.dirname,
  "../../resources/kora-runtime-manifest.cjs",
);
const bases: string[] = [];

function fakeBundle(opts: { brokenModules?: boolean; build?: string } = {}) {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-rt-script-"));
  bases.push(base);
  const res = NodePath.join(base, "Resources");
  const rt = NodePath.join(res, "runtime");
  NodeFS.mkdirSync(NodePath.join(rt, "bin"), { recursive: true });
  for (const m of ["better-sqlite3", "node-pty"]) {
    NodeFS.mkdirSync(NodePath.join(rt, "node_modules", m), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(rt, "node_modules", m, "index.js"),
      opts.brokenModules ? "throw new Error('no native');\n" : "module.exports = {};\n",
    );
  }
  NodeFS.writeFileSync(NodePath.join(rt, "node_modules", "node-pty", "spawn-helper"), "x\n", {
    mode: 0o644,
  });
  NodeFS.writeFileSync(
    NodePath.join(rt, "bin", "node"),
    `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(NodePath.join(rt, "bin", "kora.js"), "process.exit(1);\n");
  NodeFS.writeFileSync(NodePath.join(rt, "BUILD_ID"), `${opts.build ?? "b1"}\n`);
  NodeFS.copyFileSync(SCRIPT, NodePath.join(res, "kora-runtime.sh"));
  NodeFS.copyFileSync(MANIFEST_CJS, NodePath.join(res, "kora-runtime-manifest.cjs"));
  const home = NodePath.join(base, "home");
  NodeFS.mkdirSync(home);
  return { base, res, rt, home };
}
function run(b: { res: string; home: string }, mode = "sync", extra: Record<string, string> = {}) {
  return NodeChildProcess.spawn("/bin/sh", [NodePath.join(b.res, "kora-runtime.sh"), mode], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: b.home,
      KORA_HOME: NodePath.join(b.home, ".kora"),
      KORA_UI_PORT: "1",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
const done = (c: NodeChildProcess.ChildProcess) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = "";
    c.stdout?.on("data", (d) => (out += d));
    c.stderr?.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
  });

afterEach(() => {
  for (const b of bases.splice(0)) NodeFS.rmSync(b, { recursive: true, force: true });
});

// kora-runtime.sh is the macOS launcher (Windows runs kora-runtime.cjs; Linux has no app): macOS only.
// oxlint-disable-next-line kora/no-global-process-runtime -- a test skip condition, decided before any runtime exists
describe.skipIf(process.platform !== "darwin")("kora-runtime.sh sync", () => {
  it("installs, and two concurrent runs serialize without leaving a broken copy", async () => {
    const b = fakeBundle();
    const [x, y] = await Promise.all([done(run(b)), done(run(b))]);
    expect(x.code).toBe(0);
    expect(y.code).toBe(0);
    const app = NodePath.join(b.home, ".kora", "app");
    expect(NodeFS.existsSync(NodePath.join(app, "bin", "node"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(app, "BUILD_ID"))).toBe(true);
    expect(NodeFS.existsSync(`${app}.new`)).toBe(false);
    expect(NodeFS.existsSync(`${app}.old`)).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(b.home, ".kora", "runtime.lock"))).toBe(false);
  });

  it("keeps the live runtime when the new copy cannot load its native modules", async () => {
    const good = fakeBundle({ build: "b1" });
    expect((await done(run(good))).code).toBe(0);
    // same home, new (broken) bundle
    const bad = fakeBundle({ build: "b2", brokenModules: true });
    const r = await done(run({ res: bad.res, home: good.home }));
    expect(r.code).not.toBe(0);
    const app = NodePath.join(good.home, ".kora", "app");
    expect(NodeFS.readFileSync(NodePath.join(app, "BUILD_ID"), "utf8").trim()).toBe("b1");
    expect(NodeFS.existsSync(`${app}.new`)).toBe(false);
  });

  it("restores an interrupted swap and breaks a stale lock", async () => {
    const b = fakeBundle();
    expect((await done(run(b))).code).toBe(0);
    const app = NodePath.join(b.home, ".kora", "app");
    NodeFS.renameSync(app, `${app}.old`); // crash between the two renames
    const lock = NodePath.join(b.home, ".kora", "runtime.lock");
    NodeFS.mkdirSync(lock);
    NodeFS.writeFileSync(NodePath.join(lock, "pid"), "999999\n"); // a pid that is not running
    const r = await done(run(b));
    expect(r.code).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(app, "bin", "node"))).toBe(true);
    expect(NodeFS.existsSync(`${app}.old`)).toBe(false);
  });

  it("does not reinstall when only a file mode changed (spawn-helper chmod)", async () => {
    const b = fakeBundle();
    const gen = NodeChildProcess.spawnSync(process.execPath, [
      MANIFEST_CJS,
      "generate",
      b.rt,
      NodePath.join(b.res, "runtime-manifest.json"),
      "b1",
    ]);
    expect(gen.status).toBe(0);
    expect((await done(run(b))).code).toBe(0);
    const helper = NodePath.join(
      b.home,
      ".kora",
      "app",
      "node_modules",
      "node-pty",
      "spawn-helper",
    );
    NodeFS.chmodSync(helper, 0o755);
    const r = await done(run(b));
    expect(r.out).toContain("already current");
    expect(r.out).not.toContain("modified outside Kora");
  });
});

// The script reads a pid's command line with `ps`, which a sandboxed agent shell (Seatbelt) refuses.
const psWorks =
  NodeChildProcess.spawnSync("ps", ["-o", "command=", "-p", String(process.pid)]).status === 0;

// oxlint-disable-next-line kora/no-global-process-runtime -- a test skip condition, decided before any runtime exists
describe.skipIf(process.platform !== "darwin" || !psWorks)(
  "kora-runtime.sh: a daemon that is up but silent",
  () => {
    it("stops exactly that pid (from daemon.pid) and carries on", async () => {
      const b = fakeBundle();
      const port = 40000 + Math.floor(Math.random() * 20000);
      // A "daemon": a process whose command line says `server run`, listening on the UI port and never answering.
      const fakeDaemon = NodePath.join(b.base, "fake-daemon.js");
      NodeFS.writeFileSync(
        fakeDaemon,
        `require("node:net").createServer((s) => { s.on("error", () => {}); }).listen(${port}, "127.0.0.1");\n`,
      );
      const daemon = NodeChildProcess.spawn(process.execPath, [fakeDaemon, "server", "run"], {
        stdio: "ignore",
      });
      const kora = NodePath.join(b.home, ".kora");
      NodeFS.mkdirSync(kora, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(kora, "daemon.pid"), `${daemon.pid}\n`);
      await new Promise((r) => setTimeout(r, 400));
      const exited = new Promise<void>((resolve) => daemon.on("exit", () => resolve()));
      try {
        const r = await done(
          run(b, "sync", {
            KORA_UI_PORT: String(port),
            KORA_HEALTH_TRIES: "1",
            KORA_HEALTH_TIMEOUT: "1",
            KORA_UNRESPONSIVE_MIN_AGE_SEC: "0",
          }),
        );
        expect(r.out).toContain(`pid ${daemon.pid}) is up but not answering`);
        await Promise.race([exited, new Promise((res) => setTimeout(res, 5000))]);
        expect(daemon.exitCode !== null || daemon.signalCode !== null).toBe(true);
        expect(NodeFS.existsSync(NodePath.join(kora, "daemon.pid"))).toBe(false);
      } finally {
        try {
          daemon.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }
    });

    it("leaves a daemon alone that is still starting (younger than the minimum age)", async () => {
      const b = fakeBundle();
      const port = 40000 + Math.floor(Math.random() * 20000);
      const fakeDaemon = NodePath.join(b.base, "fake-daemon.js");
      NodeFS.writeFileSync(
        fakeDaemon,
        `require("node:net").createServer((s) => { s.on("error", () => {}); }).listen(${port}, "127.0.0.1");\n`,
      );
      const daemon = NodeChildProcess.spawn(process.execPath, [fakeDaemon, "server", "run"], {
        stdio: "ignore",
      });
      NodeFS.mkdirSync(NodePath.join(b.home, ".kora"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(b.home, ".kora", "daemon.pid"), `${daemon.pid}\n`);
      await new Promise((r) => setTimeout(r, 400));
      try {
        const r = await done(
          run(b, "sync", {
            KORA_UI_PORT: String(port),
            KORA_HEALTH_TRIES: "1",
            KORA_HEALTH_TIMEOUT: "1",
          }),
        );
        expect(r.out).toContain("still starting");
        expect(daemon.exitCode).toBe(null);
      } finally {
        daemon.kill("SIGKILL");
      }
    });
  },
);
