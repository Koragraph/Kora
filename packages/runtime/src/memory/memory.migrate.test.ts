import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, SCHEMA_VERSION } from './db';
import { openMemory } from './index';
import { fakeExtractor, ops } from './testkit';

test('opens a v1 database, upgrades it in place, and keeps its data searchable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-mig-'));
  try {
    const path = join(dir, 'memory.db');
    const old = new DatabaseSync(path);
    applyMigrations(old, 1);
    assert.equal(Number((old.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), 1);
    old.prepare("INSERT INTO facts(id, scope, blob_id, text, since, confidence, created_at, last_used_at) VALUES('f_old','you',NULL,'Drinks green tea every morning.',1000,0.8,1000,1000)").run();
    old.prepare("INSERT INTO facts(id, scope, blob_id, text, since, confidence, created_at, last_used_at) VALUES('f_priv','blob','popo','Keeps drafts in Notion.',1000,0.8,1000,1000)").run();
    old.prepare("INSERT INTO core(scope, blob_id, text, updated_at) VALUES('you','','- Name is Dana',1000)").run();
    old.prepare("INSERT INTO episodes(id, thread_id, blob_id, summary, created_at) VALUES('e1','t1','popo','Planned the launch newsletter.',1000)").run();
    old.close();

    let now = 1_700_000_000_000;
    const mem = openMemory({ dbPath: path, extractor: fakeExtractor(() => ops()), now: () => now });
    assert.equal(mem.stats().schemaVersion, SCHEMA_VERSION);
    const f = mem.getFact('f_old')!;
    assert.equal(f.important, false);
    assert.equal(f.useCount, 0);
    assert.equal(mem.getCore('popo').you, '- Name is Dana');
    assert.equal(mem.searchFacts({ blobId: 'popo', query: 'green tea' })[0].id, 'f_old');
    assert.equal(mem.searchFacts({ blobId: 'bobble', query: 'drafts Notion' }).length, 0, 'private v1 fact stays private');
    assert.equal(mem.searchEpisodes({ blobId: 'popo', query: 'newsletter' }).length, 1);
    // the upgraded db accepts new-style writes
    await mem.addFact({ scope: 'you', text: 'Likes hiking.', important: true });
    assert.equal(mem.stats().facts.active, 3);
    mem.close();
    // reopen: already current, no-op
    const again = openMemory({ dbPath: path, extractor: fakeExtractor(() => ops()), now: () => now });
    assert.equal(again.stats().facts.active, 3);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a database from a newer build instead of mangling it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-new-'));
  try {
    const path = join(dir, 'memory.db');
    const d = new DatabaseSync(path);
    d.exec('PRAGMA user_version = 99');
    d.close();
    assert.throws(() => openMemory({ dbPath: path, extractor: fakeExtractor(() => ops()) }), /newer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
