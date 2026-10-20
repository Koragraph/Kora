#!/usr/bin/env node
// cost-replay: how much could each token-saving lever save, measured on the transcripts you already have.
//
// Reads ~/.claude/projects/**/*.jsonl READ-ONLY (no network, no model, nothing written) and reports, per lever, its
// CEILING: what the lever would have saved if it had worked perfectly on your real sessions. Numbers are in "units"
// (1 unit = one fresh input token at the model's input price) so cache writes (2x at the 1-hour TTL), cache reads (0.05x on
// Opus/Sonnet 5.5, 0.1x elsewhere) and output (5x) add up the way the bill does. See docs/research/MASTER-COST-PLAN.md §1.
//
//   node packages/runtime/scripts/cost-replay.cjs [--days 14] [--entrypoint sdk-ts|cli|all] [--project <substr>]
//                                                 [--max-files 400] [--json]
//
// Levers measured:
//   whole-file Reads   bounded Read (a 250-line window instead of the file): tokens and units kept out of the context
//   Bash 8k-30k band   bashOutputMaxChars 8000: output in the band that would spill to a file (preview ~2.3k chars)
//   idle gaps          calls that came after more than the cache TTL (a cold resume) and what they re-wrote; the ceiling
//                      of masking old tool results at that moment
//   model switches     consecutive calls on different models: the cache miss each caused
//   fixed prefix       the system prompt + tools + skills + memory every session starts with
//   Bash compression   the SHIPPED content-aware compressor (dist/session/output-compress.js, run on every real Bash result)
//                      vs the old 8k head/errors/tail trim on the same results; needs `tsc` to have built dist first
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt; };
const DAYS = Number(opt('days', '14'));
const ENTRY = opt('entrypoint', 'sdk-ts');
const PROJECT = opt('project', '');
const MAX_FILES = Number(opt('max-files', '400'));
const AS_JSON = args.includes('--json');
const ROOT = opt('root', path.join(process.env.HOME || os.homedir(), '.claude', 'projects'));

const TTL_MS = 3600 * 1000;
const WINDOW_LINES = 250;
const MIN_BOUND_LINES = 300;
const SPILL_CHARS = 8000, CLAUDE_CAP_CHARS = 30000, PREVIEW_CHARS = 2300;
const CODE_RE = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rb|java|rs|c|cc|cpp|h|hpp|cs|php|kt|swift|scala|ex|exs|sh|sql)$/i;
const readRate = (model) => (/(fable|mythos)-5-1/.test(model || '') ? 0.025 : /(opus|sonnet)-5-5/.test(model || '') ? 0.05 : 0.1);
const tok = (chars) => chars / 4;
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// The compiled TypeScript compressor itself, so the numbers are for the code that ships. Missing dist = section skipped.
let OC = null;
try { OC = require(path.join(__dirname, '..', 'dist', 'session', 'output-compress.js')); } catch { /* not built */ }
const BC = { errChanged: 0, errUnits: 0, n: 0, changed: 0, changedOld: 0, chars: 0, tokens: 0, units: 0, oldChars: 0, oldTokens: 0, oldUnits: 0, rawChars: 0, ms: 0, maxMs: 0, importantMisses: 0, missLines: [], by: {}, samples: [], later: 0 };

const T = {
  files: 0, sessions: 0, calls: 0, ctxSum: 0,
  tokens: { in: 0, cr: 0, cc: 0, out: 0 },
  units: { read: 0, write: 0, out: 0, fresh: 0 },
  readsByKind: {}, readsWhole: { n: 0, tokens: 0, units: 0 }, readsLong: { n: 0, tokens: 0, units: 0, saveTokens: 0, saveUnits: 0 }, readsAll: 0, readsRepeat: { n: 0, tokens: 0 },
  bash: { n: 0, chars: 0, band: { n: 0, chars: 0, saveTokens: 0, saveUnits: 0 }, over: { n: 0, chars: 0 } },
  gaps: { cold: 0, coldRewriteTokens: 0, coldRewriteUnits: 0, mask: { saveTokens: 0, saveUnits: 0 }, warmLong: 0 },
  switches: { n: 0, rewriteTokens: 0, rewriteUnits: 0 },
  prefix: [],
  models: {},
};

