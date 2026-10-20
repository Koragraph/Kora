import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/index.js';

test('file names with underscores are not emphasis', () => {
  assert.equal(render('see my_file_name.txt and _real_ emphasis'), '<p>see my_file_name.txt and <em>real</em> emphasis</p>\n');
});
