#!/usr/bin/env node
// A FAKE koragent for Kora's tests: speaks the Kora ↔ Koragent contract (src/protocol/koragent.ts) and nothing else.
//
//   fake-koragent.cjs --task-spec <file> --event-stream unix:<path>
//
// It LISTENS on the unix socket, keeps every event in a ring buffer, answers each connection's `hello{sinceSeq}` with
// its own hello + a replay of the events after sinceSeq, then streams live. It runs one scripted task:
//   starting → ready → working → turn.start → tool.start/tool.end (writes a file in the worktree) → budget.update →
//   task.report (+ report JSON/.md at TaskSpec.report.path) → turn.end → done
// and stays up afterwards like a TUI would (a later steer starts another round). Scenario: `[fake:<name>]` in the
// goal, several allowed (`[fake:failover] [fake:nofiles]`):
//   failover    route.failover route[0] → route[1] before the tool call (in-session, no restart)
//   blocked     permission.request + session.state blocked; continues on permission.reply (allow → done, deny → failed)
//   wait-steer  after the tool call, waits for a steer before reporting (the steer text lands in the summary)
//   nofiles     sends task.report but writes no report files (Kora must render them from the event)
//   json-only   writes only the report JSON and sends no task.report event (Kora's file fallback)
//   noreport    reaches done with no report at all
//   slow-listen binds the socket 800 ms late (Kora must retry)
//   exit        exits 0 right after done
// Every steer is acknowledged (steer.received with Kora's id, then steer.delivered). SIGUSR2 drops every connection
// (a transient disconnect: the client must reconnect with hello{sinceSeq} and see no event twice).
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const specFile = arg('--task-spec');
const stream = arg('--event-stream');
if (!specFile || !stream || !stream.startsWith('unix:')) { process.stderr.write('usage: fake-koragent --task-spec <file> --event-stream unix:<path>\n'); process.exit(2); }
const sockPath = stream.slice('unix:'.length);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const scen = new Set([...String(spec.goal || '').matchAll(/\[fake:([\w-]+)\]/g)].map((m) => m[1]));
const sessionID = `ses_fake_${process.pid}`;
const route = (spec.route || []).map((r) => r.model || r.alias).filter(Boolean);
let model = route[0] || 'unknown/model';

process.stdout.write(`\x1b[2Jkoragent (fake) — task ${spec.taskId} on ${model}\r\n`);

// ── event stream ──────────────────────────────────────────────────────────────────────────────────────────────
const ring = [];
const RING_MAX = 2000;
let seq = 0;
const clients = new Set();
function emit(type, fields = {}) {
  const e = { v: 1, seq: ++seq, ts: Date.now(), sessionID, taskID: spec.taskId, type, ...fields };
  ring.push(e); if (ring.length > RING_MAX) ring.shift();
  const line = JSON.stringify(e) + '\n';
  for (const c of clients) if (c.ready) c.sock.write(line);
  return e;
}

// Inbound messages nobody waited for yet (a permission.reply queued before the request, an early steer).
const inbox = [];
const waiters = [];
function waitFor(pred) {
  const i = inbox.findIndex(pred);
  if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
  return new Promise((resolve) => waiters.push({ pred, resolve }));
}
let steerN = 0;
const steers = [];
function onMessage(c, m) {
  if (m.type === 'hello') {
    const since = Number(m.sinceSeq) || 0;
    const first = ring.length ? ring[0].seq : seq + 1;
    c.sock.write(JSON.stringify({ v: 1, seq: 0, ts: Date.now(), sessionID, type: 'hello', pid: process.pid, version: '0.0.0-fake', capabilities: ['steer', 'replay', 'task-spec'], replayFrom: Math.max(since + 1, first) }) + '\n');
    for (const e of ring) if (e.seq > since) c.sock.write(JSON.stringify(e) + '\n');
    c.ready = true;
    return;
  }
  if (m.type === 'steer') {
    const id = m.id || `st_${++steerN}`;
    emit('steer.received', { id, source: m.source, delivery: m.delivery, preview: String(m.text || '').slice(0, 80) });
    steers.push({ id, text: String(m.text || ''), source: m.source, delivery: m.delivery });
    setTimeout(() => emit('steer.delivered', { id, atStep: step }), 10);
  }
  const w = waiters.findIndex((x) => x.pred(m));
  if (w >= 0) waiters.splice(w, 1)[0].resolve(m); else inbox.push(m);
}

const server = net.createServer((sock) => {
  const c = { sock, ready: false, buf: '' };
  clients.add(c);
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    c.buf += d;
    let i;
    while ((i = c.buf.indexOf('\n')) >= 0) {
      const line = c.buf.slice(0, i).trim(); c.buf = c.buf.slice(i + 1);
      if (!line) continue;
      try { onMessage(c, JSON.parse(line)); } catch { /* ignore garbage */ }
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => clients.delete(c));
});
process.on('SIGUSR2', () => { for (const c of [...clients]) c.sock.destroy(); clients.clear(); });

function listen() {
  try { fs.rmSync(sockPath, { force: true }); } catch {}
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });
  server.listen(sockPath);
}
const cleanup = () => { try { fs.rmSync(sockPath, { force: true }); } catch {} };
process.on('exit', cleanup);
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => { cleanup(); process.exit(0); });

