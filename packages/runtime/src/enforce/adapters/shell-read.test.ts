import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blockBody, SHELL_READ_LINE, type AdapterCtx } from './types';
import { codexAdapter } from './codex';
import { geminiAdapter, genericAdapter, opencodeAdapter } from './others';

const ctxFor = (root: string, extra: Partial<AdapterCtx> = {}) => ({ root, brief: null, binPath: '/x/kora.js', nodeBin: process.execPath, create: true, indexed: true, ...extra }) as AdapterCtx;

test('shell-reading agents (Codex, Gemini, generic/Antigravity) get the sed -n read-range line; agents with a ranged Read tool do not need it', () => {
  const ctx = ctxFor('/r');
  assert.doesNotMatch(blockBody(ctx, false), /sed -n/);
  assert.match(blockBody(ctx, false, { shell: true }), /sed -n/);
  assert.match(blockBody(ctxFor('/r', { indexed: false }), false, { shell: true }), /sed -n/, 'also in the no-graph rulebook');
  assert.ok(SHELL_READ_LINE.length < 300, 'one short line');
  const blockOf = (file: string) => fs.readFileSync(file, 'utf8');
  for (const [adapter, file, want] of [[codexAdapter, 'AGENTS.md', true], [geminiAdapter, 'GEMINI.md', true], [genericAdapter('antigravity', 'agy'), 'AGENTS.md', true], [opencodeAdapter, 'AGENTS.md', false]] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-shell-'));
    fs.writeFileSync(path.join(dir, file), '# mine\n');
    // install writes the managed block (some adapters also write MCP config: scoped to the temp repo / KORA_HOME)
    try { adapter.install(ctxFor(dir)); } catch { /* MCP config side is not under test */ }
    const text = blockOf(path.join(dir, file));
    assert.equal(/sed -n/.test(text), want, `${adapter.id}: ${file}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex pane gets the output cap and the earlier auto-compact unless the user set them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-codexpane-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-codexhome-'));
  const prev = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  try {
    const d = codexAdapter.prepare({ args: ['--foo'] } as any, ctxFor(dir, { readOnly: true }));
    assert.ok(d.args.includes('tool_output_token_limit=10000') && d.args.includes('model_auto_compact_token_limit=150000'), d.args.join(' '));
    assert.equal(d.args[0], '--foo');
    fs.writeFileSync(path.join(home, 'config.toml'), 'tool_output_token_limit = 3000\n');
    const d2 = codexAdapter.prepare({ args: [] } as any, ctxFor(dir, { readOnly: true }));
    assert.ok(!d2.args.includes('tool_output_token_limit=10000') && d2.args.includes('model_auto_compact_token_limit=150000'));
    process.env.KORA_CODEX_SAVINGS = '0';
    const d3 = codexAdapter.prepare({ args: [] } as any, ctxFor(dir, { readOnly: true }));
    assert.ok(!d3.args.some((a) => /token_limit/.test(a)));
  } finally { delete process.env.KORA_CODEX_SAVINGS; if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev; fs.rmSync(dir, { recursive: true, force: true }); }
});
