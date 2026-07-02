const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-to-pc-test-'));
process.env.DB_PATH = path.join(tmpDir, 'relay.sqlite');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
process.env.INBOX_LIMIT_PER_WINDOW = '50';
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

const request = require('supertest');
const app = require('../index');
const db = require('../db');
const { sweep } = require('../lib/sessionCleanup');

async function pairTwoDevices() {
  const ownerRes = await request(app).post('/inbox').send({ label: 'owner' }).expect(201);
  const ownerToken = ownerRes.body.token;
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const claimRes = await request(app)
    .post('/pair/claim')
    .send({ pairingCode: initRes.body.pairingCode, label: 'phone' })
    .expect(200);
  return { inboxId: ownerRes.body.inboxId, ownerToken, phoneToken: claimRes.body.token };
}

test('sweep deletes an expired paired inbox, its devices, its items, and its uploaded file', async () => {
  const { inboxId, ownerToken, phoneToken } = await pairTwoDevices();

  const photoRes = await request(app)
    .post('/items/photo')
    .set('Authorization', `Bearer ${ownerToken}`)
    .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'test.jpg', contentType: 'image/jpeg' })
    .expect(201);
  const filePath = path.join(process.env.UPLOAD_DIR, db.prepare('SELECT file_path FROM items WHERE id = ?').get(photoRes.body.id).file_path);
  assert.ok(fs.existsSync(filePath), 'uploaded file should exist before expiry');

  // Force this inbox's session to have already expired, then run the sweep
  // directly rather than waiting on the real interval.
  db.prepare('UPDATE inboxes SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, inboxId);
  sweep();

  assert.equal(db.prepare('SELECT * FROM inboxes WHERE id = ?').get(inboxId), undefined);
  assert.deepEqual(db.prepare('SELECT * FROM devices WHERE inbox_id = ?').all(inboxId), []);
  assert.deepEqual(db.prepare('SELECT * FROM items WHERE inbox_id = ?').all(inboxId), []);
  assert.ok(!fs.existsSync(filePath), 'uploaded file should be deleted after expiry');

  await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(401);
  await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${phoneToken}`)
    .expect(401);
});

test('sweep leaves a still-live paired session untouched', async () => {
  const { inboxId, ownerToken } = await pairTwoDevices();
  sweep();
  await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.ok(db.prepare('SELECT * FROM inboxes WHERE id = ?').get(inboxId));
});

test('sweep deletes an inbox that was never paired, once it is old enough', async () => {
  const ownerRes = await request(app).post('/inbox').send({ label: 'lonely' }).expect(201);
  db.prepare('UPDATE inboxes SET created_at = ? WHERE id = ?').run(Date.now() - 11 * 60 * 1000, ownerRes.body.inboxId);
  sweep();
  assert.equal(db.prepare('SELECT * FROM inboxes WHERE id = ?').get(ownerRes.body.inboxId), undefined);
  await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${ownerRes.body.token}`)
    .expect(401);
});
