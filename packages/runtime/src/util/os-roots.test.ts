// Cross-platform path helpers (docs/windows/AUDIT.md). Windows forms are tested from any OS via the platform argument.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnderDir, pathTail, expandTilde } from './os-roots';
import { looksLikePath } from '../session/blob-policy';

test('isUnderDir: POSIX keeps the plain / prefix test', () => {
  assert.equal(isUnderDir('/r/wt', '/r/wt', 'darwin'), true);
  assert.equal(isUnderDir('/r/wt/src/a.ts', '/r/wt/', 'darwin'), true);
  assert.equal(isUnderDir('/r/wt2/a.ts', '/r/wt', 'darwin'), false);
  assert.equal(isUnderDir('C:\\r\\wt\\a.ts', 'C:\\r\\wt', 'darwin'), false);
});

test('isUnderDir: Windows takes either separator and folds case', () => {
  assert.equal(isUnderDir('C:\\Kora\\WT\\src\\a.ts', 'c:/kora/wt', 'win32'), true);
  assert.equal(isUnderDir('C:/kora/wt', 'C:\\kora\\wt\\', 'win32'), true);
  assert.equal(isUnderDir('C:\\kora\\wt2\\a.ts', 'C:\\kora\\wt', 'win32'), false);
  assert.equal(isUnderDir('D:\\kora\\wt\\a.ts', 'C:\\kora\\wt', 'win32'), false);
  assert.equal(isUnderDir('src\\a.ts', 'C:\\kora\\wt', 'win32'), false);
});

test('pathTail: display tails use / on every OS', () => {
  assert.equal(pathTail('/a/src/foo.ts', 2, 'darwin'), 'src/foo.ts');
  assert.equal(pathTail('/a/src/foo.ts', 1, 'darwin'), 'foo.ts');
  assert.equal(pathTail('a\\b.ts', 1, 'darwin'), 'a\\b.ts');
  assert.equal(pathTail('C:\\a\\src\\foo.ts', 2, 'win32'), 'src/foo.ts');
  assert.equal(pathTail('C:\\a\\src/foo.ts', 1, 'win32'), 'foo.ts');
});

test('expandTilde: ~ and ~/x; ~\\x only on Windows', () => {
  assert.equal(expandTilde('~', '/h', 'darwin'), '/h');
  assert.equal(expandTilde('~/x', '/h', 'darwin'), '/h/x');
  assert.equal(expandTilde('~x', '/h', 'darwin'), '~x');
  assert.equal(expandTilde('~\\x', '/h', 'darwin'), '~\\x');
  assert.equal(expandTilde('~\\x', 'C:\\Users\\me', 'win32'), 'C:\\Users\\me\\x');
  assert.equal(expandTilde('~/x', 'C:\\Users\\$&', 'win32'), 'C:\\Users\\$&/x');
});

test('looksLikePath: Windows drive, UNC and ..\\ forms reach the blob bounds check', () => {
  for (const v of ['/etc/x', '~/x', '..', '../x', 'a/../b']) assert.equal(looksLikePath(v, 'darwin'), true, v);
  for (const v of ['C:\\Users\\me\\notes.txt', 'c:/x', '\\\\srv\\share\\f', '..\\x', 'a\\..\\b']) {
    assert.equal(looksLikePath(v, 'darwin'), false, v);
    assert.equal(looksLikePath(v, 'win32'), true, v);
  }
  for (const v of ['report.docx', '\\section', 'https://x.y/z', 'a..b']) assert.equal(looksLikePath(v, 'win32'), false, v);
});
