#!/usr/bin/env node
'use strict';

// Direct entry point for the MCP server, for running it without the CLI:
//   node src/mcp/start.js
// `koragraph mcp` (src/cli/mcp.js) is the documented way in and reaches the same server.

// stdout is the JSON-RPC channel. Several services on the read path (graph-health.js,
// dependency-graph.js, ingest logging) call console.log unconditionally, and one such line
// silently corrupts the protocol stream for the rest of the session. Redirecting to stderr is
// cheaper and more reliable than auditing every call site. src/cli/main.js applies the same
// redirect for the same reason. It runs BEFORE requiring the server so a module-load-time write
// on any transitively-required module is caught too, and covers debug/dir — distinct console
// bindings that keep writing to stdout after console.log is reassigned.
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.debug = (...args) => console.error(...args);
console.dir = (...args) => console.error(...args);

const { createStdioServer } = require('./stdio');

const { isPipeGone, makeLimitedReporter } = require('../common-services/pipe-guard');

// A stdio MCP server lives as long as its client. When the client disconnects, writes to stdout/stderr fail with
// EPIPE: that is the session ending, not an error to log (logging it to the same dead pipe looped at ~12–70 MB/s and
// the process never exited — see pipe-guard.js). Exit quietly instead.
const clientGone = () => process.exit(0);
for (const s of [process.stdout, process.stderr]) s.on('error', (e) => { if (isPipeGone(e)) clientGone(); });

const report = makeLimitedReporter((label, err) => console.error(label, err?.stack || err));
process.on('uncaughtException', (err) => {
  if (isPipeGone(err)) return clientGone();
  report('[koragraph-mcp] uncaught:', err);
});
process.on('unhandledRejection', (err) => {
  if (isPipeGone(err)) return clientGone();
  report('[koragraph-mcp] unhandled rejection:', err);
});

// Opts the real server into live, per-query freshness checking (live-freshness.js) — every other
// caller (every unit test on this surface) gets tool-handlers.js's no-op default instead, since
// none of them expect a tool call to touch git/graph.db/practice.db for real. See freshnessOf's
// own comment in tool-handlers.js for why this is opt-in rather than a default.
const deps = { freshness: require('../services/live-freshness') };

// A stdio MCP server owns its lifetime: when the client closes stdin the session is over.
const server = createStdioServer({ deps, onClose: () => process.exit(0) });
server.start();
console.error('[koragraph-mcp] listening on stdio');
