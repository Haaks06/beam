const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-to-pc-test-'));
process.env.DB_PATH = path.join(tmpDir, 'relay.sqlite');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

const request = require('supertest');
const app = require('../index');

async function pairedToken(label = 'test device') {
  const res = await request(app).post('/inbox').send({ label }).expect(201);
  return res.body.token;
}

test('an unencrypted link defaults to encrypted: false', async () => {
  const token = await pairedToken();
  const res = await request(app)
    .post('/items/link')
    .set('Authorization', `Bearer ${token}`)
    .send({ url: 'https://example.com/plain' })
    .expect(201);
  assert.equal(res.body.encrypted, false);
});

test('a link posted with encrypted: true comes back flagged as encrypted in the POST response itself', async () => {
  const token = await pairedToken();
  const res = await request(app)
    .post('/items/link')
    .set('Authorization', `Bearer ${token}`)
    .send({ url: 'ciphertext-looking-base64-blob==', encrypted: true })
    .expect(201);
  assert.equal(res.body.encrypted, true);
});

test('a link posted with encrypted flag round-trips through the backlog for the other device', async () => {
  const ownerRes = await request(app).post('/inbox').send({ label: 'owner' }).expect(201);
  const ownerToken = ownerRes.body.token;
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const claimRes = await request(app)
    .post('/pair/claim')
    .send({ pairingCode: initRes.body.pairingCode, label: 'second device' })
    .expect(200);
  const otherToken = claimRes.body.token;

  await request(app)
    .post('/items/link')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ url: 'ciphertext-blob', encrypted: true })
    .expect(201);

  const listRes = await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${otherToken}`)
    .expect(200);
  assert.equal(listRes.body.items.length, 1);
  assert.equal(listRes.body.items[0].encrypted, true);
});

test('an unencrypted photo whose bytes are not actually an image is still rejected (magic-byte sniff unaffected)', async () => {
  const token = await pairedToken();
  await request(app)
    .post('/items/photo')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from('not an image at all'), { filename: 'fake.png', contentType: 'image/png' })
    .expect(400);
});

test('an encrypted photo skips the magic-byte sniff entirely and is accepted despite non-image bytes (multipart)', async () => {
  const token = await pairedToken();
  const ciphertext = Buffer.from('totally-not-an-image-this-is-aes-gcm-ciphertext');
  const res = await request(app)
    .post('/items/photo')
    .set('Authorization', `Bearer ${token}`)
    .field('encrypted', 'true')
    .attach('file', ciphertext, { filename: 'photo.enc', contentType: 'image/png' })
    .expect(201);
  assert.equal(res.body.encrypted, true);

  // The relay never tried to validate it as an image, so it serves the
  // raw (encrypted) bytes back exactly as uploaded, unmodified.
  const fileRes = await request(app)
    .get(res.body.fileUrl)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  assert.ok(Buffer.from(fileRes.body).equals(ciphertext) || fileRes.text === ciphertext.toString());
});

test('an encrypted photo skips the magic-byte sniff on the raw-body ingestion path too (?encrypted=true query param)', async () => {
  const token = await pairedToken();
  const ciphertext = Buffer.from('raw-body-path-ciphertext-not-a-real-jpeg');
  const res = await request(app)
    .post('/items/photo?encrypted=true')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'image/jpeg')
    .send(ciphertext)
    .expect(201);
  assert.equal(res.body.encrypted, true);
});

test('the raw-body ingestion path still enforces the sniff when encrypted is NOT set', async () => {
  const token = await pairedToken();
  const notAnImage = Buffer.from('plain unencrypted garbage, should be rejected');
  await request(app)
    .post('/items/photo')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'image/jpeg')
    .send(notAnImage)
    .expect(400);
});
