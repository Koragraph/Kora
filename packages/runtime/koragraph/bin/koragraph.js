#!/usr/bin/env node
'use strict';

// `ingest` / `catch-up` parse with tree-sitter wasm grammars; V8's optimizing wasm tier aborts the process on the Swift
// grammar unless node runs with --liftoff-only (command line only). Re-run under it once. (kora patch, PATCHES.md)
const argv = process.argv.slice(2);
if ((argv[0] === 'ingest' || argv[0] === 'catch-up') && !process.execArgv.includes('--liftoff-only') && !process.env.KORA_NO_LIFTOFF_REEXEC) {
  const r = require('node:child_process').spawnSync(process.execPath, ['--liftoff-only', ...process.execArgv, __filename, ...argv], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

require('../src/cli/main')
  .run(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    // main.run() classifies everything it can reach; anything arriving here escaped a command's
    // own boundary, so print it plainly rather than losing it to an unhandled rejection.
    process.stderr.write(`koragraph: ${err?.stack || err?.message || err}\n`);
    process.exitCode = 1;
  });
