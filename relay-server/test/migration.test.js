// This is the highest-risk part of adding friend connections: the relay's
// production database (live, real user data, no "just delete it" fallback
// available per docs/HOSTING.md) needs items.from_inbox_id added without
// losing anything. This test builds a database with the OLD schema (no
// from_inbox_id, no connections/connect_codes tables) exactly as it exists
// in production today, then requires db.js against it and asserts the
// upgrade is safe and idempotent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-to-pc-migration-test-'));
const dbPath = path.join(tmpDir, 'relay.sqlite');

// Build the pre-migration schema by hand (mirrors the CURRENT production
// schema minus everything this change adds), and seed it with data that
// must survive the upgrade untouched.
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
    created_at INTEGER NOT NULL
  );
`);
seed.prepare('INSERT INTO inboxes (id, created_at) VALUES (1, 1000)').run();
seed.prepare(
  'INSERT INTO devices (id, inbox_id, token, label, created_at) VALUES (1, 1, ?, ?, 1000)'
).run('pre-existing-token', 'PC');
seed.prepare(
  "INSERT INTO items (id, inbox_id, type, content, source_label, created_at) VALUES (1, 1, 'link', 'https://example.com/pre-existing', 'PC', 1000)"
).run();
seed.close();

process.env.DB_PATH = dbPath;
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

test('adds from_inbox_id and backfills existing rows without touching their data', () => {
  const db = require('../db'); // triggers the guarded migration on require

  const columns = db.prepare('PRAGMA table_info(items)').all();
  assert.ok(columns.some((c) => c.name === 'from_inbox_id'), 'from_inbox_id column should exist after migration');

  const row = db.prepare('SELECT * FROM items WHERE id = 1').get();
  assert.equal(row.from_inbox_id, row.inbox_id, 'pre-existing row should be backfilled to from_inbox_id = inbox_id');
  assert.equal(row.content, 'https://example.com/pre-existing', 'pre-existing content must be untouched');

  // New tables should also now exist (both are additive, no data to preserve).
  const connectionsColumns = db.prepare('PRAGMA table_info(connections)').all();
  assert.ok(connectionsColumns.length > 0, 'connections table should exist after migration');
  const connectCodesColumns = db.prepare('PRAGMA table_info(connect_codes)').all();
  assert.ok(connectCodesColumns.length > 0, 'connect_codes table should exist after migration');
});

test('migration is idempotent — running it again does not error or lose data', () => {
  delete require.cache[require.resolve('../db')];
  const db = require('../db'); // re-require re-runs the guarded ALTER + backfill logic

  const row = db.prepare('SELECT * FROM items WHERE id = 1').get();
  assert.equal(row.from_inbox_id, 1);
  assert.equal(row.content, 'https://example.com/pre-existing');
});

test('existing /items routes work unmodified against a migrated database', async () => {
  delete require.cache[require.resolve('../db')];
  delete require.cache[require.resolve('../index')];
  const request = require('supertest');
  const app = require('../index');

  const res = await request(app)
    .get('/items?since=0')
    .set('Authorization', 'Bearer pre-existing-token')
    .expect(200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].content, 'https://example.com/pre-existing');
});
