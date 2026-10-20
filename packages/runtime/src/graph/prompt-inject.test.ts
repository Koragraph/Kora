import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looksCodeShaped, declarationLines, renderInjection, promptHash, alreadyInjected, markInjected, injectedMarker, injectForPrompt, identifierParts, hitRelevant, INJECT_MAX_CHARS, INJECT_HEADER, INJECT_TRAILER, INJECT_SNIPPET_CHARS } from './prompt-inject';
import { run as hookRun } from '../cli/commands/hook';

// A repository indexed in the local graph store (e.g. a checkout of KoragraphMCP); the store-backed tests skip without it.
const INDEXED_REPO = process.env.KORA_TEST_INDEXED_REPO ?? path.join(os.homedir(), 'Projects', 'KoragraphMCP');
const haveStore = fs.existsSync(INDEXED_REPO) && fs.existsSync(process.env.KORAGRAPH_DB || `${process.env.HOME}/.koragraph/graph.db`);

const SAMPLE = `25 match(es) for "repoIdentity". Focus: 2 symbol(s) with callers/callees + source.

■ METHOD repoIdentity @ src/practice/repo-identity.js:91 — repoIdentity(startDir)
  callers: supersedeLive@src/practice/stated.js:35, cwdWarning@src/cli/status.js:307
  callees: findRepoRoot@src/practice/repo-identity.js:15, normaliseRemote@src/practice/repo-identity.js:67
  --- source src/practice/repo-identity.js:91-97 ---
function repoIdentity(startDir) {
  const repoRoot = findRepoRoot(startDir);
  return { repoRoot, repoId, repoName: repoNameOf(repoId) };
}

■ METHOD run @ src/cli/practice.js:847 — run(parsed, io)
  callers: harvestTombstones@src/cli/practice.js:645
  callees: runDigest@src/cli/practice.js:621
  --- source src/cli/practice.js:847-866 ---
  out(\`Checked\`);
  if (report.expired.length) {

other matches:
  METHOD callsIdentifier @ scripts/edge-precision-audit.js:64
  METHOD containsIdentifier @ scripts/edge-precision-audit.js:55
  METHOD goldDeclarations @ scripts/lang-quality/goldset.mjs:270
  METHOD visit @ scripts/lang-quality/goldset.mjs:285
  METHOD objc @ scripts/lang-quality/goldset.mjs:249
  METHOD _zigBindsImport @ scripts/lang-quality/goldset.mjs:226
  METHOD _solidityDeclName @ scripts/lang-quality/goldset.mjs:134
  METHOD install @ src/cli/stderr-filter.js:98
`;

test('looksCodeShaped: ≥6 words and an identifier or a question word; never slash commands or yes/no', () => {
  assert.equal(looksCodeShaped('how does resolveSymbol handle ambiguous names?'), true);
  assert.equal(looksCodeShaped('please make the parse_transcript function faster for big files'), true, 'snake_case identifier');
  assert.equal(looksCodeShaped('the value of config.grepCap is wrong in the pane'), true, 'dotted identifier');
  assert.equal(looksCodeShaped('explain the ledger to me in plain words'), true, 'question word');
  assert.equal(looksCodeShaped('fix it'), false, '< 6 words');
  assert.equal(looksCodeShaped('yes please go ahead and do it now'), false, 'yes/no/continue');
  assert.equal(looksCodeShaped('continue'), false);
  assert.equal(looksCodeShaped('/compact keep the file line citations and decisions'), false, 'slash command');
  // terse code questions: a code-shaped identifier is enough even under 6 words
  assert.equal(looksCodeShaped('what does mergeWorktree do'), true, 'terse camelCase question');
  assert.equal(looksCodeShaped('explain parse_transcript'), true, 'terse snake_case');
  assert.equal(looksCodeShaped('config.grepCap?'), true, 'terse dotted');
  assert.equal(looksCodeShaped('mergeWorktree'), true, 'a lone code identifier is worth resolving');
  assert.equal(looksCodeShaped('database'), false, 'a lone non-code word is not');
  assert.equal(looksCodeShaped('thanks so much this is really helpful'), false, 'prose, no identifier, no question word');
  assert.equal(looksCodeShaped('write a poem about the sea and the sky tonight'), false, 'no identifier, no question word');
  assert.equal(looksCodeShaped(''), false);
});

