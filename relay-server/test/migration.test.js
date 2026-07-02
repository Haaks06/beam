// The relay's production database is real, live, and has no "just delete
// it" fallback (see docs/HOSTING.md). This test builds a database with the
// EXACT schema that was actually running in production immediately before
// this ephemeral-pairing model (accounts, friend connections, admin — see
// git tag v0.5.0-accounts-era for the full prior version), seeds it with
// data that must survive, then requires db.js against it and asserts the
// upgrade to paired_at/expires_at is safe, idempotent, and doesn't silently
// break on the very first deploy the way it did before this test existed
// (CREATE TABLE IF NOT EXISTS does nothing to an already-existing table —
// without a real ALTER TABLE guard, every query touching those two columns
// would have thrown "no such column" against the real production database).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-to-pc-migration-test-'));
const dbPath = path.join(tmpDir, 'relay.sqlite');

const seed = new DatabaseSync(dbPath);
seed.exec(`
  CREATE TABLE inboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_id INTEGER NOT NULL REFERENCES inboxes(id),
    token TEXT UNIQUE NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );
  CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_id INTEGER NOT NULL REFERENCES inboxes(id),
    type TEXT NOT NULL CHECK(type IN ('link','photo')),
    content TEXT,
    file_path TEXT,
    mime_type TEXT,
    source_label TEXT,
    created_at INTEGER NOT NULL,
    from_inbox_id INTEGER REFERENCES inboxes(id)
  );
  CREATE TABLE pairing_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_id INTEGER NOT NULL REFERENCES inboxes(id),
    pairing_code TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    issued_token TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_a_id INTEGER NOT NULL REFERENCES inboxes(id),
    inbox_b_id INTEGER NOT NULL REFERENCES inboxes(id),
    requester_inbox_id INTEGER NOT NULL REFERENCES inboxes(id),
    target_inbox_id INTEGER NOT NULL REFERENCES inboxes(id),
    requester_label TEXT,
    target_label TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    responded_at INTEGER,
    UNIQUE(inbox_a_id, inbox_b_id)
  );
  CREATE TABLE connect_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_id INTEGER NOT NULL REFERENCES inboxes(id),
    label TEXT,
    code TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    inbox_id INTEGER NOT NULL UNIQUE REFERENCES inboxes(id),
    created_at INTEGER NOT NULL
  );
`);
seed.prepare('INSERT INTO inboxes (id, created_at) VALUES (1, 1000)').run();
seed.prepare(
  'INSERT INTO devices (id, inbox_id, token, label, created_at) VALUES (1, 1, ?, ?, 1000)'
).run('pre-existing-token', 'PC');
seed.prepare(
  "INSERT INTO items (id, inbox_id, type, content, source_label, created_at, from_inbox_id) VALUES (1, 1, 'link', 'https://example.com/pre-existing', 'PC', 1000, 1)"
).run();
seed.prepare(
  "INSERT INTO accounts (id, username, password_hash, display_name, inbox_id, created_at) VALUES (1, 'olduser', 'salt:hash', 'frenzy horse', 1, 1000)"
).run();
// A second inbox representing a friend inbox 1 once shared items with —
// the item's recipient (inbox_id) is the friend, but from_inbox_id still
// points back at inbox 1. deleteItems only ever matched on inbox_id, so
// this row survives inbox 1's own cleanup untouched and keeps a dangling
// REFERENCES inboxes(id) pointed at a row that's about to be deleted —
// the second real way the old friend-sharing data crashes the sweep.
seed.prepare('INSERT INTO inboxes (id, created_at) VALUES (2, 1000)').run();
seed.prepare(
  "INSERT INTO items (id, inbox_id, type, content, source_label, created_at, from_inbox_id) VALUES (2, 2, 'link', 'https://example.com/shared-with-friend', 'PC', 1000, 1)"
).run();
seed.close();

process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

