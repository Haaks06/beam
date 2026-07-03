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

// items.from_inbox_id isn't in the CREATE TABLE above (the new items.js
// never writes it — there's no more cross-inbox friend sharing to track
// the original sender for), but it must still exist as a real column: old
// rows from before this deploy carry it, it's still a
// REFERENCES inboxes(id) column, and lib/sessionCleanup.js has to be able
// to query it uniformly on every install, fresh or migrated, to find and
// clear those old dangling references when their origin inbox is deleted.
const itemsColumns = db.prepare('PRAGMA table_info(items)').all();
if (!itemsColumns.some((c) => c.name === 'from_inbox_id')) {
  db.exec('ALTER TABLE items ADD COLUMN from_inbox_id INTEGER REFERENCES inboxes(id)');
}

// items.from_device_id: which of the pairing's two devices actually sent
// this item, as opposed to inbox_id which both devices share. Needed so
// the sender's own SSE broadcast and backlog can exclude what it just
// sent — without this, the shared-inbox broadcast model means a device
// sees its own outgoing item echo right back at it in "Received," which
// reads as if the transfer looped back instead of confirming it went out.
const itemsColumnsForDevice = db.prepare('PRAGMA table_info(items)').all();
if (!itemsColumnsForDevice.some((c) => c.name === 'from_device_id')) {
  db.exec('ALTER TABLE items ADD COLUMN from_device_id INTEGER REFERENCES devices(id)');
}

// items.encrypted: set when the sender already AES-GCM encrypted the
// payload client-side (see Phase 2a's P2P-with-encrypted-relay-fallback)
// before it ever reached this server -- the relay stores and forwards the
// ciphertext exactly as it would any other item, it just can't read it.
// Same additive-migration pattern as the other columns above: existing
// rows get encrypted = 0 (NULL treated as falsy everywhere this is read),
// so every pre-existing item is correctly understood as unencrypted.
const itemsColumnsForEncrypted = db.prepare('PRAGMA table_info(items)').all();
if (!itemsColumnsForEncrypted.some((c) => c.name === 'encrypted')) {
  db.exec('ALTER TABLE items ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0');
}

// accounts/connections/connect_codes are leftovers from the pre-ephemeral
// era (real usernames/passwords, friend connections, admin) — no route
// reads or writes them anymore. They can't just be left inert: node:sqlite
// enforces `PRAGMA foreign_keys = ON` by default, and all three tables
// still declare `REFERENCES inboxes(id)`. The moment lib/sessionCleanup.js
// tried to delete an old inbox one of these tables still pointed at, the
// DELETE failed with "FOREIGN KEY constraint failed" and crashed the whole
// process — every 5 seconds, forever, since the sweep runs on a timer.
// Dropping them removes the dangling reference at its source. The full
// pre-migration database is preserved outside of this file (git tag
// v0.5.0-accounts-era + a Fly volume snapshot taken before this deploy).
db.exec('DROP TABLE IF EXISTS connections');
db.exec('DROP TABLE IF EXISTS connect_codes');
db.exec('DROP TABLE IF EXISTS accounts');

module.exports = db;