test('declarationLines keeps ■ hits, the top hit callers line and the ranked tail; drops source and callees', () => {
  const lines = declarationLines(SAMPLE);
  assert.equal(lines[0], '■ METHOD repoIdentity @ src/practice/repo-identity.js:91 — repoIdentity(startDir)');
  assert.match(lines[1], /^callers: supersedeLive/);
  assert.equal(lines[2], '■ METHOD run @ src/cli/practice.js:847 — run(parsed, io)');
  assert.ok(!lines.some((l) => /callees:|function repoIdentity|--- source|harvestTombstones/.test(l)), 'no source blocks, no callees, only the top hit callers');
  assert.equal(lines.filter((l) => /^  METHOD/.test(l)).length, 6, 'ranked tail capped');
  const text = renderInjection(SAMPLE)!;
  assert.ok(text.startsWith(INJECT_HEADER));
  assert.ok(text.length <= INJECT_MAX_CHARS, `capped (${text.length})`);
  assert.equal(renderInjection('0 match(es) for "zzz".'), null, 'nothing to inject → null');
  // A huge result is cut on a line boundary at the cap.
  const big = SAMPLE.replace('other matches:', 'other matches:\n' + Array.from({ length: 200 }, (_, i) => `  METHOD f${i} @ src/very/long/path/to/file${i}.js:${i}`).join('\n'));
  assert.ok(renderInjection(big)!.length <= INJECT_MAX_CHARS);
});

test('declarationLines: with a snippet budget, the top hit body is included when it fits, dropped (not truncated) when it does not', () => {
  const withBody = declarationLines(SAMPLE, INJECT_MAX_CHARS, INJECT_SNIPPET_CHARS);
  assert.ok(withBody.some((l) => /function repoIdentity\(startDir\)/.test(l)), 'small top-hit body is included so the agent need not Read the file');
  assert.ok(!withBody.some((l) => /out\(`Checked`\)/.test(l)), 'only the TOP hit gets a body, not the second');
  assert.ok(withBody.some((l) => /^■ METHOD run /.test(l)), 'second hit still present as a signature');
  // top hit whose body exceeds the budget → signature only, never a half function
  const big = SAMPLE.replace(
    '  const repoRoot = findRepoRoot(startDir);\n  return { repoRoot, repoId, repoName: repoNameOf(repoId) };',
    Array.from({ length: 80 }, (_, i) => `  const line${i} = compute${i}();`).join('\n'));
  const noBody = declarationLines(big, INJECT_MAX_CHARS, INJECT_SNIPPET_CHARS);
  assert.equal(noBody[0], '■ METHOD repoIdentity @ src/practice/repo-identity.js:91 — repoIdentity(startDir)');
  assert.ok(!noBody.some((l) => /const line40 =/.test(l)), 'oversized body dropped, not truncated');
  assert.ok(renderInjection(SAMPLE)!.length <= INJECT_MAX_CHARS, 'still capped with a body');
});

// What `explore createWorktree` actually returned in this repo (the `call` hit and the empty callers line are real).
const WORKTREE = `6 match(es) for "createWorktree". Focus: 2 symbol(s) with callers/callees + source.

■ METHOD createWorktree @ src/server/worktree.ts:33 — createWorktree(fromCwd: string, agent: string): WorktreeInfo
  callers:
  callees: mainRoot@src/server/worktree.ts:20, slug@src/server/worktree.ts:27
  --- source src/server/worktree.ts:33-45 ---
export function createWorktree(fromCwd: string, agent: string): WorktreeInfo {
  const root = mainRoot(fromCwd);
  return { path: dir, branch, mainRoot: root, repo, head: null };
}

■ METHOD call @ src/protocol/client.ts:42 — call(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']>
  callers: connect@src/protocol/client.ts:20
  --- source src/protocol/client.ts:42-50 ---
  call(method, params) { return this.send(method, params); }

other matches:
  METHOD removeWorktree @ src/server/worktree.ts:97
  METHOD mergeWorktree @ src/server/worktree.ts:70
  CLASS MergeResult @ src/server/worktree.ts:68
  METHOD worktreeStatus @ src/server/worktree.ts:61
`;

test('identifierParts / hitRelevant: a hit stays only when its name shares an identifier part with the query', () => {
  assert.deepEqual(identifierParts('createWorktree'), ['create', 'worktree']);
  assert.deepEqual(identifierParts('parse_transcript'), ['parse', 'transcript']);
  assert.deepEqual(identifierParts('config.grepCap'), ['config', 'grep']); // "cap" < 4 chars dropped
  assert.deepEqual(identifierParts('HTTPServer'), ['http', 'server']);
  assert.deepEqual(identifierParts('call'), ['call']); assert.deepEqual(identifierParts('id'), []);
  const q = ['createworktree']; // distillQuery lowercases, so the split has to come from the hit side
  assert.equal(hitRelevant('■ METHOD call @ src/protocol/client.ts:42 — call(method)', q), false);
  assert.equal(hitRelevant('  METHOD mergeWorktree @ src/server/worktree.ts:70', q), true);
  assert.equal(hitRelevant('  CLASS MergeResult @ src/server/worktree.ts:68', q), false);
  assert.equal(hitRelevant('■ METHOD resolveProjectScope @ src/mcp/tool-handlers.js:154 — resolveProjectScope(v)', ['server', 'scoped', 'repository']), true, 'prose query: scoped ~ scope');
  assert.equal(hitRelevant('■ METHOD resolveProjectScope @ x.js:1 — f()', ['server', 'decide']), false);
  assert.equal(hitRelevant('not a hit line', q), false);
});

