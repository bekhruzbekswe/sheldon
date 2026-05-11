/**
 * SQLite via Bun's built-in `bun:sqlite`. Single-process, single-file.
 *
 * Schema is created idempotently on first access. Caller never calls `open` —
 * `getDb()` returns a memoized handle.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = '.sheldon/sheldon.db';

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      claim        TEXT NOT NULL,
      source_url   TEXT NOT NULL,
      source_title TEXT,
      raw_excerpt  TEXT,
      embedding    BLOB NOT NULL,
      topic_tag    TEXT,
      confidence   REAL,
      question_id  INTEGER,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_url);
    CREATE INDEX IF NOT EXISTS idx_facts_topic  ON facts(topic_tag);

    CREATE TABLE IF NOT EXISTS frontier (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      question     TEXT NOT NULL,
      score        REAL NOT NULL,
      status       TEXT NOT NULL,
      parent_id    INTEGER,
      depth        INTEGER NOT NULL,
      embedding    BLOB NOT NULL,
      created_at   INTEGER NOT NULL,
      processed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_frontier_status_score ON frontier(status, score DESC);

    CREATE TABLE IF NOT EXISTS run_state (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      task            TEXT NOT NULL,
      started_at      INTEGER NOT NULL,
      deadline_at     INTEGER NOT NULL,
      phase           TEXT NOT NULL,
      contract_json   TEXT,
      task_embedding  BLOB
    );

    CREATE TABLE IF NOT EXISTS sources (
      domain                 TEXT PRIMARY KEY,
      source_type            TEXT,
      promotional_intent     TEXT,
      primary_vs_derivative  TEXT,
      classified_at          INTEGER,
      raw_label_json         TEXT
    );
  `);
  // Idempotent column adds for upgrades from a v1 schema that pre-dates these columns.
  // ALTER TABLE ADD COLUMN errors if the column exists; the catch makes it a no-op.
  try { db.exec('ALTER TABLE run_state ADD COLUMN contract_json TEXT'); } catch {}
  try { db.exec('ALTER TABLE run_state ADD COLUMN task_embedding BLOB'); } catch {}
  _db = db;
  return db;
}

/**
 * Drop the memoized handle so the next `getDb()` opens a fresh one.
 *
 * Used by the L8 dashboard between requests: when a separate writer process
 * runs `bun run research --fresh`, it unlinks the DB file. Our cached handle
 * then points to a stale vnode and macOS returns SQLITE_IOERR_VNODE on any
 * query. Resetting forces a re-open against the current file.
 */
export function resetDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      // Already invalid — ignore.
    }
  }
  _db = null;
}

export const DB_FILE = DB_PATH;
