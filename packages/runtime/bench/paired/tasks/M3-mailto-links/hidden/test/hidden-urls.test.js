import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { render } from '../src/index.js';
import { sanitizeUrl } from '../src/renderer/html.js';

test('links may use mailto: and tel:', () => {
  assert.equal(render('[mail me](mailto:a@b.co)'), '<p><a href="mailto:a@b.co">mail me</a></p>\n');
  assert.equal(render('[call](tel:+15551234)'), '<p><a href="tel:+15551234">call</a></p>\n');
  assert.equal(render('[MAIL](MAILTO:A@B.CO)'), '<p><a href="MAILTO:A@B.CO">MAIL</a></p>\n');
});

test('links keep working for http, https and relative URLs', () => {
  assert.equal(render('[a](https://x.y/z?q=1)'), '<p><a href="https://x.y/z?q=1">a</a></p>\n');
  assert.equal(render('[a](http://x.y)'), '<p><a href="http://x.y">a</a></p>\n');
  assert.equal(render('[a](/docs/page.md#top)'), '<p><a href="/docs/page.md#top">a</a></p>\n');
});

test('script-like schemes stay blocked in links, whatever the spelling', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'vbscript:x', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://x.y/f']) {
    assert.equal(render(`[x](<${url}>)`), '<p><a href="#">x</a></p>\n', JSON.stringify(url));
  }
});

test('images do not get the new schemes', () => {
  assert.equal(render('![i](mailto:a@b.co)'), '<p><img src="#" alt="i"></p>\n');
  assert.equal(render('![i](tel:+15551234)'), '<p><img src="#" alt="i"></p>\n');
  assert.equal(render('![i](https://x.y/i.png)'), '<p><img src="https://x.y/i.png" alt="i"></p>\n');
  assert.equal(render('![i](/i.png)'), '<p><img src="/i.png" alt="i"></p>\n');
});

test('sanitizeUrl stays the one place that decides, with the old defaults', () => {
  assert.equal(sanitizeUrl('https://a.b'), 'https://a.b');
  assert.equal(sanitizeUrl('mailto:a@b.co', { allowRelative: false }), '#');
  assert.equal(sanitizeUrl('javascript:alert(1)'), '#');
  assert.equal(sanitizeUrl(''), '#');
});

test('the README describes the allowed schemes', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /mailto/);
  assert.match(readme, /tel/);
});
