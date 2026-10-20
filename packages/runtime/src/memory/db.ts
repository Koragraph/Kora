import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Ordered, append-only. migrations[i] upgrades user_version i → i+1. */
export const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  // v1: the original minimal shape (kept so older databases can be opened and upgraded)
  (db) => {
    db.exec(`
      CREATE TABLE facts(
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, blob_id TEXT, text TEXT NOT NULL,
        since INTEGER NOT NULL, until INTEGER, confidence REAL NOT NULL DEFAULT 0.7,
        created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, thread_id TEXT, message_id TEXT);
      CREATE TABLE core(
        scope TEXT NOT NULL, blob_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(scope, blob_id));
      CREATE TABLE episodes(
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, blob_id TEXT NOT NULL, summary TEXT NOT NULL,
        created_at INTEGER NOT NULL);
    `);
  },
  // v2: importance, usage, retire metadata, embeddings, FTS, pending/questions/receipts/turns/meta
  (db) => {
    db.exec(`
      ALTER TABLE facts ADD COLUMN important INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE facts ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE facts ADD COLUMN retired_reason TEXT;
      ALTER TABLE facts ADD COLUMN superseded_by TEXT;
      ALTER TABLE facts ADD COLUMN embedding BLOB;
      ALTER TABLE facts ADD COLUMN emb_model TEXT;
      ALTER TABLE core ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE core ADD COLUMN input_hash TEXT;
      ALTER TABLE episodes ADD COLUMN updated_at INTEGER;
      CREATE INDEX facts_scope_idx ON facts(scope, blob_id, until);
      CREATE INDEX episodes_thread_idx ON episodes(thread_id, blob_id);
      CREATE TABLE pending(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, blob_id TEXT, text TEXT NOT NULL,
        target_fact_id TEXT, reason TEXT NOT NULL, confidence REAL NOT NULL, important INTEGER NOT NULL DEFAULT 0,
        thread_id TEXT, message_id TEXT, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open');
      CREATE TABLE questions(
        id TEXT PRIMARY KEY, blob_id TEXT, scope TEXT NOT NULL, text TEXT NOT NULL, fact_ids TEXT NOT NULL,
        proposed TEXT, thread_id TEXT, message_id TEXT, created_at INTEGER NOT NULL,
        ask_count INTEGER NOT NULL DEFAULT 0, last_asked_at INTEGER, status TEXT NOT NULL DEFAULT 'open');
      CREATE TABLE receipts(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, fact_id TEXT NOT NULL, pending_id TEXT, blob_id TEXT NOT NULL,
        text TEXT NOT NULL, undo TEXT NOT NULL, created_at INTEGER NOT NULL, undone_at INTEGER);
      CREATE TABLE turns(
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, blob_id TEXT NOT NULL, message_id TEXT NOT NULL,
        text TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX turns_idx ON turns(thread_id, message_id);
      CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
      CREATE VIRTUAL TABLE facts_fts USING fts5(text, fid UNINDEXED, tokenize='porter unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE ep_fts USING fts5(body, kind UNINDEXED, ref UNINDEXED, blob_id UNINDEXED,
        thread_id UNINDEXED, at UNINDEXED, tokenize='porter unicode61 remove_diacritics 2');
      INSERT INTO facts_fts(text, fid) SELECT text, id FROM facts;
      UPDATE episodes SET updated_at = created_at WHERE updated_at IS NULL;
      INSERT INTO ep_fts(body, kind, ref, blob_id, thread_id, at)
        SELECT summary, 'summary', id, blob_id, thread_id, created_at FROM episodes;
    `);
  },
  // v3: forget tombstones (hashed tokens only, never the forgotten text) and the turns Forget purged, so the retry queue
  //     cannot bring either back (prelaunch QA 2026-10-11, pl7 S2-1)
  (db) => {
    db.exec(`
      CREATE TABLE forgotten(id TEXT PRIMARY KEY, fact_id TEXT, tokens TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE purged_turns(thread_id TEXT NOT NULL, message_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(thread_id, message_id));
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function applyMigrations(db: DatabaseSync, upTo = MIGRATIONS.length): number {
  const cur = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (cur > MIGRATIONS.length) throw new Error(`memory db is newer (v${cur}) than this build (v${MIGRATIONS.length})`);
  for (let v = cur; v < Math.min(upTo, MIGRATIONS.length); v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return Math.min(upTo, MIGRATIONS.length);
}

export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  // A forgotten fact or a purged turn is overwritten on disk, not left in free pages for anyone reading the file.
  db.exec('PRAGMA secure_delete = ON');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  try {
    applyMigrations(db);
  } catch (e) {
    db.close(); // a refused (newer) or failed migration must not leave the file open (Windows can't delete it then)
    throw e;
  }
  // What the user told their assistants: owner-only, like the rest of KORA_HOME's secrets (it was 0644).
  if (dbPath !== ':memory:') {
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { chmodSync(f, 0o600); } catch { /* not there yet */ } }
  }
  return db;
}

/** Run `fn` (synchronous only!) in a transaction; nested calls join the outer one. */
const depth = new WeakMap<DatabaseSync, number>();
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw e;
  } finally {
    depth.set(db, 0);
  }
}
