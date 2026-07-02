const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || './data/relay.sqlite';

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  -- An inbox is one ephemeral pairing between exactly two devices. It starts
  -- with one device (whoever calls POST /inbox) and paired_at/expires_at are
  -- both set the moment a second device claims a pairing code (see
  -- routes/pair.js) — from that instant the pairing has a fixed 2-minute
  -- lifetime, after which lib/sessionCleanup.js deletes everything below.
  CREATE TABLE IF NOT EXISTS inboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    paired_at INTEGER,
    expires_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_id INTEGER NOT NULL REFERENCES inboxes(id),
    token TEXT UNIQUE NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_id INTEGER NOT NULL REFERENCES inboxes(id),
    type TEXT NOT NULL CHECK(type IN ('link','photo')),
    content TEXT,
    file_path TEXT,
    mime_type TEXT,
    source_label TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pairing_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_id INTEGER NOT NULL REFERENCES inboxes(id),
    pairing_code TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    issued_token TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_items_inbox_id ON items(inbox_id);
  CREATE INDEX IF NOT EXISTS idx_devices_inbox_id ON devices(inbox_id);
`);

// CREATE TABLE IF NOT EXISTS above is a no-op against a database that
// already has an `inboxes` table from before this ephemeral-pairing model
// existed — it does NOT add new columns to an existing table. Without this,
// every query touching paired_at/expires_at (routes/pair.js,
// lib/sessionCleanup.js, and the index below) would fail with "no such
// column" the moment this deployed against the real production database.
// Must run before the index below is created — an index on a column that
// doesn't exist yet fails the same "no such column" way.
const inboxColumns = db.prepare('PRAGMA table_info(inboxes)').all();
if (!inboxColumns.some((c) => c.name === 'paired_at')) {
  db.exec('ALTER TABLE inboxes ADD COLUMN paired_at INTEGER');
}
if (!inboxColumns.some((c) => c.name === 'expires_at')) {
  db.exec('ALTER TABLE inboxes ADD COLUMN expires_at INTEGER');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_inboxes_expires_at ON inboxes(expires_at)');

module.exports = db;
