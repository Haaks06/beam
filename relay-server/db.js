const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || './data/relay.sqlite';

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  -- An inbox is one person's private space. Every device, item, and
  -- pairing code belongs to exactly one inbox; isolation between people
  -- is enforced entirely by scoping queries to inbox_id.
  CREATE TABLE IF NOT EXISTS inboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_id INTEGER NOT NULL REFERENCES inboxes(id),
    token TEXT UNIQUE NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );

  -- inbox_id is the RECEIVING inbox (who can see this item) — for items
  -- shared between friends this differs from who actually sent it, see
  -- from_inbox_id below. Keeping inbox_id as "recipient" means every
  -- existing read path (backlog, SSE broadcast, file download) needed zero
  -- changes when friend-sharing was added; only the write path (routes/
  -- items.js) needed to learn how to resolve a *different* recipient.
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

  -- A friend connection between two DIFFERENT inboxes (as opposed to
  -- pairing_requests, which adds another device to YOUR OWN inbox).
  -- Normalized so a friendship is exactly one row regardless of who
  -- initiated: inbox_a_id/inbox_b_id always hold the smaller id first
  -- (enforced in code, see routes/connections.js), so Alice inviting Bob
  -- and Bob inviting Alice collapse to the same row instead of creating
  -- two independent, possibly-contradictory ones. requester/target are
  -- kept as a separate pair of columns purely for "who does the
  -- accepting" semantics (only target may accept/reject).
  CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_a_id INTEGER NOT NULL REFERENCES inboxes(id),
    inbox_b_id INTEGER NOT NULL REFERENCES inboxes(id),
    requester_inbox_id INTEGER NOT NULL REFERENCES inboxes(id),
    target_inbox_id INTEGER NOT NULL REFERENCES inboxes(id),
    requester_label TEXT,
    target_label TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
    created_at INTEGER NOT NULL,
    responded_at INTEGER,
    UNIQUE(inbox_a_id, inbox_b_id)
  );

  -- Short-lived codes used to *start* a connection (see /connect/init and
  -- /connect/claim) — distinct from pairing_requests' codes, which add a
  -- device to your own inbox instead of connecting two different inboxes.
  CREATE TABLE IF NOT EXISTS connect_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_id INTEGER NOT NULL REFERENCES inboxes(id),
    label TEXT,
    code TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_items_inbox_id ON items(inbox_id);
  CREATE INDEX IF NOT EXISTS idx_devices_inbox_id ON devices(inbox_id);
  CREATE INDEX IF NOT EXISTS idx_connections_inbox_a ON connections(inbox_a_id);
  CREATE INDEX IF NOT EXISTS idx_connections_inbox_b ON connections(inbox_b_id);
`);

// Guarded, idempotent migration for items.from_inbox_id (who actually sent
// it, vs inbox_id which is who can see it). SQLite can't add a NOT NULL
// column to a populated table without a DEFAULT, and this codebase already
// treats FK REFERENCES as advisory (foreign_keys pragma is never turned
// on) — so this is guaranteed at the application layer instead: every
// INSERT going forward always supplies it (see routes/items.js).
const itemsColumns = db.prepare('PRAGMA table_info(items)').all();
if (!itemsColumns.some((c) => c.name === 'from_inbox_id')) {
  db.exec('ALTER TABLE items ADD COLUMN from_inbox_id INTEGER REFERENCES inboxes(id)');
}
// Runs on every boot, not just when the ALTER above just ran — self-heals
// a process crash mid-migration on a previous deploy instead of leaving
// rows permanently NULL. No-op once everything is backfilled.
db.exec('UPDATE items SET from_inbox_id = inbox_id WHERE from_inbox_id IS NULL');

module.exports = db;
