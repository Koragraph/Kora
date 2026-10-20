'use strict';
// The two arms every Claude A/B bench runs: Kora's desktop chat lane (ClaudeDriver over the Agent SDK inside a real,
// ISOLATED daemon, KORA_INJECT_OWNER=driver, prepareChatSession's rulebook + hooks, per-prompt injection) and the same
// Agent SDK with the same `buildSessionOptions` and NO Kora (no prep, no injection, no fleet tools), i.e. plain Claude
// Code via the SDK. Usage per turn comes from Claude Code's own transcript (~/.claude/projects/**/<session>.jsonl: one
// row per API call, deduped by message id → exact input / cache-read / cache-write split) plus the turn's `result`
// output count (the transcript's per-row output is the first streamed delta's running count). Cost = list price.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RT, HOME } = require('./swarm-e2e/env.cjs');
const { buildSessionOptions } = require(path.join(RT, 'dist/session/drivers/claude-driver.js'));

// list price per million tokens (5-minute cache write)
const PRICE = { sonnet: { in: 3, out: 15, cw: 3.75, cr: 0.3 }, opus: { in: 15, out: 75, cw: 18.75, cr: 1.5 } };
const price = (m) => (/opus|fable/i.test(m) ? PRICE.opus : PRICE.sonnet);

function findTranscript(sid) {
  if (!sid) return null;
  const root = path.join(os.homedir(), '.claude', 'projects');
  for (const d of fs.readdirSync(root)) { const f = path.join(root, d, `${sid}.jsonl`); if (fs.existsSync(f)) return f; }
  return null;
}
/** Per-API-call usage from a transcript (deduped by message id), the tools called and the last assistant text. */
function readTranscript(file) {
  const out = { input: 0, cacheRead: 0, cacheWrite: 0, apiCalls: 0, tools: {}, toolCalls: 0, answer: '', firstCW: 0, firstCR: 0, peakContext: 0, compactions: 0, models: {} };
  if (!file) return out;
  const seen = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue; let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'system' && o.subtype === 'compact_boundary') out.compactions++;
    if (o.type !== 'assistant' || !o.message || o.isSidechain) continue;
    const m = o.message; const id = m.id;
    if (id && !seen.has(id)) {
      seen.add(id); const u = m.usage || {};
      out.input += u.input_tokens || 0; out.cacheRead += u.cache_read_input_tokens || 0; out.cacheWrite += u.cache_creation_input_tokens || 0;
      out.peakContext = Math.max(out.peakContext, (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
      if (out.apiCalls === 0) { out.firstCW = u.cache_creation_input_tokens || 0; out.firstCR = u.cache_read_input_tokens || 0; }
      out.apiCalls++; out.models[m.model] = (out.models[m.model] || 0) + 1;
    }
    for (const b of m.content || []) {
      if (b.type === 'tool_use') { out.toolCalls++; out.tools[b.name] = (out.tools[b.name] || 0) + 1; }
      if (b.type === 'text' && b.text && b.text.trim()) out.answer = b.text;
    }
  }
  return out;
}
function injectionsFor(threadId, since) {
  try {
    return fs.readFileSync(path.join(HOME, 'inject.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.sessionId === threadId && (r.ts == null || new Date(r.ts).getTime() >= since - 5000));
  } catch { return []; }
}

/** One turn on Kora's chat lane in the isolated daemon. `opts`: { out, model, timeoutMs, title }. */
async function runKora(client, task, dir, opts) {
  const t0 = Date.now(); const rec = { threadId: null, sid: null, output: 0, settled: null, warnings: [] };
  const th = await client.call('chat.thread.create', { agent: 'claude', cwd: dir, model: { model: opts.model }, title: opts.title ?? `bench ${task.id}` });
  rec.threadId = th.threadId ?? th.id;
  await client.call('chat.session.setPermissionMode', { threadId: rec.threadId, mode: 'full-access' }).catch(() => {});
  await client.call('chat.events.subscribe', { threadIds: [rec.threadId] });
  const log = fs.createWriteStream(path.join(opts.out, `${task.id}.kora.events.jsonl`));
  let timer;
  const done = new Promise((resolve) => {
    const onEv = (ev) => {
      if (!ev || ev.threadId !== rec.threadId) return;
      if (ev.type !== 'content.delta') log.write(JSON.stringify(ev) + '\n');
      if (ev.type === 'thread.started' && ev.providerThreadId) rec.sid = ev.providerThreadId;
      if (ev.type === 'runtime.warning' || ev.type === 'runtime.error') rec.warnings.push(ev.message);
      if (ev.type === 'turn.settled') { rec.settled = ev.state; rec.output = ev.usage?.outputTokens ?? 0; client.off('chat.event', onEv); resolve(); }
    };
    client.on('chat.event', onEv);
    timer = setTimeout(() => { rec.settled = 'timeout'; client.off('chat.event', onEv); resolve(); }, opts.timeoutMs);
  });
  await client.call('chat.turn.send', { threadId: rec.threadId, text: task.prompt });
  await done; clearTimeout(timer); log.end();
  rec.ms = Date.now() - t0;
  rec.inject = injectionsFor(rec.threadId, t0).map((r) => ({ decision: r.decision, reason: r.reason, decls: r.decls, chars: r.chars, ms: r.ms, lane: r.lane }));
  try { await client.call('chat.session.stop', { threadId: rec.threadId }); } catch { /* fine */ }
  return rec;
}

/** The same turn on the plain Agent SDK with Kora's session options and nothing of Kora. `opts`: { model, timeoutMs }. */
async function runOff(task, dir, opts) {
  const { query } = require(path.join(RT, 'node_modules/@anthropic-ai/claude-agent-sdk'));
  const t0 = Date.now(); const rec = { sid: null, output: 0, settled: null, sdkCost: null };
  const input = { threadId: `off-${task.id}`, agent: 'claude', cwd: dir, model: { model: opts.model }, runtimeMode: 'full-access' };
  const so = buildSessionOptions(input, null, undefined, {}, { mcpServers: {}, canUseTool: async () => ({ behavior: 'allow' }) });
  // same base env as a daemon session: no KORA_* (so no hook/identity), no inherited Claude Code session markers
  const e = { ...so.env }; for (const k of Object.keys(e)) if (/^(KORA_|KORAGRAPH_)/.test(k)) delete e[k];
  so.env = e; delete so.includePartialMessages; so.additionalDirectories = [];
  const q = query({ prompt: task.prompt, options: so });
  const timer = setTimeout(() => { rec.settled = 'timeout'; try { q.interrupt(); } catch { /* */ } }, opts.timeoutMs);
  for await (const m of q) {
    if (m.session_id && !rec.sid) rec.sid = m.session_id;
    if (m.type === 'result') { rec.settled ??= m.is_error ? 'failed' : 'completed'; rec.output = m.usage?.output_tokens ?? 0; rec.sdkCost = m.total_cost_usd ?? null; rec.sdkUsage = m.usage; break; }
  }
  clearTimeout(timer);
  rec.ms = Date.now() - t0;
  return rec;
}

/** Transcript usage + list-price cost for a finished turn. */
function usageOf(rec, model) {
  const tr = readTranscript(findTranscript(rec.sid));
  const p = price(model);
  const cost = (tr.input * p.in + rec.output * p.out + tr.cacheWrite * p.cw + tr.cacheRead * p.cr) / 1e6;
  return { tr, costUsd: +cost.toFixed(4) };
}

module.exports = { findTranscript, readTranscript, injectionsFor, runKora, runOff, usageOf, price };