test('adds paired_at/expires_at to an existing inboxes table without erroring or losing data', () => {
  const db = require('../db'); // triggers the guarded migration on require

  const columns = db.prepare('PRAGMA table_info(inboxes)').all().map((c) => c.name);
  assert.ok(columns.includes('paired_at'));
  assert.ok(columns.includes('expires_at'));

  // Pre-existing rows get NULL for both new columns, not an error and not
  // some fabricated default — this inbox predates the concept of pairing
  // having a lifetime at all.
  const inbox = db.prepare('SELECT * FROM inboxes WHERE id = 1').get();
  assert.equal(inbox.paired_at, null);
  assert.equal(inbox.expires_at, null);

  // Nothing pre-existing was touched or dropped.
  const device = db.prepare('SELECT * FROM devices WHERE id = 1').get();
  assert.equal(device.token, 'pre-existing-token');
  const item = db.prepare('SELECT * FROM items WHERE id = 1').get();
  assert.equal(item.content, 'https://example.com/pre-existing');

  // accounts/connections/connect_codes are dropped, not just left orphaned
  // — see the crash-regression test below for exactly why leaving them
  // in place (still declaring REFERENCES inboxes(id)) is actively unsafe,
  // not merely untidy.
  assert.throws(() => db.prepare('SELECT * FROM accounts').get(), /no such table/);
  assert.throws(() => db.prepare('SELECT * FROM connections').get(), /no such table/);
  assert.throws(() => db.prepare('SELECT * FROM connect_codes').get(), /no such table/);

  // from_device_id is brand new here — didn't exist in this era's schema at
  // all — and the pre-existing item row gets NULL for it, not an error.
  const itemsColumns = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  assert.ok(itemsColumns.includes('from_device_id'));
  assert.equal(item.from_device_id, null);
});

test('migration is idempotent — requiring db.js again does not error or duplicate columns', () => {
  delete require.cache[require.resolve('../db')];
  const db = require('../db');
  const columns = db.prepare('PRAGMA table_info(inboxes)').all().map((c) => c.name);
  assert.equal(columns.filter((c) => c === 'paired_at').length, 1);
  assert.equal(columns.filter((c) => c === 'expires_at').length, 1);
  const itemsColumns = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  assert.equal(itemsColumns.filter((c) => c === 'from_device_id').length, 1);
});

test('existing /items and /pair routes work unmodified against a migrated database', async () => {
  const request = require('supertest');
  const app = require('../index');

  const res = await request(app)
    .get('/items')
    .set('Authorization', 'Bearer pre-existing-token')
    .expect(200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].content, 'https://example.com/pre-existing');

  // A brand-new pairing on this same (now-migrated) database works exactly
  // like it would on a fresh one.
  const init = await request(app)
    .post('/pair/init')
    .set('Authorization', 'Bearer pre-existing-token')
    .expect(200);
  assert.ok(init.body.pairingCode);
});

// This is the actual production incident, reproduced twice over — both are
// real ways the old friend-sharing/accounts data crashed the sweep with
// "FOREIGN KEY constraint failed" (node:sqlite enforces
// PRAGMA foreign_keys = ON by default) once this deployed:
//
// 1. A leftover `accounts` row still pointing at an old inbox via
//    REFERENCES inboxes(id) — fixed by dropping that table entirely.
// 2. An `items` row shared with a friend, where the item's recipient
//    (inbox_id) is a DIFFERENT inbox than the one that sent it
//    (from_inbox_id) — deleteItems only ever matched on inbox_id, so this
//    row survived its origin inbox's own cleanup and kept a dangling
//    reference back to it. Fixed by matching on either column.
//
// Both crashed the entire process every 5 seconds until Fly hit its max
// restart count and the app stayed down. Deliberately LAST: it deletes
// the shared fixture inboxes every test above depends on.
test('sweeping old inboxes with leftover accounts and cross-inbox friend-shared items does not crash', () => {
  delete require.cache[require.resolve('../db')];
  delete require.cache[require.resolve('../lib/sessionCleanup')];
  const db = require('../db');
  const { sweep } = require('../lib/sessionCleanup');

  // Old enough to be swept as abandoned (paired_at IS NULL).
  db.prepare('UPDATE inboxes SET created_at = ? WHERE id IN (1, 2)').run(Date.now() - 11 * 60 * 1000);

  assert.doesNotThrow(() => sweep());
  assert.equal(db.prepare('SELECT * FROM inboxes WHERE id = 1').get(), undefined);
  assert.equal(db.prepare('SELECT * FROM inboxes WHERE id = 2').get(), undefined);
  // The friend-shared item (recipient inbox 2, sender inbox 1) is gone
  // too — it can't be left behind still pointing at a deleted inbox.
  assert.equal(db.prepare('SELECT * FROM items WHERE id = 2').get(), undefined);
});