// One real Bash result through the shipped compressor and the old trim. A removed token costs one cache write (2) plus a cache
// read (rr) on every later call of the session; the footer the hook adds (FOOTER_RESERVE chars) is charged to both sides.
function bashCompress(res, tu, unitCost, remaining) {
  BC.n++; BC.rawChars += res.chars; BC.later += remaining;
  const text = res.text;
  const command = tu.input && typeof tu.input.command === 'string' ? tu.input.command : undefined;
  const t0 = process.hrtime.bigint();
  const r = OC.compressBashOutput(text, { command });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  BC.ms += ms; if (ms > BC.maxMs) BC.maxMs = ms;
  const old = OC.headTailTrim(text);
  if (old) {
    const saved = Math.max(0, text.length - old.text.length - OC.FOOTER_RESERVE);
    BC.changedOld++; BC.oldChars += saved; BC.oldTokens += tok(saved); BC.oldUnits += unitCost(tok(saved));
  }
  if (!r) return;
  const saved = Math.max(0, text.length - r.text.length - OC.FOOTER_RESERVE);
  if (!saved) return;
  BC.changed++; BC.chars += saved; BC.tokens += tok(saved);
  const u = unitCost(tok(saved)); BC.units += u;
  if (res.err) { BC.errChanged++; BC.errUnits += u; } // a failed command reaches PostToolUseFailure, which cannot replace output
  const e = BC.by[r.compressor] || (BC.by[r.compressor] = { n: 0, chars: 0, units: 0 });
  e.n++; e.chars += saved; e.units += u;
  // the guarantee being sold: no error / fail / warning line of the cleaned original is missing from the result
  if (!/^(json|head-tail)$/.test(r.compressor)) {
    const miss = OC.stripTerminalNoise(text).split('\n').find((l) => OC.IMPORTANT.test(l) && !r.text.includes(l));
    if (miss !== undefined) { BC.importantMisses++; if (BC.missLines.length < 5) BC.missLines.push(`[${r.compressor}] ${miss.slice(0, 140)}`); }
  }
  BC.samples.push({ compressor: r.compressor, saved, before: text, after: r.text, command: command || '' });
  if (BC.samples.length > 400) { BC.samples.sort((a, b) => b.saved - a.saved); BC.samples.length = 60; }
}