test('declarationLines with query tokens: empty callers line and unrelated secondary hit dropped, related tail rows kept', () => {
  const lines = declarationLines(WORKTREE, INJECT_MAX_CHARS, INJECT_SNIPPET_CHARS, ['createworktree']);
  assert.equal(lines[0], '■ METHOD createWorktree @ src/server/worktree.ts:33 — createWorktree(fromCwd: string, agent: string): WorktreeInfo');
  assert.ok(lines.some((l) => /^export function createWorktree/.test(l)), 'top-hit body kept');
  assert.ok(!lines.some((l) => /^callers:\s*$/.test(l)), 'empty callers line dropped');
  assert.ok(!lines.some((l) => /METHOD call @/.test(l)), 'unrelated `call` hit dropped');
  assert.ok(!lines.some((l) => /MergeResult/.test(l)), 'MergeResult shares no part with createWorktree');
  assert.ok(lines.some((l) => /METHOD mergeWorktree @/.test(l)) && lines.some((l) => /removeWorktree/.test(l)) && lines.some((l) => /worktreeStatus/.test(l)), 'worktree-named rows kept');
  // without tokens the old behaviour holds (every hit kept), and a "(none in this checkout)" callers line is dropped too
  const old = declarationLines(WORKTREE);
  assert.ok(old.some((l) => /METHOD call @/.test(l)) && old.some((l) => /MergeResult/.test(l)));
  const none = declarationLines(WORKTREE.replace('  callers:\n', '  callers: (none in this checkout)\n'), INJECT_MAX_CHARS, 0, ['createworktree']);
  assert.ok(!none.some((l) => /^callers:/.test(l)));
  const r = renderInjection(WORKTREE, INJECT_MAX_CHARS, INJECT_SNIPPET_CHARS, ['createworktree'])!;
  assert.ok(r.includes('mergeWorktree') && !r.includes('client.ts:42'));
});

test('per-session dedupe: same normalised prompt is injected once', () => {
  const sid = `pi-${process.pid}-${Date.now()}`;
  fs.rmSync(injectedMarker(sid), { force: true });
  assert.equal(promptHash('How does  X work?'), promptHash('how does x work'));
  assert.equal(alreadyInjected(sid, 'how does X work?'), false);
  markInjected(sid, 'how does X work?');
  assert.equal(alreadyInjected(sid, 'HOW does x work'), true);
  assert.equal(alreadyInjected(sid, 'where is Y defined'), false);
  fs.rmSync(injectedMarker(sid), { force: true });
});

test('injectForPrompt: trivial prompt / un-indexed cwd / config off → null, never throws', async () => {
  assert.equal(await injectForPrompt({ prompt: 'ok', cwd: '/', sessionId: 'x' }), null);
  assert.equal(await injectForPrompt({ prompt: 'how does the frobnicate_widget handler deal with retries', cwd: '/', sessionId: 'x' }), null, 'not a repo → null');
  process.env.KORA_PROMPT_INJECT = '0'; require('../config').invalidateConfig();
  try { assert.equal(await injectForPrompt({ prompt: 'how does resolveSymbol handle ambiguous names?', cwd: INDEXED_REPO, sessionId: 'x' }), null, 'config off'); }
  finally { delete process.env.KORA_PROMPT_INJECT; require('../config').invalidateConfig(); }
});

