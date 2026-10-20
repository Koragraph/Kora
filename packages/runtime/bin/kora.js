#!/usr/bin/env node
'use strict';
// A `hook` invocation is advisory — it runs inside the agent on every prompt/tool and its only product is
// injected context. It must never disrupt the agent, so even the outermost require (which can land while the
// build is rewriting dist/) fails OPEN and SILENT for `hook`: exit 0, no stack. Every other command keeps the
// loud behaviour — a broken build should be obvious when you run `kora graph`, invisible when a hook fires.
const isHook = process.argv[2] === 'hook';
function bail(err) {
  if (isHook) { if (process.env.KORA_TRACE) process.stderr.write(`kora hook: ${err && err.stack || err}\n`); process.exitCode = 0; return; }
  process.stderr.write(`kora: ${err && err.stack || err}\n`);
  process.exitCode = 1;
}
// Windows hooks use Claude Code's exec form (no shell, so no `${KORA_BIN:-…}`): they bake this file, and the pane's
// KORA_BIN — another checkout's kora.js — takes over here instead, once (KORA_BIN_REDIRECTED stops a loop).
if (isHook && process.platform === 'win32' && process.env.KORA_BIN && !process.env.KORA_BIN_REDIRECTED) {
  const path = require('node:path');
  const target = path.resolve(process.env.KORA_BIN);
  if (target.toLowerCase() !== __filename.toLowerCase() && require('node:fs').existsSync(target)) {
    process.env.KORA_BIN_REDIRECTED = '1';
    try { require(target); } catch (err) { bail(err); }
    return;
  }
}
// An ingest parses source with tree-sitter wasm grammars, and V8's optimizing wasm tier aborts the whole process on the
// Swift grammar ("Fatal process out of memory: Zone"); only `node --liftoff-only` on the COMMAND LINE avoids it (not
// settable at runtime, refused in NODE_OPTIONS). Re-run this command under the flag once. (koragraph/src/services/
// ast-extractor.js skips such grammars in a process without it, so nothing ever aborts — this is what indexes them.)
const a = process.argv.slice(2);
const parses = a[0] === 'ingest' || (a[0] === 'graph' && a[1] === 'ingest') || a[0] === 'setup';
if (parses && !process.execArgv.includes('--liftoff-only') && !process.env.KORA_NO_LIFTOFF_REEXEC) {
  const r = require('node:child_process').spawnSync(process.execPath, ['--liftoff-only', ...process.execArgv, __filename, ...a], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}
try {
  require('../dist/cli/main.js').run(process.argv.slice(2)).then((code) => { process.exitCode = code ?? 0; }).catch(bail);
} catch (err) { bail(err); }