function finishSession(calls, results) {
  if (!calls.length) return;
  T.sessions++;
  const n = calls.length;
  // tool_use id -> call index
  for (let k = 0; k < n; k++) {
    const c = calls[k];
    T.calls++;
    const u = c.usage; const rr = readRate(c.model);
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    T.ctxSum += ctx;
    T.tokens.in += u.input_tokens || 0; T.tokens.cr += u.cache_read_input_tokens || 0; T.tokens.cc += u.cache_creation_input_tokens || 0; T.tokens.out += u.output_tokens || 0;
    T.units.fresh += u.input_tokens || 0; T.units.read += (u.cache_read_input_tokens || 0) * rr; T.units.write += (u.cache_creation_input_tokens || 0) * 2; T.units.out += (u.output_tokens || 0) * 5;
    T.models[c.model || '?'] = (T.models[c.model || '?'] || 0) + 1;
    if (k === 0) T.prefix.push(ctx);
    if (k > 0) {
      const prev = calls[k - 1];
      const gap = c.ts && prev.ts ? c.ts - prev.ts : 0;
      const cc = u.cache_creation_input_tokens || 0;
      if (gap >= TTL_MS) {
        T.gaps.cold++; T.gaps.coldRewriteTokens += cc; T.gaps.coldRewriteUnits += cc * 2;
        // ceiling of masking at this moment: tool results older than the last 10 calls, as tokens, written at 2x once and read at rr after
        let stub = 0;
        for (let j = 0; j < Math.max(0, k - 10); j++) stub += calls[j].resultTokens || 0;
        stub = Math.min(stub, cc * 0.9);
        T.gaps.mask.saveTokens += stub; T.gaps.mask.saveUnits += stub * 2 + stub * rr * (n - k - 1);
      } else if (gap >= 300 * 1000) T.gaps.warmLong++;
      if (c.model && prev.model && c.model !== prev.model) { T.switches.n++; T.switches.rewriteTokens += cc; T.switches.rewriteUnits += cc * 2; }
    }
    // tool uses of this call, with the sizes of their results
    const remaining = n - k - 1;
    for (const tu of c.tools) {
      const res = results.get(tu.id);
      if (!res) continue;
      c.resultTokens = (c.resultTokens || 0) + tok(res.chars);
      const unitCost = (t) => t * (2 + rr * remaining);
      if (tu.name === 'Read') {
        T.readsAll++;
        const whole = tu.input && tu.input.offset == null && tu.input.limit == null;
        const file = String((tu.input && tu.input.file_path) || '');
        {
          // where Read volume really goes: whole vs ranged, by extension
          const ext = (path.extname(file) || '(none)').toLowerCase();
          const key = `${whole ? 'whole' : 'range'} ${ext}`;
          const e = T.readsByKind[key] || (T.readsByKind[key] = { n: 0, tokens: 0, bigN: 0, bigTokens: 0 });
          const t = tok(res.chars); e.n++; e.tokens += t; if (res.lines > MIN_BOUND_LINES) { e.bigN++; e.bigTokens += t; }
        }
        if (whole && CODE_RE.test(file)) {
          const t = tok(res.chars);
          T.readsWhole.n++; T.readsWhole.tokens += t; T.readsWhole.units += unitCost(t);
          if (res.lines > MIN_BOUND_LINES) {
            const keep = Math.min(1, WINDOW_LINES / res.lines);
            T.readsLong.n++; T.readsLong.tokens += t; T.readsLong.units += unitCost(t);
            T.readsLong.saveTokens += t * (1 - keep); T.readsLong.saveUnits += unitCost(t * (1 - keep));
          }
        }
      } else if (tu.name === 'Bash') {
        if (OC && res.text) bashCompress(res, tu, unitCost, remaining);
        T.bash.n++; T.bash.chars += res.chars;
        if (res.chars > CLAUDE_CAP_CHARS) { T.bash.over.n++; T.bash.over.chars += res.chars; }
        else if (res.chars > SPILL_CHARS) {
          const save = tok(res.chars - PREVIEW_CHARS);
          T.bash.band.n++; T.bash.band.chars += res.chars; T.bash.band.saveTokens += save; T.bash.band.saveUnits += unitCost(save);
        }
      }
    }
  }
  // the same file Read whole more than once in one session
  const seen = new Map();
  for (const c of calls) for (const tu of c.tools) {
    if (tu.name !== 'Read' || !tu.input || tu.input.offset != null || tu.input.limit != null) continue;
    const f = String(tu.input.file_path || ''); const res = results.get(tu.id); if (!f || !res) continue;
    if (seen.has(f)) { T.readsRepeat.n++; T.readsRepeat.tokens += tok(res.chars); } else seen.set(f, 1);
  }
}

function scanFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  const calls = []; const results = new Map(); const byId = new Map();
  let entry = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.entrypoint && !entry) entry = e.entrypoint;
    if (e.type === 'assistant' && e.message && e.message.usage && e.message.id) {
      const id = e.message.id;
      let c = byId.get(id);
      if (!c) { c = { model: e.message.model, usage: e.message.usage, ts: e.timestamp ? Date.parse(e.timestamp) : 0, tools: [] }; byId.set(id, c); calls.push(c); }
      else if (e.message.usage.output_tokens > (c.usage.output_tokens || 0)) c.usage = e.message.usage;
      for (const b of e.message.content || []) if (b && b.type === 'tool_use' && !c.tools.some((t) => t.id === b.id)) c.tools.push({ id: b.id, name: b.name, input: b.input });
    } else if (e.type === 'user' && Array.isArray(e.message && e.message.content)) {
      for (const b of e.message.content) {
        if (!b || b.type !== 'tool_result') continue;
        let s = '';
        if (typeof b.content === 'string') s = b.content;
        else if (Array.isArray(b.content)) s = b.content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('');
        let lines = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) lines++;
        results.set(b.tool_use_id, { chars: s.length, lines, text: s.length >= 2000 ? s : null, err: b.is_error === true });
      }
    }
  }
  if (ENTRY !== 'all' && entry !== ENTRY) return;
  T.files++;
  finishSession(calls, results);
}