test('hook prompt: code-shaped prompt gets file:line declarations ≤400 tokens, once per session', { skip: !haveStore && 'user store / KoragraphMCP not present' }, async (t) => {
  const sid = `pi-hook-${process.pid}-${Date.now()}`;
  fs.rmSync(injectedMarker(sid), { force: true });
  const io = () => { let out = ''; return { out: (s: string) => { out += s; }, err: () => {}, get stdout() { return out; } }; };
  // The one test that runs a REAL explore against the user's store. A cold store can exceed the production 7 s
  // injection budget; that is a latency property of the store, not a correctness one, so give the test room.
  const prevTimeout = process.env.KORA_INJECT_TIMEOUT_MS; process.env.KORA_INJECT_TIMEOUT_MS = '30000';
  const input = { session_id: sid, cwd: INDEXED_REPO, prompt: 'how does repoIdentity decide the repo id for a checkout?' };
  // This is the one non-hermetic test: it drives a REAL explore against the developer's own ~/.koragraph store,
  // whose size, freshness and concurrent load are outside the test's control (the hermetic injection path is
  // covered by scripts/e2e-fresh.js). Try a few times to ride out a cold/contended store; if it still will not
  // resolve, skip rather than fail — a slow store is not an injection regression.
  let o1 = io(); let ctx = ''; let ms = 0; let injectedOnce = false; let winSid = sid;
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = `${sid}-${attempt}`; fs.rmSync(injectedMarker(a), { force: true });
    o1 = io(); const t0 = Date.now();
    assert.equal(await hookRun(['prompt', '--stdin-json', JSON.stringify({ ...input, session_id: a })], o1), 0);
    ms = Date.now() - t0;
    try { ctx = JSON.parse(o1.stdout || '{}').hookSpecificOutput?.additionalContext || ''; } catch { ctx = ''; }
    if (ctx.includes(INJECT_HEADER)) { injectedOnce = true; winSid = a; break; } // keep this attempt's marker for the re-inject check
    fs.rmSync(injectedMarker(a), { force: true });
  }
  if (!injectedOnce) { if (prevTimeout === undefined) delete process.env.KORA_INJECT_TIMEOUT_MS; else process.env.KORA_INJECT_TIMEOUT_MS = prevTimeout; t.skip('the live ~/.koragraph store did not resolve the explore in time (store load, not an injection regression)'); return; }
  assert.ok(ctx.includes(INJECT_HEADER), 'injected');
  assert.match(ctx, /■ \w+ \S+ @ \S+:\d+/, 'declaration lines with file:line');
  assert.ok(!/--- source/.test(ctx), 'no raw --- source marker (a top-hit body may be inlined, but capped)');
  // The injection block is HEADER…TRAILER; other hook sections (once-per-session laws/memory) follow it, so
  // measure just the injection.
  const injected = ctx.slice(ctx.indexOf(INJECT_HEADER), ctx.indexOf(INJECT_TRAILER) + INJECT_TRAILER.length);
  assert.ok(injected.length <= INJECT_MAX_CHARS, `≤400 tokens (${injected.length} chars)`);
  assert.ok(ms < 30000, `within the (test-raised) deadline (${ms} ms)`); // warm it is ~200 ms; cold on a huge store can be seconds
  const o2 = io();
  assert.equal(await hookRun(['prompt', '--stdin-json', JSON.stringify({ ...input, session_id: winSid })], o2), 0);
  assert.ok(!o2.stdout.includes(INJECT_HEADER), 'same prompt again → not injected');
  fs.rmSync(injectedMarker(winSid), { force: true });
  if (prevTimeout === undefined) delete process.env.KORA_INJECT_TIMEOUT_MS; else process.env.KORA_INJECT_TIMEOUT_MS = prevTimeout;
});

import { looksTextHunt, topHitRelevant, distillQuery, looksStatement, proseQualifies, questionClauses, isPathHint, renderFileSymbols, pickFuzzy, hitNames, WALK_RE, EDIT_RE, dropShown, markShown, shownDecls, shownMarker } from './prompt-inject';
test('text hunts are grep\'s job: no injection for "every place the string X appears" / renames / help text', () => {
  assert.equal(looksTextHunt('List every place the string practice.db appears in code comments, docs or help text. file:line each.'), true);
  assert.equal(looksCodeShaped('List every place the string practice.db appears in code comments, docs or help text. file:line each.'), false);
  assert.equal(looksTextHunt('Rename graphStaleness to graphFreshness everywhere'), true);
  assert.equal(looksTextHunt('how does ensureFilesFresh decide a file is stale'), false);
  assert.equal(looksCodeShaped('Who calls resolveProjectScope, and what does each caller pass?'), true);
  assert.deepEqual(distillQuery('I want graphStaleness() to also return an ageMs field').idents, ['graphStaleness', 'ageMs']);
});
test('topHitRelevant: the first ■ hit must be about the query', () => {
  const text = '■ METHOD query @ src/db/sqlite-pool.js:371 — query(text)\n■ METHOD graphStaleness @ src/services/graph-staleness.js:52 — graphStaleness(deps)';
  assert.equal(topHitRelevant(text, ['graphstaleness', 'agems']), false);
  assert.equal(topHitRelevant('■ METHOD graphStaleness @ src/x.js:1 — graphStaleness()', ['graphstaleness']), true);
});

test('renderInjection: a PARTIAL (lexical channel timed out) result is kept when the top hit IS the named identifier, dropped otherwise', () => {
  const partial = '25 match(es) for "injectForPrompt" — PARTIAL: the lexical channel(s) did not answer, so this is incomplete, not empty. Focus: 1 symbol(s).\n\n■ METHOD injectForPrompt @ src/graph/prompt-inject.ts:195 — injectForPrompt(opts)\n  callers: prompt@src/cli/commands/hook.ts:220\n';
  assert.equal(renderInjection(partial, 1600, 0, ['injectforprompt']), null, 'no identifier named → degrade guard holds');
  const kept = renderInjection(partial, 1600, 0, ['injectforprompt'], ['injectForPrompt']);
  assert.ok(kept && kept.includes('■ METHOD injectForPrompt'), 'exact top hit survives the PARTIAL flag');
  assert.equal(renderInjection(partial, 1600, 0, ['injectforprompt'], ['somethingElse']), null, 'a different identifier does not rescue it');
  const partialOther = partial.replace('■ METHOD injectForPrompt', '■ METHOD query');
  assert.equal(renderInjection(partialOther, 1600, 0, ['injectforprompt'], ['injectForPrompt']), null, 'top hit is a stranger → still dropped');
});

