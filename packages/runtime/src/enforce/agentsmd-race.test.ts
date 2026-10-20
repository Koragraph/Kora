// Deep audit 2026-10-13 A2-7: two Kora processes refreshing one repo's CLAUDE.md at once (stable + Kora Dev on the same
// repo, a daemon + `kora setup`) wiped the user's own text: a plain write truncates first, the other process read the
// empty file, appended only its block and wrote that back. Reproduced 3/3 before the atomic write.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

test('two processes refreshing the rulebook block of one CLAUDE.md never lose the user\'s text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-mdrace-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, `# My notes\n\nPrecious user text.\n${'x'.repeat(20000)}\n`);
    const mod = path.join(__dirname, 'agentsmd.js');
    const src = `const { upsertBlock } = require(${JSON.stringify(mod)}); for (let i = 0; i < 1500; i++) upsertBlock(${JSON.stringify(file)}, 'brief ' + process.argv[1] + ' ' + i + ' ' + 'y'.repeat(4000), { root: ${JSON.stringify(dir)} });`;
    await Promise.all([0, 1].map((n) => new Promise<void>((resolve, reject) => {
      const c = spawn(process.execPath, ['-e', src, String(n)], { stdio: 'inherit' });
      c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${n} exited ${code}`))));
    })));
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('Precious user text.'), 'the user\'s text survived');
    assert.equal((text.match(/<!-- kora:begin -->/g) || []).length, 1, 'one managed block');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp files left');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