function listFiles() {
  const cutoff = Date.now() - DAYS * 864e5; const out = [];
  let dirs = []; try { dirs = fs.readdirSync(ROOT); } catch { return out; }
  for (const d of dirs) {
    if (PROJECT && !d.includes(PROJECT)) continue;
    const dir = path.join(ROOT, d); let fl = [];
    try { fl = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of fl) { const p = path.join(dir, f); try { const st = fs.statSync(p); if (st.mtimeMs >= cutoff) out.push({ p, m: st.mtimeMs }); } catch { /* gone */ } }
  }
  if (out.length > MAX_FILES) console.error(`cost-replay: WARNING ${out.length} files in the window, only the newest ${MAX_FILES} are read (--max-files N); the window is shorter than --days.`);
  return out.sort((a, b) => b.m - a.m).slice(0, MAX_FILES).map((x) => x.p);
}

for (const f of listFiles()) scanFile(f);

const totalUnits = T.units.read + T.units.write + T.units.out + T.units.fresh;
const share = (u) => (totalUnits ? ((u / totalUnits) * 100).toFixed(1) + '%' : 'n/a');
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)));
const allTok = T.tokens.in + T.tokens.cr + T.tokens.cc;
const report = {
  scanned: { root: ROOT, days: DAYS, entrypoint: ENTRY, files: T.files, sessions: T.sessions, calls: T.calls },
  context: { avgPromptTokens: T.calls ? Math.round(T.ctxSum / T.calls) : 0, cacheReadShareOfTokens: allTok ? T.tokens.cr / allTok : null, tokens: T.tokens },
  billSplit: { reads: T.units.read / (totalUnits || 1), writes: T.units.write / (totalUnits || 1), output: T.units.out / (totalUnits || 1), fresh: T.units.fresh / (totalUnits || 1), totalUnits: Math.round(totalUnits) },
  models: T.models,
  readsByKind: Object.entries(T.readsByKind).map(([kind, v]) => ({ kind, reads: v.n, tokens: Math.round(v.tokens), over300Lines: v.bigN, over300Tokens: Math.round(v.bigTokens) })).sort((a, b) => b.tokens - a.tokens).slice(0, 10),
  levers: {
    boundedRead: { wholeCodeReads: T.readsWhole.n, ofAllReads: T.readsAll, wholeTokens: Math.round(T.readsWhole.tokens), longFileReads: T.readsLong.n, longFileTokens: Math.round(T.readsLong.tokens), ceilingSaveTokens: Math.round(T.readsLong.saveTokens), ceilingSaveUnits: Math.round(T.readsLong.saveUnits), ceilingShareOfBill: totalUnits ? T.readsLong.saveUnits / totalUnits : null, repeatWholeReads: T.readsRepeat.n, repeatTokens: Math.round(T.readsRepeat.tokens) },
    bashSpill8k: { bashResults: T.bash.n, inBand8k30k: T.bash.band.n, bandChars: T.bash.band.chars, ceilingSaveTokens: Math.round(T.bash.band.saveTokens), ceilingSaveUnits: Math.round(T.bash.band.saveUnits), ceilingShareOfBill: totalUnits ? T.bash.band.saveUnits / totalUnits : null, over30kAlreadyCapped: T.bash.over.n },
    coldResumeMasking: { coldCalls: T.gaps.cold, rewrittenTokens: Math.round(T.gaps.coldRewriteTokens), rewrittenUnits: Math.round(T.gaps.coldRewriteUnits), shareOfBill: totalUnits ? T.gaps.coldRewriteUnits / totalUnits : null, maskCeilingTokens: Math.round(T.gaps.mask.saveTokens), maskCeilingUnits: Math.round(T.gaps.mask.saveUnits), gaps5to60min: T.gaps.warmLong },
    modelSwitches: { switches: T.switches.n, rewrittenTokens: Math.round(T.switches.rewriteTokens), rewrittenUnits: Math.round(T.switches.rewriteUnits), shareOfBill: totalUnits ? T.switches.rewriteUnits / totalUnits : null },
    bashCompress: OC ? {
      bashResults: BC.n, rawChars: BC.rawChars, outputsChanged: BC.changed, charsRemoved: Math.round(BC.chars), tokensRemoved: Math.round(BC.tokens), billUnitsSaved: Math.round(BC.units), shareOfBill: totalUnits ? BC.units / totalUnits : null,
      old8kTrim: { outputsChanged: BC.changedOld, charsRemoved: Math.round(BC.oldChars), tokensRemoved: Math.round(BC.oldTokens), billUnitsSaved: Math.round(BC.oldUnits), shareOfBill: totalUnits ? BC.oldUnits / totalUnits : null },
      failedCommands: { outputsChanged: BC.errChanged, billUnitsSaved: Math.round(BC.errUnits) },
      importantLineMisses: BC.importantMisses, compressMs: { total: Math.round(BC.ms), max: Math.round(BC.maxMs * 10) / 10 },
      byCompressor: Object.entries(BC.by).map(([name, v]) => ({ name, outputs: v.n, charsRemoved: Math.round(v.chars), billUnitsSaved: Math.round(v.units) })).sort((a, b) => b.billUnitsSaved - a.billUnitsSaved),
    } : null,
    fixedPrefix: { medianFirstCallTokens: Math.round(median(T.prefix)), avgFirstCallTokens: T.prefix.length ? Math.round(T.prefix.reduce((a, b) => a + b, 0) / T.prefix.length) : 0 },
  },
};

