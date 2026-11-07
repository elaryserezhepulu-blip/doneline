'use strict';
/*
 * Tiny async DB adapter.
 *  - DATABASE_URL set  → PostgreSQL (e.g. Neon free tier) via `pg`
 *  - otherwise         → built-in node:sqlite file in DATA_DIR
 * SQL is written with `?` placeholders; they are converted to $1, $2… for Postgres.
 */
const fs = require('fs');
const path = require('path');

const SCHEMA_SQLITE = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  due_date TEXT, due_time TEXT, priority INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]',
  people TEXT NOT NULL DEFAULT '[]', repeat TEXT, remind INTEGER NOT NULL DEFAULT -1, remind_at INTEGER,
  reminded INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, done_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tasks_remind ON tasks(remind_at);
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL,
  digest INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT, subject TEXT, html TEXT, status TEXT, error TEXT, created_at INTEGER);
`;

const SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  due_date TEXT, due_time TEXT, priority INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]',
  people TEXT NOT NULL DEFAULT '[]', repeat TEXT, remind INTEGER NOT NULL DEFAULT -1, remind_at BIGINT,
  reminded INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, done_at BIGINT,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tasks_remind ON tasks(remind_at);
CREATE TABLE IF NOT EXISTS people (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
  digest INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  id SERIAL PRIMARY KEY, to_addr TEXT, subject TEXT, html TEXT, status TEXT, error TEXT, created_at BIGINT);
`;

async function openDb({ databaseUrl, dataDir }) {
  if (databaseUrl) {
    const pg = require('pg');
    pg.types.setTypeParser(20, (v) => (v == null ? null : Number(v))); // BIGINT/COUNT → number
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX) || 5,
      idleTimeoutMillis: 30000,
    });
    const conv = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); };
    await pool.query(SCHEMA_PG);
    return {
      kind: 'postgres',
      all: async (sql, ...p) => (await pool.query(conv(sql), p)).rows,
      get: async (sql, ...p) => (await pool.query(conv(sql), p)).rows[0],
      run: async (sql, ...p) => { await pool.query(conv(sql), p); },
    };
  }
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'doneline.db'));
  db.exec(SCHEMA_SQLITE);
  const plain = (r) => (r ? { ...r } : r);
  return {
    kind: 'sqlite',
    all: async (sql, ...p) => db.prepare(sql).all(...p).map(plain),
    get: async (sql, ...p) => plain(db.prepare(sql).get(...p)),
    run: async (sql, ...p) => { db.prepare(sql).run(...p); },
  };
}

module.exports = { openDb };
