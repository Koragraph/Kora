import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/index.js';

test('triple asterisks nest as strong > em in every position', () => {
  assert.equal(render('a ***b*** c'), '<p>a <strong><em>b</em></strong> c</p>\n');
  assert.equal(render('***b***'), '<p><strong><em>b</em></strong></p>\n');
});

test('snake_case words and file names are not emphasis', () => {
  assert.equal(render('see my_file_name.txt and _real_ emphasis'), '<p>see my_file_name.txt and <em>real</em> emphasis</p>\n');
});

test('escaped delimiters are literal', () => {
  assert.equal(render('\\_not\\_ and \\*also not\\*'), '<p>_not_ and *also not*</p>\n');
});

test('intraword asterisks still make emphasis', () => {
  assert.equal(render('a*b*c'), '<p>a<em>b</em>c</p>\n');
});