// Precision rules measured on 48 real meridian prompts (scripts/inject-replay.js): each case below was a wrong
// injection (~300 tokens re-billed per later turn) or a wasted explore before the rule existed.
test('statements, rules, deferrals and orchestrator boots are not questions', () => {
  for (const p of ['Important: we do NOT use JWTs anywhere in meridian - auth is server-side session cookies. Keep that straight going forward.',
    'Your response above was cut off mid-stream. Resume directly from where it stops — no apology, no recap.',
    'From now on, no new npm dependencies get added to meridian_api without review - note that policy.',
    "Let's hold off on refactoring resolveAndWriteEdges until after the beta demo — note it for later, not now.",
    'You are now the ORCHESTRATOR for this fleet. Your own pane id is p13 — use it as `--orchestrator p13` when you spawn.',
    'Standing rule for this codebase: all monetary values must be stored as integer cents, never floats.']) assert.equal(looksStatement(p), true, p);
  assert.equal(looksStatement('How does resolveSymbol handle ambiguous names?'), false);
  assert.equal(looksStatement('Trace how a user authenticates, with file references.'), false);
});
test('prose prompts need a structural cue and must not be size/count/framework questions', () => {
  assert.equal(proseQualifies('Roughly how large is the meridian_api codebase?'), false);
  assert.equal(proseQualifies('Count how many test files exist under meridian_api.'), false);
  // small talk about the work is not a code question (2026-10-20: "how is it going" injected a spreadsheet PRODUCT())
  assert.equal(proseQualifies('test the working of the product, how is it going, how good is it. everything'), false);
  assert.equal(proseQualifies('how is the launch looking?'), false);
  assert.equal(proseQualifies('how is the session token refreshed?'), true);
  assert.equal(proseQualifies('Is meridian_api using Express or Fastify? One word.'), false);
  assert.equal(proseQualifies("What's the difference in purpose between meridian_api and meridian_site?"), false);
  assert.equal(proseQualifies('What test runner does this project use?'), false);
  assert.equal(proseQualifies('Trace how a user authenticates, with file references.'), true);
  assert.equal(proseQualifies('briefly explain how the ingest pipeline works in meridian, with a file:line reference'), true);
  assert.equal(proseQualifies("what's the entry point for edge resolution in meridian? just explain briefly"), true);
  assert.equal(proseQualifies('how are stale files caught up before a query runs'), true);
  assert.equal(proseQualifies('Explain how incremental re-indexing works: how old nodes are replaced.'), true, '"how old nodes" is not an age question');
  assert.equal(proseQualifies('How old is this codebase?'), false);
});
test('questionClauses keeps the sentence that asks, drops the preamble', () => {
  const p = "compliance sent this over: 'all PII must be redacted before it hits logs'. anyway, check how logging works in meridian";
  assert.equal(questionClauses(p), 'anyway, check how logging works in meridian');
  assert.equal(questionClauses('How does X work?'), 'How does X work?');
});
test('file and directory names in a prompt are path hints, not symbols', () => {
  assert.equal(isPathHint('orchestrator.md'), true);
  assert.equal(isPathHint('audit.js'), true);
  assert.equal(isPathHint('resolveSymbol'), false);
  assert.equal(isPathHint('practice.db'), false, 'a dotted name with an unknown extension stays a symbol candidate');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-ph-')); fs.mkdirSync(path.join(dir, 'meridian_api'));
  assert.equal(isPathHint('meridian_api', dir), true, 'an existing directory under cwd');
  assert.equal(isPathHint('graph_staleness', dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renderInjection: degrade markers count only on the header line, never inside a pasted source body', () => {
  const text = '3 match(es) for "renderInjection". Focus: 1 symbol(s).\n\n■ METHOD renderInjection @ src/graph/prompt-inject.ts:226 — renderInjection(text)\n  --- source src/graph/prompt-inject.ts:226-236 ---\n  if (/NO DECLARATION NAMED/.test(header)) return null;\n  if (/PARTIAL:/.test(header)) {\n';
  const out = renderInjection(text, 1600, 900, ['renderinjection'], ['renderInjection']);
  assert.ok(out && out.includes('■ METHOD renderInjection'), 'a body quoting the markers must not trigger the guard');
  assert.equal(renderInjection('NO DECLARATION NAMED foo in this repository\n', 1600, 0, ['foo']), null);
});

test('a prompt that already carries an injection block is never injected again', async () => {
  const txt = await injectForPrompt({ prompt: `${INJECT_HEADER}\n■ METHOD foo @ a.ts:1 — foo()\n\nhow does fooBar work?`, cwd: process.cwd(), sessionId: 'carry-' + Date.now() });
  assert.equal(txt, null);
});

test('distillQuery: Class.method asks the graph for the method, keeps the class as a relevance token', () => {
  const d = distillQuery('Using the code graph, explain how SessionManager.buildDriver decides which driver to construct.');
  assert.equal(d.query, 'buildDriver');
  assert.deepEqual(d.idents, ['buildDriver']);
  assert.ok(d.tokens.includes('sessionmanager') && d.tokens.includes('builddriver'));
  assert.equal(distillQuery('what does config.grepCap do').query, 'config.grepCap', 'lowercase.dotted (a value path) is left alone');
});

test('renderFileSymbols: a compact name:line list, node builtins dropped, capped', () => {
  const txt = '24 symbol(s) in src/cli/status.js\n  src/cli/status.js: METHOD reportSecondLayer:330, METHOD run:256, CONSTANT USAGE:22, CONSTANT path:5, CONSTANT fs:3, FILE src/cli/status.js:1';
  const out = renderFileSymbols('src/cli/status.js', txt)!;
  assert.ok(out.startsWith('File src/cli/status.js — declarations (name:line): reportSecondLayer:330, run:256, constant USAGE:22'), out);
  assert.ok(!out.includes('path:5') && !out.includes('FILE '), 'builtins and the FILE row are noise');
  assert.equal(renderFileSymbols('other.js', txt), null);
});
test('a prompt naming a file gets that file\'s declaration list even when no symbol resolves', async () => {
  process.env.KORA_INJECT_LOG = '0';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-fh-')); fs.mkdirSync(path.join(dir, 'src/cli'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src/cli/status.js'), '// x');
  const calls: string[] = [];
  const graph = { status: async () => ({ indexed: true, repoRoot: dir }), callTool: async (name: string, args: any) => { calls.push(name); return name === 'file_symbols' ? { text: `3 symbol(s) in ${args.path}\n  ${args.path}: METHOD run:256, METHOD parse:35, CONSTANT USAGE:22` } : { text: 'NO DECLARATION NAMED foo' }; } };
  const txt = await injectForPrompt({ prompt: 'Add a --json flag to the status command in src/cli/status.js following the conventions the other commands use.', cwd: dir, sessionId: 'fh-' + Date.now(), graph: graph as any });
  assert.ok(txt && txt.includes('File src/cli/status.js — declarations (name:line): run:256, parse:35'), String(txt));
  assert.ok(calls.includes('file_symbols'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pickFuzzy: near-tied candidates explaining different words are a coin flip → nothing; a clear winner or an extending runner-up is fine', () => {
  assert.deepEqual(pickFuzzy([{ name: 'detectRepoType', score: 2.417, matched: ['repository', 'detected'] }, { name: 'indexedRepos', score: 2.3, matched: ['indexing', 'repository'] }, { name: 'commitExtractedNodes', score: 2.167, matched: ['extracted', 'nodes'] }]), []);
  assert.deepEqual(pickFuzzy([{ name: 'callTool', score: 3, matched: ['tool', 'call'] }, { name: 'serverRepoId', score: 2.35, matched: ['server', 'repository'] }]), ['callTool', 'serverRepoId']);
  assert.deepEqual(pickFuzzy([{ name: 'authenticate', score: 1.9, matched: ['authenticates'] }, { name: 'authenticateJwt', score: 1.9, matched: ['authenticates'] }, { name: 'authenticateApiKey', score: 1.9, matched: ['authenticates'] }]), ['authenticate']);
  assert.deepEqual(pickFuzzy([{ name: 'a', score: 2, matched: ['x', 'y'] }, { name: 'b', score: 1.9, matched: ['x', 'y'] }]), ['a', 'b'], 'same evidence → agreement');
  assert.deepEqual(pickFuzzy([]), []);
});

test('prose fallback: the first RANKED hit that explains the prompt wins, not only the top one', async () => {
  process.env.KORA_INJECT_LOG = '0';
  assert.deepEqual(hitNames('x\n■ METHOD nodeSourceStem @ a.js:1 — f()\n■ METHOD runIncrementalIngest @ b.js:2 — g()\n  callers: none\n■ METHOD nodeSourceStem @ a.js:1'), ['nodeSourceStem', 'runIncrementalIngest']);
  const texts: Record<string, string> = {
    'incremental indexing works detected extracted nodes': '5 match(es).\n\n■ METHOD nodeSourceStem @ src/x.js:54 — nodeSourceStem(row)\n■ METHOD runIncrementalIngest @ src/services/ingest.js:5906 — runIncrementalIngest({ repoPath })\n',
    'runIncrementalIngest': '1 match.\n\n■ METHOD runIncrementalIngest @ src/services/ingest.js:5906 — runIncrementalIngest({ repoPath })\n  callers: ingestAll@src/cli/ingest.js:287\n',
  };
  const calls: string[] = [];
  const graph = { status: async () => ({ indexed: true, repoRoot: null }), callTool: async (_n: string, a: any) => { calls.push(a.query); return { text: texts[a.query] || 'NO DECLARATION NAMED ' + a.query }; } };
  const txt = await injectForPrompt({ prompt: 'Explain how incremental re-indexing works: how a changed file is detected, what gets re-extracted, and how old nodes are replaced.', cwd: '/nope', sessionId: 'rank-' + Date.now(), graph: graph as any, fileHints: false });
  assert.ok(txt && txt.includes('■ METHOD runIncrementalIngest'), String(txt));
  assert.ok(!txt!.includes('nodeSourceStem'), 'the stranger is not injected');
  assert.ok(calls.includes('runIncrementalIngest'), 'asked for the winner by name');
});

test('a walk-through prompt keeps the top hit\'s callees line; a plain lookup does not', () => {
  const text = '2 match(es).\n\n■ METHOD callTool @ src/mcp/protocol.js:10 — callTool(name, args, deps)\n  callers: handleMessage@src/mcp/protocol.js:40\n  callees: resolveProjectScope@src/mcp/tool-handlers.js:200, serverRepoId@src/mcp/tool-handlers.js:120\n';
  const walk = renderInjection(text, 1600, 0, ['calltool'], ['callTool'], { callees: true })!;
  assert.ok(walk.includes('callees: resolveProjectScope@'), walk);
  const plain = renderInjection(text, 1600, 0, ['calltool'], ['callTool'])!;
  assert.ok(!plain.includes('callees:'), plain);
  assert.equal(WALK_RE.test('How does the MCP server decide which repository a tool call is scoped to? Walk through it with the functions involved.'), true);
  assert.equal(WALK_RE.test('Explain how incremental re-indexing works in this repository'), true);
  assert.equal(WALK_RE.test('Who calls resolveSymbol? file:line for each call site.'), false);
  assert.equal(WALK_RE.test('what does createWorktree do'), false);
});

test('declarations already shown to a session are not re-injected; a wholly repeated block is skipped', () => {
  const sid = 'shown-' + Date.now(); fs.rmSync(shownMarker(sid), { force: true });
  const block = [INJECT_HEADER, '■ METHOD foo @ a.ts:1 — foo()', '  callers: bar@b.ts:2', '■ METHOD baz @ c.ts:3 — baz()', INJECT_TRAILER].join('\n');
  assert.equal(dropShown(block, new Set()), block, 'nothing shown yet → unchanged');
  markShown(sid, block);
  assert.deepEqual([...shownDecls(sid)], ['■ METHOD foo @ a.ts:1 — foo()', '■ METHOD baz @ c.ts:3 — baz()']);
  const later = [INJECT_HEADER, '■ METHOD foo @ a.ts:1 — foo()', '  callers: bar@b.ts:2', '■ METHOD qux @ d.ts:4 — qux()', INJECT_TRAILER].join('\n');
  const trimmed = dropShown(later, shownDecls(sid))!;
  assert.ok(trimmed.includes('■ METHOD qux') && !trimmed.includes('■ METHOD foo') && !trimmed.includes('callers: bar'), trimmed);
  assert.equal(dropShown(block, shownDecls(sid)), null, 'all repeats → nothing to inject');
  fs.rmSync(shownMarker(sid), { force: true });
});


test('edit-shaped and walk-through prompts get lean injections (no body); an exact lookup keeps the body', async () => {
  process.env.KORA_INJECT_LOG = '0';
  assert.equal(EDIT_RE.test('Add a `--json` flag to the `koragraph status` CLI command (src/cli/status.js)'), true);
  assert.equal(EDIT_RE.test('Now make that change: add ageMs to what graphStaleness() returns. Minimal diff. Do not run tests.'), true);
  assert.equal(EDIT_RE.test('what does graphStaleness do'), false);
  assert.equal(EDIT_RE.test('Who calls resolveSymbol? file:line for each call site.'), false);
  const body = Array.from({ length: 8 }, (_, i) => `  const line${i} = ${i};`).join('\n');
  const text = `1 match.\n\n■ METHOD graphStaleness @ src/services/graph-staleness.js:52 — graphStaleness()\n  callers: stalenessOf@src/mcp/tool-handlers.js:296\n  --- source src/services/graph-staleness.js:52-60 ---\nasync function graphStaleness() {\n${body}\n}\n`;
  const graph = { status: async () => ({ indexed: true, repoRoot: null }), callTool: async () => ({ text }) };
  const edit = await injectForPrompt({ prompt: 'Now make that change: add ageMs to what graphStaleness() returns. Minimal diff. Do not run tests.', cwd: '/nope', sessionId: 'lean-' + Date.now(), graph: graph as any, fileHints: false });
  assert.ok(edit && edit.includes('■ METHOD graphStaleness') && !edit.includes('const line0'), String(edit));
  const lookup = await injectForPrompt({ prompt: 'what does graphStaleness do', cwd: '/nope', sessionId: 'lean2-' + Date.now(), graph: graph as any, fileHints: false });
  assert.ok(lookup && lookup.includes('const line0'), 'exact lookup keeps the body: ' + String(lookup));
});

test('a walk-through whose fuzzy winner is carried only by generic words is not injected; a real-word winner is', async () => {
  process.env.KORA_INJECT_LOG = '0';
  const { fuzzyFind, GENERIC_WORDS } = require('./fuzzy');
  assert.ok(GENERIC_WORDS.has('tool') && GENERIC_WORDS.has('call') && !GENERIC_WORDS.has('pipeline'));
  const hits = fuzzyFind(['server', 'repository', 'tool', 'call', 'scoped'], [{ name: 'callTool', parts: ['call', 'tool'] }, { name: 'serverRepoId', parts: ['server', 'repo'] }]);
  const ct = hits.find((h: any) => h.name === 'callTool'); assert.ok(ct && ct.matched.every((w: string) => GENERIC_WORDS.has(w)), 'callTool is carried by generic words only');
  assert.equal(hits[0].name, 'serverRepoId', 'and no longer wins against a real-word match');
  assert.deepEqual(hits[0].strong, [], 'serverRepoId ← repository→repo is a prefix match: not strong enough for a walk-through');
  const hits2 = fuzzyFind(['ingest', 'pipeline'], [{ name: 'runPipeline', parts: ['pipeline'] }]);
  assert.equal(hits2[0].name, 'runPipeline'); assert.deepEqual(hits2[0].strong, ['pipeline'], 'an exact real-word match is strong');
  assert.deepEqual(fuzzyFind(['trace', 'user', 'authenticates'], [{ name: 'authenticate', parts: ['authenticate'] }])[0].strong, ['authenticates'], 'a stem match is strong');
  // end to end: the m1 walk-through gets nothing; a walk-through with a strong subject gets its declaration
  const srv = '1 match.\n\n■ METHOD serverRepoId @ src/mcp/tool-handlers.js:120 — serverRepoId(deps)\n';
  // the ambiguity rule (callTool vs serverRepoId, different words, within 20%) routes m1 to the lexical explore of the
  // distilled query — which also answers serverRepoId — so the bar must hold on that path too
  const texts: Record<string, string> = { 'serverRepoId': srv, 'server scoped': srv, 'runPipeline': '1 match.\n\n■ METHOD runPipeline @ src/ingest/pipeline.js:10 — runPipeline(repo)\n', 'ingest pipeline': '1 match.\n\n■ METHOD runPipeline @ src/ingest/pipeline.js:10 — runPipeline(repo)\n' };
  const graph = { status: async () => ({ indexed: true, repoRoot: null }), callTool: async (_n: string, a: any) => ({ text: texts[a.query] || 'NO DECLARATION NAMED x' }) };
  const symbols = [{ name: 'serverRepoId', parts: ['server', 'repo', 'id'] }, { name: 'callTool', parts: ['call', 'tool'] }, { name: 'runPipeline', parts: ['run', 'pipeline'] }];
  const fz = require('./fuzzy'); const orig = fz.fuzzyForPrompt; fz.fuzzyForPrompt = (p: string) => fz.fuzzyFind(fz.fuzzyWords(p), symbols);
  try {
    const m1 = await injectForPrompt({ prompt: 'How does the MCP server decide which repository a tool call is scoped to? Walk through it with the functions involved and file:line.', cwd: '/nope', sessionId: 'walk-' + Date.now(), graph: { ...graph, status: async () => ({ indexed: true, repoRoot: '/nope' }) } as any, fileHints: false });
    assert.equal(m1, null); assert.equal(require('./prompt-inject').lastInjectRecord.query, 'walk-through-weak-match');
    const ok = await injectForPrompt({ prompt: 'briefly explain how the ingest pipeline works, with a file:line reference', cwd: '/nope', sessionId: 'walk2-' + Date.now(), graph: { ...graph, status: async () => ({ indexed: true, repoRoot: '/nope' }) } as any, fileHints: false });
    assert.ok(ok && ok.includes('■ METHOD runPipeline'), String(ok));
  } finally { fz.fuzzyForPrompt = orig; }
});

test('recordInject creates inject.jsonl with mode 0o600', () => {
  const { recordInject, injectLogPath } = require('./prompt-inject');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-inject-test-'));
  const origHome = process.env.KORA_HOME;
  const origLog = process.env.KORA_INJECT_LOG;
  try {
    process.env.KORA_HOME = tmp;
    delete process.env.KORA_INJECT_LOG;
    const rec = { ts: new Date().toISOString(), lane: 'cli', sessionId: 's1', prompt: 'test prompt', query: 'test', hits: 1, chars: 10, ms: 5, action: 'injected', symbols: ['foo'] };
    recordInject(rec);
    const p = injectLogPath();
    assert.ok(fs.existsSync(p));
    if (process.platform !== 'win32') {
      const mode = fs.statSync(p).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    if (origHome !== undefined) process.env.KORA_HOME = origHome; else delete process.env.KORA_HOME;
    if (origLog !== undefined) process.env.KORA_INJECT_LOG = origLog; else delete process.env.KORA_INJECT_LOG;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

