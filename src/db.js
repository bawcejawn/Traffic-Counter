// SQLite storage using Node's built-in driver (no native dependencies).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS = [
  // 1: initial schema
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE sites (
    id             INTEGER PRIMARY KEY,
    key            TEXT NOT NULL UNIQUE,          -- public id used in the tracking snippet
    name           TEXT NOT NULL,
    domains        TEXT NOT NULL DEFAULT '',      -- comma separated allow-list ('' = any)
    timezone       TEXT NOT NULL DEFAULT 'UTC',
    public_stats   INTEGER NOT NULL DEFAULT 0,    -- share dashboard at /share/<key>
    public_counter INTEGER NOT NULL DEFAULT 1,    -- allow /counter/<key>.svg badges
    retention_days INTEGER NOT NULL DEFAULT 0,    -- 0 = keep forever
    ignore_paths   TEXT NOT NULL DEFAULT '',      -- newline separated prefixes
    created_at     INTEGER NOT NULL
  );

  -- One row per page view or event. Contains no IPs, no user agents and no
  -- visitor identifiers – only coarse dimensions plus two "first seen today"
  -- flags computed at ingest time.
  CREATE TABLE hits (
    id           INTEGER PRIMARY KEY,
    site_id      INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    ts           INTEGER NOT NULL,                -- unix seconds, UTC
    path         TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    event        INTEGER NOT NULL DEFAULT 0,
    ref          TEXT NOT NULL DEFAULT '',        -- referrer host (or campaign source)
    ref_path     TEXT NOT NULL DEFAULT '',
    utm_source   TEXT NOT NULL DEFAULT '',
    utm_medium   TEXT NOT NULL DEFAULT '',
    utm_campaign TEXT NOT NULL DEFAULT '',
    browser      TEXT NOT NULL DEFAULT '',
    browser_ver  TEXT NOT NULL DEFAULT '',
    os           TEXT NOT NULL DEFAULT '',
    device       TEXT NOT NULL DEFAULT '',
    screen       TEXT NOT NULL DEFAULT '',
    country      TEXT NOT NULL DEFAULT '',
    language     TEXT NOT NULL DEFAULT '',
    new_visit    INTEGER NOT NULL DEFAULT 0,      -- first hit of this visitor today (site-wide)
    new_path     INTEGER NOT NULL DEFAULT 0       -- first hit of this visitor today on this path
  );
  CREATE INDEX hits_site_ts      ON hits(site_id, ts);
  CREATE INDEX hits_site_path_ts ON hits(site_id, path, ts);

  -- Short-lived visitor dedup state. Rows are deleted when the day rolls over,
  -- together with the salt, so hashes cannot be linked across days.
  CREATE TABLE salts (
    day  TEXT PRIMARY KEY,
    salt TEXT NOT NULL
  );
  CREATE TABLE seen (
    day     TEXT NOT NULL,
    site_id INTEGER NOT NULL,
    visitor TEXT NOT NULL,
    path    TEXT NOT NULL,                        -- '' marks the site-wide visit
    PRIMARY KEY (day, site_id, visitor, path)
  ) WITHOUT ROWID;
  `,
];

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db) {
  const { user_version: v } = db.prepare('PRAGMA user_version').get();
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
