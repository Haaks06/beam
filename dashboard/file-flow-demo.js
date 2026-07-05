// A real, runnable demonstration of exactly where a beamed photo goes,
// end to end — not a diagram, an actual execution against the real
// relay-server code (same modules the production app runs), on a
// throwaway temp database/upload directory so it never touches real data.
//
// Run directly:   node dashboard/file-flow-demo.js
// Or imported:     const { runFileFlowDemo } = require('./file-flow-demo');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function runFileFlowDemo({ log = console.log } = {}) {
  const steps = [];
  function record(title, detail) {
    steps.push({ title, detail, at: Date.now() });
    log(`\n[${steps.length}] ${title}`);
    if (detail) log(`    ${detail}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-file-flow-demo-'));
  const dbPath = path.join(tmpDir, 'relay.sqlite');
  const uploadDir = path.join(tmpDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });

  process.env.DB_PATH = dbPath;
  process.env.UPLOAD_DIR = uploadDir;
  process.env.INBOX_LIMIT_PER_WINDOW = '1000';
  process.env.NODE_ENV = 'test';

  // Every module under relay-server that does require('../db') (routes,
  // lib/sse.js, etc.) caches that reference the first time it's required —
  // clearing only db/index/sessionCleanup left those other modules still
  // pointed at the PREVIOUS run's (by-then-deleted) temp database, so a
  // second call in the same long-lived process — like this dashboard's
  // server — would fail. Clearing every relay-server module's cache entry,
  // not just three of them, makes each run genuinely start fresh.
  const relayServerDir = path.join(__dirname, '..', 'relay-server') + path.sep;
  for (const cachedPath of Object.keys(require.cache)) {
    if (cachedPath.startsWith(relayServerDir)) delete require.cache[cachedPath];
  }
  const request = require('supertest');
  const app = require(path.join(relayServerDir, 'index.js'));
  const db = require(path.join(relayServerDir, 'db.js'));
  const { sweep } = require(path.join(relayServerDir, 'lib', 'sessionCleanup.js'));

  record('Temp environment created', `DB: ${dbPath}\n    Uploads: ${uploadDir}`);

  // --- Device A creates an inbox and generates a pairing code ---
  const ownerRes = await request(app).post('/inbox').send({ label: 'Sender PC' }).expect(201);
  const ownerToken = ownerRes.body.token;
  const inboxId = ownerRes.body.inboxId;
  record('Device A ("Sender PC") created an inbox', `inboxId=${inboxId}, token=${ownerToken.slice(0, 12)}...`);

  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  record('Device A generated a pairing code', `code=${initRes.body.pairingCode} (this is what the QR image encodes)`);

  // --- Device B claims the code, completing the pairing ---
  const claimRes = await request(app)
    .post('/pair/claim')
    .send({ pairingCode: initRes.body.pairingCode, label: 'Receiver iPhone' })
    .expect(200);
  const receiverToken = claimRes.body.token;
  record('Device B ("Receiver iPhone") claimed the code', `session clock started (5 min default, 2-15 configurable), expiresAt=${new Date(claimRes.body.expiresAt).toISOString()}`);

  // --- Device A sends a photo ---
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const photoRes = await request(app)
    .post('/items/photo')
    .set('Authorization', `Bearer ${ownerToken}`)
    .attach('file', fakeJpeg, { filename: 'demo-photo.jpg', contentType: 'image/jpeg' })
    .expect(201);
  const itemId = photoRes.body.id;
  record('Device A uploaded a photo via POST /items/photo', `item id=${itemId}, ${fakeJpeg.length} bytes`);

  const dbRow = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  const savedPath = path.join(uploadDir, dbRow.file_path);
  const savedOnDisk = fs.existsSync(savedPath);
  record(
    'The file was written to disk with a server-generated name',
    `${savedPath}\n    (never the client's original filename — see lib/upload.js — closes a path-traversal/overwrite hole)\n    exists on disk: ${savedOnDisk}`
  );

  // --- Confirm delivery semantics ---
  const senderBacklog = await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  record(
    "Device A's own backlog does NOT include the photo it just sent",
    `items visible to sender: ${senderBacklog.body.items.length} (excluded by from_device_id — no more confusing self-echo)`
  );

  const receiverBacklog = await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${receiverToken}`)
    .expect(200);
  record(
    "Device B's backlog DOES include it",
    `items visible to receiver: ${receiverBacklog.body.items.length}, fileUrl=${receiverBacklog.body.items[0]?.fileUrl}`
  );

  const fileRes = await request(app)
    .get(photoRes.body.fileUrl)
    .set('Authorization', `Bearer ${receiverToken}`)
    .expect(200);
  const bytesMatch = Buffer.from(fileRes.body).equals(fakeJpeg);
  record('Device B downloaded the file via GET /items/:id/file', `bytes received match bytes sent: ${bytesMatch}`);

  const crossInbox = await request(app).post('/inbox').send({ label: 'unrelated device' }).expect(201);
  const crossFetch = await request(app)
    .get(photoRes.body.fileUrl)
    .set('Authorization', `Bearer ${crossInbox.body.token}`)
    .expect(404);
  record('An unrelated device cannot fetch the same file', `GET returned ${crossFetch.status} (scoped by inbox_id, not just the file id)`);

  // --- Session expiry: the whole point of "ephemeral" ---
  db.prepare('UPDATE inboxes SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, inboxId);
  record('Session artificially expired (normally happens automatically once the session\'s configured duration elapses)');

  sweep();
  const rowAfterSweep = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  const fileAfterSweep = fs.existsSync(savedPath);
  const deviceRowsAfterSweep = db.prepare('SELECT * FROM devices WHERE inbox_id = ?').all(inboxId);
  record(
    'Background sweep ran (lib/sessionCleanup.js, every 5s in production)',
    `DB row gone: ${rowAfterSweep === undefined}\n    File deleted from disk: ${!fileAfterSweep}\n    Both device tokens revoked: ${deviceRowsAfterSweep.length === 0}`
  );

  const postExpiryFetch = await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${receiverToken}`)
    .expect(401);
  record('Both devices are now locked out — the session genuinely no longer exists', `GET /items with the old token returned ${postExpiryFetch.status}`);

  // Windows keeps an OS-level lock on the sqlite file while DatabaseSync
  // holds it open — has to be closed before the temp dir can be removed,
  // unlike POSIX where an unlinked-but-open file is silently fine.
  try {
    db.close();
  } catch {
    // Already closed or never opened — not fatal either way.
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    log(`(cleanup note: couldn't remove ${tmpDir} — ${err.message}; harmless, it's in the OS temp dir)`);
  }

  return { steps, ok: true };
}

if (require.main === module) {
  runFileFlowDemo().then(
    () => {
      console.log('\n✔ Demo completed successfully.');
      process.exit(0);
    },
    (err) => {
      console.error('\n✘ Demo failed:', err);
      process.exit(1);
    }
  );
}

module.exports = { runFileFlowDemo };
