// A file-scoped graph call must not wait on ANOTHER process's ingest lock. koragraph's synchronous per-file
// catch-up polls that lock for up to 10 min; measured 65 s for one `neighbours --file` while a stray ingest held it.
// Real store (temp), real fixture repo, a real second process holding the lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

test('neighbours --file on a dirty file answers promptly while another process holds the ingest lock', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-freshbound-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/pricing.js'), 'export function computeTotalPrice(items) {\n  return items.length;\n}\n');
  fs.writeFileSync(path.join(repo, 'src/cart.js'), "import { computeTotalPrice } from './pricing.js';\nexport const checkout = (i) => computeTotalPrice(i);\n");
  for (const a of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-qm', 'i']]) assert.equal(spawnSync('git', a, { cwd: repo }).status, 0);
  const kgBin = path.resolve(__dirname, '..', '..', 'koragraph', 'bin', 'koragraph.js');
  const ing = spawnSync(process.execPath, [kgBin, 'ingest', repo, '--no-hooks'], { encoding: 'utf8', env: process.env });
  assert.equal(ing.status, 0, ing.stderr);

  const lockMod = path.resolve(__dirname, '..', '..', 'koragraph', 'src', 'services', 'ingest-lock.js');
  const holder = spawn(process.execPath, ['-e', `const l=require(${JSON.stringify(lockMod)}).tryAcquire(${JSON.stringify(repo)});process.stdout.write(l?'held\\n':'no\\n');setTimeout(()=>{l&&l.release();process.exit(0)},90000)`], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
  try {
    await new Promise<void>((resolve, reject) => { holder.stdout!.once('data', (d) => (String(d).startsWith('held') ? resolve() : reject(new Error('lock not taken')))); });
    fs.appendFileSync(path.join(repo, 'src/pricing.js'), '// edited\n');
    const { createGraphService } = require('./index');
    const g = createGraphService();
    await g.callTool('neighbours', { symbol: 'computeTotalPrice' }, { cwd: repo, fresh: false }).catch(() => null); // load modules, warm the store
    const t0 = Date.now();
    await g.callTool('neighbours', { symbol: 'computeTotalPrice', file: 'src/pricing.js' }, { cwd: repo, fresh: true }).catch(() => null);
    const ms = Date.now() - t0;
    // Unbounded, this waits for the holder (90 s). Bounded, it is ~0.3 s idle; 20 s leaves room for a loaded CI box.
    assert.ok(ms < 20_000, `answered in ${ms} ms (must not wait for the other process's ingest)`);
  } finally { holder.kill(); }
});
