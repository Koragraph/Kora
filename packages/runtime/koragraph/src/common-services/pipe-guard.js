// When the process on the other end of stdout/stderr goes away (an MCP client disconnects), every write fails with
// EPIPE. Before this guard that error reached the global uncaughtException handlers, which LOGGED it — to the console
// transport on the same dead stderr, which failed with EPIPE again, which was logged again: an endless loop that wrote
// ~12–70 MB/s into the file transports (3.6 GB in five minutes, 2026-09-27) and never let the process exit.
//
// isPipeGone: is this error "the other end is gone" (nothing to report, nobody to report to)?
// makeLimitedReporter: log at most `perWindow` copies of the same error per window, then one "suppressed" count —
// so no future error loop, of any kind, can flood a disk.

const PIPE_GONE_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ECONNRESET']);

function isPipeGone(err) {
    return !!err && typeof err === 'object' && PIPE_GONE_CODES.has(err.code);
}

function makeLimitedReporter(log, { perWindow = 5, windowMs = 60_000, now = Date.now } = {}) {
    const counts = new Map();
    let windowStart = now();
    let suppressed = 0;
    return (label, err) => {
        const t = now();
        if (t - windowStart >= windowMs) {
            if (suppressed) log(`${label} ${suppressed} repeat(s) suppressed in the last ${Math.round(windowMs / 1000)} s`);
            counts.clear();
            suppressed = 0;
            windowStart = t;
        }
        const key = `${err?.code ?? ''}|${err?.message ?? String(err)}`;
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        if (n > perWindow) {
            suppressed++;
            return false;
        }
        log(label, err);
        return true;
    };
}

module.exports = { isPipeGone, makeLimitedReporter };
