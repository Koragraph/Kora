// Test isolation preload for the ui-server suite (`node --require ./scripts/test-isolate.cjs --test …`), the twin of
// packages/runtime/scripts/test-isolate.cjs. node --test forwards --require to every test-file process, so EACH FILE
// gets its own TMPDIR, KORA_HOME and graph store, removed when it exits. Before, every run left ~250 kora-* folders in
// the shared $TMPDIR (3,900 / 216 MB found by the 2026-10-13 deep audit), and a test that forgot to set KORA_HOME would
// have written into the real ~/.kora (or whatever home the shell had). A test that needs its own paths still sets
// them itself (a later assignment wins). HOME is left alone: nothing here may raise a keychain prompt.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Remove isolation bases that an earlier run left behind (deep A2-9): `--test-force-exit` can end a test file"s process
 * without its `exit` handler, so 209 bases (90 MB) had piled up. A base is stale when its `.owner` pid is dead, or (no
 * `.owner`, i.e. made by an older runner) when it has not been touched for 2 hours. Never touches a live owner's base.
 */
function sweepStaleBases(parent, prefix, now = Date.now()) {
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const dir = path.join(parent, name);
    try {
      let stale;
      let owner = NaN;
      try {
        owner = Number(fs.readFileSync(path.join(dir, ".owner"), "utf8").trim());
      } catch {
        /* older base */
      }
      if (Number.isInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
          stale = false;
        } catch (e) {
          stale = e && e.code === "ESRCH";
        }
      } else stale = now - fs.statSync(dir).mtimeMs > 2 * 3600 * 1000;
      if (stale) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* best effort */
    }
  }
  return removed;
}
module.exports = { sweepStaleBases };

const isRunner = process.execArgv.includes("--test") || process.argv.includes("--test");
if (isRunner)
  sweepStaleBases(
    process.platform === "win32" ? os.tmpdir() : fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(),
    "kui-",
  );
if (!isRunner && !process.env.KORA_UI_TEST_ISOLATED) {
  // Windows: the long form of the temp dir (the runner's TEMP is an 8.3 name, C:\Users\RUNNER~1, that realpath expands,
  // so a path built from it never equals the same path read back), and TEMP/TMP are what os.tmpdir() reads there.
  const parent =
    process.platform === "win32"
      ? fs.realpathSync.native(os.tmpdir())
      : fs.existsSync("/tmp")
        ? "/tmp"
        : os.tmpdir();
  const base = fs.mkdtempSync(path.join(parent, "kui-"));
  try {
    fs.writeFileSync(path.join(base, ".owner"), String(process.pid));
  } catch {
    /* sweep falls back to age */
  }
  const env = process.env;
  env.KORA_UI_TEST_ISOLATED = String(process.pid);
  env.TMPDIR = path.join(base, "tmp");
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  if (process.platform === "win32") env.TEMP = env.TMP = env.TMPDIR;
  env.KORA_HOME = path.join(base, "kora-home");
  env.KORAGRAPH_HOME = path.join(base, "koragraph");
  env.KORAGRAPH_DB = path.join(base, "koragraph", "graph.db");
  const owner = process.pid;
  process.on("exit", () => {
    if (process.pid !== owner || env.KORA_TEST_KEEP) return;
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
}
