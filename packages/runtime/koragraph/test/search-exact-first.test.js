const test = require('node:test');
const assert = require('node:assert');
const { exactNameFirst } = require('../src/mcp/tool-handlers');

const n = (name, file) => ({ name, file });
test('search_code: an exact identifier hit comes first and unrelated rows are dropped', () => {
  const nodes = [n('tierDiscount', 'a.js'), n('http', 'h.js'), n('tierFor', 'p.js'), n('cli', 'c.js'), n('config', 'k.js'), n('customerTierFor', 'x.js')];
  const out = exactNameFirst('tierFor', nodes);
  assert.equal(out[0].name, 'tierFor');
  assert.deepEqual(out.map((x) => x.name), ['tierFor', 'customerTierFor']);
});
test('search_code: no exact name -> rows untouched; prose queries untouched', () => {
  const nodes = [n('alpha', 'a'), n('beta', 'b')];
  assert.equal(exactNameFirst('Walk', nodes), nodes);
  assert.equal(exactNameFirst('where is retry logic', nodes), nodes);
});
