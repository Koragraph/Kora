// Refs reach verifyMerge from the CLI, PR heads and a lead's kora_merge_verify call: a ref that git would parse as an
// OPTION is refused before any git runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMerge } from './engine';

const graph = { async callTool() { return { text: '', data: {}, ms: 0 }; } } as any;

test('verifyMerge refuses option-looking refs, bases and targets before running git', async () => {
  const root = '/nonexistent-kora-repo';
  await assert.rejects(verifyMerge(root, [{ kind: 'branch', name: '--upload-pack=touch /tmp/pwn' }, { kind: 'branch', name: 'main' }], graph), /not a plain git ref/);
  await assert.rejects(verifyMerge(root, [{ kind: 'sha', sha: '-c' }, { kind: 'branch', name: 'main' }], graph), /not a plain git ref/);
  await assert.rejects(verifyMerge(root, [{ kind: 'pr', number: 1, head: 'a b' }, { kind: 'branch', name: 'main' }], graph), /not a plain git ref/);
  await assert.rejects(verifyMerge(root, [{ kind: 'branch', name: 'a' }, { kind: 'branch', name: 'b' }], graph, { targetRef: '--orphan=x' }), /refusing target ref/);
  await assert.rejects(verifyMerge(root, [{ kind: 'branch', name: 'a' }, { kind: 'branch', name: 'b' }], graph, { baseRef: '-f' }), /refusing base ref/);
});