// five before/after samples: the biggest saving of five different compressors, then the biggest remaining
function pickSamples() {
  const all = [...BC.samples].sort((a, b) => b.saved - a.saved); const out = []; const used = new Set();
  for (const x of all) { if (out.length < 5 && !used.has(x.compressor)) { out.push(x); used.add(x.compressor); } }
  for (const x of all) { if (out.length < 5 && !out.includes(x)) out.push(x); }
  return out;
}
if (AS_JSON) { report.bashCompressSamples = pickSamples().map((x) => ({ compressor: x.compressor, command: x.command.slice(0, 160), beforeChars: x.before.length, afterChars: x.after.length, before: x.before.slice(0, 700), after: x.after.slice(0, 700) })); process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exit(0); }
const pct = (x) => (x === null || x === undefined ? 'n/a' : (x * 100).toFixed(1) + '%');
console.log(`cost-replay: ${T.files} ${ENTRY} session file(s), ${T.calls} API calls, last ${DAYS} days (${ROOT})`);
if (!T.calls) { console.log('nothing to replay.'); process.exit(0); }
console.log(`context: avg ${k(report.context.avgPromptTokens)} tokens per call; ${pct(report.context.cacheReadShareOfTokens)} of prompt tokens are cache reads`);
console.log(`bill (units): reads ${pct(report.billSplit.reads)} | writes ${pct(report.billSplit.writes)} | output ${pct(report.billSplit.output)} | fresh input ${pct(report.billSplit.fresh)}  (total ${k(totalUnits)})`);
console.log('');
console.log('lever ceilings (what a perfect version would have saved on THESE sessions):');
const b = report.levers.boundedRead;
console.log(`  bounded Read      ${b.wholeCodeReads}/${b.ofAllReads} Reads were whole code files (${k(b.wholeTokens)} tokens); ${b.longFileReads} were over ${MIN_BOUND_LINES} lines (${k(b.longFileTokens)} tokens)`);
console.log(`                    ceiling with a ${WINDOW_LINES}-line window: ${k(b.ceilingSaveTokens)} tokens = ${pct(b.ceilingShareOfBill)} of the bill; ${b.repeatWholeReads} whole re-reads of a file already read (${k(b.repeatTokens)} tokens)`);
const s = report.levers.bashSpill8k;
console.log(`  Bash 8k-30k       ${s.inBand8k30k}/${s.bashResults} Bash outputs were 8k-30k chars; ceiling ${k(s.ceilingSaveTokens)} tokens = ${pct(s.ceilingShareOfBill)} of the bill (${s.over30kAlreadyCapped} over 30k are already capped)`);
const c = report.levers.coldResumeMasking;
console.log(`  idle gaps > 1h    ${c.coldCalls} calls came back cold and re-wrote ${k(c.rewrittenTokens)} tokens = ${pct(c.shareOfBill)} of the bill; masking old tool results ceiling ${k(c.maskCeilingTokens)} tokens (${k(c.maskCeilingUnits)} units); ${c.gaps5to60min} more gaps of 5-60 min`);
const bc = report.levers.bashCompress;
if (bc) {
  console.log(`  Bash compression  shipped compressor over ${bc.bashResults} real Bash results (${k(bc.rawChars / 4)} tokens): changed ${bc.outputsChanged}, removed ${k(bc.charsRemoved)} chars = ${k(bc.tokensRemoved)} tokens, bill effect ${k(bc.billUnitsSaved)} units = ${pct(bc.shareOfBill)} of the bill`);
  console.log(`                    old 8k trim, same data: changed ${bc.old8kTrim.outputsChanged}, removed ${k(bc.old8kTrim.charsRemoved)} chars = ${k(bc.old8kTrim.tokensRemoved)} tokens, ${k(bc.old8kTrim.billUnitsSaved)} units = ${pct(bc.old8kTrim.shareOfBill)} of the bill; new vs old: ${bc.old8kTrim.billUnitsSaved ? (bc.billUnitsSaved / bc.old8kTrim.billUnitsSaved).toFixed(2) + 'x' : 'n/a'}`);
  console.log(`                    error/fail/warning lines missing from a compressed output (head-tail excluded): ${bc.importantLineMisses}; compress time ${bc.compressMs.total} ms total, ${bc.compressMs.max} ms worst`);
  console.log(`                    of which failed commands (exit != 0, PostToolUseFailure: the live hook cannot replace these): ${bc.failedCommands.outputsChanged} outputs, ${k(bc.failedCommands.billUnitsSaved)} units = ${pct(bc.billUnitsSaved ? bc.shareOfBill * bc.failedCommands.billUnitsSaved / bc.billUnitsSaved : 0)} of the bill`);
  for (const l of BC.missLines) console.log(`                      missing: ${l}`);
  for (const r of bc.byCompressor.slice(0, 10)) console.log(`                      ${r.name.padEnd(30)} ${String(r.outputs).padStart(5)} outputs  ${k(r.charsRemoved).padStart(7)} chars  ${k(r.billUnitsSaved).padStart(7)} units`);
}
const m = report.levers.modelSwitches;
console.log(`  model switches    ${m.switches} switches re-wrote ${k(m.rewrittenTokens)} tokens = ${pct(m.shareOfBill)} of the bill`);
const f = report.levers.fixedPrefix;
console.log(`  fixed prefix      median first call ${k(f.medianFirstCallTokens)} tokens (avg ${k(f.avgFirstCallTokens)}): system prompt + tools + skills + memory`);
console.log('');
console.log('where Read volume goes (reads / tokens / of which over 300 lines):');
for (const r of report.readsByKind.slice(0, 6)) console.log(`  ${r.kind.padEnd(14)} ${String(r.reads).padStart(5)} reads  ${k(r.tokens).padStart(7)} tokens  ${String(r.over300Lines).padStart(4)} over 300 lines (${k(r.over300Tokens)})`);
console.log('');
console.log('models: ' + Object.entries(T.models).sort((a, b2) => b2[1] - a[1]).slice(0, 6).map(([mm, n]) => `${mm} ${n}`).join(', '));
if (OC && BC.changed) {
  console.log('');
  console.log('five before/after samples of compressed Bash outputs (first 600 chars of each; transcripts hold stdout+stderr merged):');
  const cut = (t) => t.slice(0, 600).split('\n').map((l) => '    | ' + (l.length > 150 ? l.slice(0, 150) + '...' : l)).join('\n');
  pickSamples().forEach((x, i) => {
    console.log(`  #${i + 1} [${x.compressor}] ${x.command.replace(/\s+/g, ' ').slice(0, 110)}`);
    console.log(`  BEFORE (${x.before.length} chars):\n${cut(x.before)}`);
    console.log(`  AFTER (${x.after.length} chars):\n${cut(x.after)}`);
  });
  console.log('');
} else if (!OC) console.log('Bash compression: dist/session/output-compress.js not built (run tsc in packages/runtime) - section skipped.');
console.log('ceilings are upper bounds (a window is sometimes not enough, a cold call may be needed anyway); see docs/research/MASTER-COST-PLAN.md.');
