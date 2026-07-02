const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-to-pc-test-'));
process.env.DB_PATH = path.join(tmpDir, 'relay.sqlite');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
// This file creates many inboxes across its tests, well past the
// production default — raise the cap so the tests exercise item/file
// isolation rather than the rate limiter itself (see inbox.test.js for that).
process.env.INBOX_LIMIT_PER_HOUR = '50';
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

const request = require('supertest');
const app = require('../index');

async function pairedToken(label = 'test device') {
  const res = await request(app).post('/inbox').send({ label }).expect(201);
  return res.body.token;
}

// Adds a second device to the same inbox as ownerToken, via the normal
// pair/init+claim flow.
async function addDeviceToInbox(ownerToken, label = 'second device') {
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const claimRes = await request(app)
    .post('/pair/claim')
    .send({ pairingCode: initRes.body.pairingCode, label })
    .expect(200);
  return claimRes.body.token;
}

test('rejects item submission without a token', async () => {
  await request(app).post('/items/link').send({ url: 'https://example.com' }).expect(401);
});

test('rejects empty text', async () => {
  const token = await pairedToken();
  await request(app)
    .post('/items/link')
    .set('Authorization', `Bearer ${token}`)
    .send({ url: '   ' })
    .expect(400);
});

test('accepts plain text, not just http(s) urls', async () => {
  const token = await pairedToken();
  const postRes = await request(app)
    .post('/items/link')
    .set('Authorization', `Bearer ${token}`)
    .send({ url: 'pick up milk' })
    .expect(201);
  assert.equal(postRes.body.content, 'pick up milk');
});

test('submits a link and retrieves it via backlog', async () => {
  const token = await pairedToken();
  const postRes = await request(app)
    .post('/items/link')
    .set('Authorization', `Bearer ${token}`)
    .send({ url: 'https://example.com/page' })
    .expect(201);
  assert.equal(postRes.body.type, 'link');
  assert.equal(postRes.body.content, 'https://example.com/page');

  const listRes = await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  assert.equal(listRes.body.items.length, 1);
  assert.equal(listRes.body.items[0].id, postRes.body.id);
});

test('uploads a photo and downloads it back', async () => {
  const token = await pairedToken();
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  const postRes = await request(app)
    .post('/items/photo')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', fakeJpeg, { filename: 'test.jpg', contentType: 'image/jpeg' })
    .expect(201);
  assert.equal(postRes.body.type, 'photo');

  const fileRes = await request(app)
    .get(postRes.body.fileUrl)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  assert.ok(fileRes.body.length > 0 || fileRes.text);
});

test('rejects an unsupported file type', async () => {
  const token = await pairedToken();
  await request(app)
    .post('/items/photo')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from('not an image'), { filename: 'evil.exe', contentType: 'application/x-msdownload' })
    .expect(400);
});

test('items posted in one inbox are invisible to another inbox', async () => {
  const tokenA = await pairedToken('inbox A');
  const tokenB = await pairedToken('inbox B');

  await request(app)
    .post('/items/link')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ url: 'https://inbox-a.example.com' })
    .expect(201);

  const listA = await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${tokenA}`)
    .expect(200);
  assert.equal(listA.body.items.length, 1);

  const listB = await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${tokenB}`)
    .expect(200);
  assert.deepEqual(listB.body.items, []);
});

test('a photo file cannot be fetched from a different inbox', async () => {
  const tokenA = await pairedToken('inbox A');
  const tokenB = await pairedToken('inbox B');
  const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  const postRes = await request(app)
    .post('/items/photo')
    .set('Authorization', `Bearer ${tokenA}`)
    .attach('file', fakeJpeg, { filename: 'test.jpg', contentType: 'image/jpeg' })
    .expect(201);

  await request(app)
    .get(postRes.body.fileUrl)
    .set('Authorization', `Bearer ${tokenB}`)
    .expect(404);

  // The owning inbox can still fetch it fine.
  await request(app)
    .get(postRes.body.fileUrl)
    .set('Authorization', `Bearer ${tokenA}`)
    .expect(200);
});

test('multiple devices in the same inbox share the same items', async () => {
  const ownerToken = await pairedToken('owner');
  const secondDeviceToken = await addDeviceToInbox(ownerToken);

  await request(app)
    .post('/items/link')
    .set('Authorization', `Bearer ${secondDeviceToken}`)
    .send({ url: 'https://shared-inbox.example.com' })
    .expect(201);

  const asOwner = await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(asOwner.body.items.length, 1);
  assert.equal(asOwner.body.items[0].content, 'https://shared-inbox.example.com');
});