// ── the task ──────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
let round = 0;
const wt = (spec.worktree && spec.worktree.path) || process.cwd();

function writeReportFiles(report) {
  const json = spec.report.path;
  fs.mkdirSync(path.dirname(json), { recursive: true });
  fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n');
  if (scen.has('json-only')) return;
  const md = json.replace(/\.json$/, '') + '.md';
  fs.writeFileSync(md, [
    '## Status', `${report.status} — ${report.summary}`, '',
    '## Changes', ...report.changes.map((c) => `- ${c.path} (+${c.added} −${c.removed})`), '',
    '## Check', report.check ? `\`${report.check.command}\` → exit ${report.check.exitCode}` : 'not run', '',
    '## Findings', ...(report.findings.length ? report.findings.map((f) => `- ${f.text}`) : ['none']), '',
    '## Blockers', ...(report.blockers.length ? report.blockers.map((b) => `- ${b}`) : ['none']), '',
  ].join('\n'));
}

async function runRound(extra) {
  round++;
  emit('session.state', { state: 'working' });
  emit('turn.start');
  await sleep(30);
  if (round === 1 && scen.has('failover') && route[1]) {
    emit('session.state', { state: 'retrying', reason: '429 Too Many Requests' });
    await sleep(20);
    emit('route.failover', { from: route[0], to: route[1], reason: 'rate-limited (429)', retryAfter: 30 });
    model = route[1];
    emit('model.switch', { from: route[0], to: route[1], reason: 'failover' });
    emit('session.state', { state: 'working' });
  }
  if (round === 1 && scen.has('blocked')) {
    emit('permission.request', { id: 'perm_1', tool: 'bash', summary: 'rm -rf build' });
    emit('session.state', { state: 'blocked', blockedOn: 'permission: bash rm -rf build' });
    const reply = await waitFor((m) => m.type === 'permission.reply' && m.id === 'perm_1');
    if (!reply.allow) {
      emit('turn.end', { outcome: 'denied' });
      await finish({ status: 'blocked', summary: 'permission denied', blockers: ['bash rm -rf build was denied'] });
      return;
    }
    emit('session.state', { state: 'working' });
  }
  step++;
  emit('tool.start', { callID: `call_${round}`, tool: 'write', title: `write fake-koragent-${round}.txt` });
  fs.writeFileSync(path.join(wt, `fake-koragent-${round}.txt`), `round ${round} of ${spec.taskId}\n`);
  emit('tool.end', { callID: `call_${round}`, status: 'completed', ms: 5, files: [`fake-koragent-${round}.txt`] });
  emit('budget.update', { tokens: { in: 1000 * round, out: 100 * round, cacheRead: 500 * round }, usd: 0.001 * round, steps: step });
  if (round === 1 && scen.has('wait-steer')) {
    await waitFor((m) => m.type === 'steer');
    await sleep(15);
  }
  emit('turn.end', { outcome: 'completed' });
  const said = steers.map((s) => `steer: ${s.text} (${s.source}, ${s.delivery})`);
  await finish({ status: 'done', summary: [`round ${round} on ${model}`, extra, ...said].filter(Boolean).join('; '), blockers: [] });
}

async function finish(r) {
  if (scen.has('noreport')) { emit('session.state', { state: 'done' }); return afterDone(); }
  const report = {
    v: 1, taskId: spec.taskId, sessionId: sessionID, status: r.status, summary: r.summary,
    changes: [{ path: `fake-koragent-${round}.txt`, added: 1, removed: 0 }],
    check: spec.acceptance && spec.acceptance.check ? { command: spec.acceptance.check, exitCode: 0, outputTail: 'ok', ranBy: 'harness' } : null,
    findings: [{ text: `wrote fake-koragent-${round}.txt`, ref: `fake-koragent-${round}.txt:1` }],
    blockers: r.blockers,
    attempts: route.slice(0, scen.has('failover') ? 2 : 1).map((m, i, a) => ({ model: m, outcome: i < a.length - 1 ? 'rate-limited' : 'ok' })),
    usage: { steps: step, tokens: { in: 1000 * round, out: 100 * round, cacheRead: 500 * round }, costUsd: 0.001 * round, refCostUsd: 0.01 * round, bySource: { free: 0.001 * round } },
  };
  if (!scen.has('nofiles')) writeReportFiles(report);
  if (!scen.has('json-only')) emit('task.report', { report });
  emit('session.state', { state: r.status === 'done' ? 'done' : 'failed' });
  return afterDone();
}

async function afterDone() {
  if (scen.has('exit')) { await sleep(100); emit('session.state', { state: 'exited' }); await sleep(50); process.exit(0); }
  // Like the TUI: idle until the next steer, which starts another round.
  const m = await waitFor((x) => x.type === 'steer');
  await runRound(`follow-up: ${String(m.text).split('\n')[0].slice(0, 60)}`);
}

(async () => {
  if (scen.has('slow-listen')) await sleep(800);
  listen();
  emit('session.state', { state: 'starting' });
  await sleep(20);
  emit('ui.ready');
  emit('session.state', { state: 'ready' });
  await sleep(20);
  await runRound('');
})().catch((e) => { emit('error', { message: String(e && e.stack || e), fatal: true }); process.exitCode = 1; });
setInterval(() => {}, 1 << 30); // stay up like a TUI
