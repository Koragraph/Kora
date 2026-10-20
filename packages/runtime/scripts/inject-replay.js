#!/usr/bin/env node
'use strict';
// Injection replay: run the per-prompt graph injection over REAL prompts (from Claude Code transcripts, or a file),
// against the real graph, with no agent tokens, and tabulate what it decided and why. This is the miss taxonomy
// (Phase 1B) and a precision proxy: when an injection fires, did the top declaration's file match what the agent in
// that transcript then went and read (or did it answer without reading at all)?
//
//   node scripts/inject-replay.js --cwd <indexed repo> [--transcripts <dir>] [--prompts <file: one per line>]
//                                 [--limit N] [--out <json>] [--verbose]
// Transcripts default to ~/.claude/projects/<encoded cwd>/*.jsonl. Prompts are deduped and slash commands skipped.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const cwd = path.resolve(get('--cwd', process.cwd()));
const limit = Number(get('--limit', '400'));
const verbose = argv.includes('--verbose');
process.env.KORA_INJECT_LOG = process.env.KORA_INJECT_LOG || '0'; // replay must not pollute the live telemetry

const pi = require(path.join(ROOT, 'dist', 'graph', 'prompt-inject.js'));
const { createGraphService } = require(path.join(ROOT, 'dist', 'graph', 'index.js'));

function encodeCwd(p) { return p.replace(/[\/. ]/g, '-'); }
function* transcriptPrompts(dir) {
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); } catch { return; }
  for (const f of files) {
    let lines; try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    let cur = null; // { prompt, files: Set }
    const flush = () => { if (cur) { yieldBuf.push(cur); cur = null; } };
    const yieldBuf = [];
    for (const l of lines) {
      if (!l.trim()) continue; let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.type === 'user' && o.message && typeof o.message.content === 'string') {
        flush();
        const p = o.message.content.trim();
        if (!p || p.startsWith('/') || p.startsWith('<') || p.length < 12 || p.length > 1200) continue;
        cur = { prompt: p, files: new Set(), reads: 0, transcript: path.basename(f) };
      } else if (o.type === 'user' && Array.isArray(o.message?.content) && o.message.content.some((b) => b.type === 'text')) {
        flush();
        const p = o.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (!p || p.startsWith('/') || p.startsWith('<') || p.length < 12 || p.length > 1200) continue;
        cur = { prompt: p, files: new Set(), reads: 0, transcript: path.basename(f) };
      } else if (o.type === 'assistant' && cur && Array.isArray(o.message?.content)) {
        for (const b of o.message.content) if (b.type === 'tool_use') {
          const fp = b.input?.file_path || b.input?.path || (b.name === 'Bash' ? null : null);
          if (fp) { cur.files.add(path.isAbsolute(fp) ? path.relative(cwd, fp) : fp); if (b.name === 'Read') cur.reads++; }
        }
      }
    }
    flush();
    for (const c of yieldBuf) yield c;
  }
}

(async () => {
  const g = createGraphService();
  const st = await g.status(cwd);
  if (!st || !st.indexed) { console.error(`${cwd} is not indexed`); process.exit(2); }
  let items = [];
  const pf = get('--prompts');
  if (pf) items = fs.readFileSync(pf, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).map((prompt) => ({ prompt, files: new Set(), reads: 0, transcript: null }));
  else {
    const dir = get('--transcripts', path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd)));
    const seen = new Set();
    for (const it of transcriptPrompts(dir)) { const k = pi.promptHash(it.prompt); if (seen.has(k)) continue; seen.add(k); items.push(it); }
  }
  items = items.slice(0, limit);
  console.error(`${items.length} prompt(s) · ${cwd} (${st.nodes} nodes)`);
  const rows = [];
  const byReason = {}; let injected = 0, precise = 0, answeredWithoutRead = 0, totalMs = 0, maxMs = 0;
  for (const it of items) {
    const sid = `replay-${process.pid}-${rows.length}`;
    const t0 = Date.now();
    const text = await pi.injectForPrompt({ prompt: it.prompt, cwd, sessionId: sid, lane: 'replay', graph: g });
    const rec = pi.lastInjectRecord;
    const ms = Date.now() - t0; totalMs += ms; maxMs = Math.max(maxMs, ms);
    const reason = rec ? rec.reason : 'no-record';
    byReason[reason] = (byReason[reason] || 0) + 1;
    let topFile = null, hit = null;
    if (text) {
      injected++;
      const m = /■\s+\S+\s+\S+\s+@\s+(\S+?):\d+/.exec(text); topFile = m ? m[1] : null;
      if (it.reads === 0) { answeredWithoutRead++; hit = 'no-read'; }
      else if (topFile && [...it.files].some((f) => f === topFile || f.endsWith(topFile) || topFile.endsWith(f))) { precise++; hit = 'match'; }
      else hit = 'other-file';
    }
    rows.push({ prompt: it.prompt.slice(0, 160), reason, decision: rec ? rec.decision : null, ms, query: rec?.query || null, idents: rec?.idents ?? 0, topHit: rec?.topHit || null, topFile, agentFiles: [...it.files].slice(0, 6), agentReads: it.reads, hit });
    if (verbose) console.error(`${reason.padEnd(20)} ${String(ms).padStart(5)}ms ${(rec?.topHit || '').padEnd(28)} ${it.prompt.slice(0, 90).replace(/\n/g, ' ')}`);
  }
  const summary = { cwd, nodes: st.nodes, prompts: items.length, injected, injectRate: items.length ? injected / items.length : 0, byReason, latency: { avgMs: items.length ? Math.round(totalMs / items.length) : 0, maxMs }, precision: { withRead: rows.filter((r) => r.hit === 'match' || r.hit === 'other-file').length, match: precise, answeredWithoutRead } };
  const out = get('--out'); if (out) fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
  // no process.exit: a piped stdout is not always flushed before exit (the summary arrived empty downstream)
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exitCode = 0;
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
