import test from 'node:test';
import assert from 'node:assert/strict';
import { stem, dice, wordSim, fuzzyWords, fuzzyFind, symbolQualifies, SymbolEntry } from './fuzzy';
import { identifierParts } from './prompt-inject';

const sym = (...names: string[]): SymbolEntry[] => names.map((name) => ({ name, parts: identifierParts(name) }));

test('fuzzy: stem / dice / wordSim behave', () => {
  assert.equal(stem('scoped'), 'scop'); assert.equal(stem('scope'), 'scope'); assert.equal(stem('repositories'), 'repository'); assert.equal(stem('calls'), 'call'); assert.equal(stem('values'), 'value'); assert.equal(stem('matches'), 'match');
  assert.ok(dice('repository', 'repositry') > 0.7); assert.equal(dice('abc', 'xyz'), 0);
  assert.equal(wordSim('server', 'server'), 1);
  assert.equal(wordSim('scoped', 'scope'), 0.85, 'prefix beats the crude stem here');
  assert.equal(wordSim('repository', 'repo'), 0.85);
  assert.equal(wordSim('value', 'values'), 0.9, 'same stem');
  assert.equal(wordSim('tool', 'pool'), 0, 'one-letter difference on a 4-char word is not a match');
});
test('fuzzy: the vague bench prompt resolves to the symbols that answer it', () => {
  const words = fuzzyWords('How does the MCP server decide which repository a tool call is scoped to? Walk through it with the functions involved and file:line. Under 250 words.');
  assert.deepEqual(words, ['mcp', 'server', 'repository', 'tool', 'call', 'scoped']);
  const hits = fuzzyFind(words, sym('callTool', 'serverRepoId', 'resolveProjectScope', 'findKoragraphServerEnv', 'query', 'value', 'toolValue'));
  // 'tool' and 'call' are generic (half a vote each): serverRepoId, carried by 'repository', now outranks callTool,
  // which stays a candidate through the full-coverage exception — both are still what the graph is asked about
  assert.deepEqual(hits.slice(0, 2).map((h) => h.name).sort(), ['callTool', 'serverRepoId'].sort(), 'two matched words each; these two are what the graph is asked about');
  assert.equal(hits[0].name, 'serverRepoId', 'a real word outranks two generic ones');
  assert.ok(!hits.some((h) => h.name === 'findKoragraphServerEnv'), 'one generic word ("server") on a long name does not qualify');
  assert.ok(!hits.some((h) => h.name === 'toolValue'), '"tool" alone is one short word');
});
test('fuzzy: a single common word never picks a winner; a long near-exact one does', () => {
  assert.deepEqual(fuzzyFind(['value'], sym('value', 'getValue', 'valueOf')), []);
  assert.deepEqual(fuzzyFind(['staleness'], sym('graphStaleness', 'query')).map((h) => h.name), ['graphStaleness']);
  assert.equal(symbolQualifies('query', fuzzyWords('how are stale files caught up before a query runs')), false, 'one five-letter word cannot carry a prose injection');
  assert.equal(symbolQualifies('writeLexicalChunksIfStored', fuzzyWords('where do we write the per-file lexical chunks during ingest')), true);
  assert.equal(symbolQualifies('ConfirmCard', fuzzyWords('where is the swarm worker state confirmed before swarm logic reads it?')), false, 'a stem match on half a name is not evidence');
  assert.equal(symbolQualifies('authenticate', fuzzyWords('trace how a user authenticates')), true, 'a stem match on the whole name still is');
});
