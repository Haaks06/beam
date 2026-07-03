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

// Real (if minimal) magic-number-valid fixtures for each format lib/
// sniffFileType.js recognizes.
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('minimal fake pdf body')]);
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const DOC_BYTES = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
const WEBM_BYTES = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
const OGG_BYTES = Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 0, 0, 0])]);
const WAV_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE')]);

test('uploads a PDF via /items/file and downloads it back', async () => {
  const token = await pairedToken();
  const postRes = await request(app)
    .post('/items/file')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', PDF_BYTES, { filename: 'report.pdf', contentType: 'application/pdf' })
    .expect(201);
  assert.equal(postRes.body.type, 'file');
  assert.equal(postRes.body.mimeType, 'application/pdf');

  const fileRes = await request(app)
    .get(postRes.body.fileUrl)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  assert.ok(fileRes.body.length > 0 || fileRes.text);
});

test('uploads a ZIP via /items/file', async () => {
  const token = await pairedToken();
  await request(app)
    .post('/items/file')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', ZIP_BYTES, { filename: 'archive.zip', contentType: 'application/zip' })
    .expect(201);
});

test('uploads a legacy .doc via /items/file', async () => {
  const token = await pairedToken();
  await request(app)
    .post('/items/file')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', DOC_BYTES, { filename: 'letter.doc', contentType: 'application/msword' })
    .expect(201);
});

test('rejects a /items/file upload whose bytes are not actually one of the allowed file types', async () => {
  const token = await pairedToken();
  await request(app)
    .post('/items/file')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from('just some plain text, not a real pdf'), {
      filename: 'fake.pdf',
      contentType: 'application/pdf',
    })
    .expect(400);
});

test('an encrypted /items/file upload skips the sniff and is accepted despite non-matching bytes', async () => {
  const token = await pairedToken();
  const ciphertext = Buffer.from('aes-gcm-ciphertext-not-a-real-pdf-at-all');
  const res = await request(app)
    .post('/items/file')
    .set('Authorization', `Bearer ${token}`)
    .field('encrypted', 'true')
    .attach('file', ciphertext, { filename: 'secret.pdf.enc', contentType: 'application/pdf' })
    .expect(201);
  assert.equal(res.body.encrypted, true);
});

test('uploads a WebM voice memo via /items/voice and downloads it back', async () => {
  const token = await pairedToken();
  const postRes = await request(app)
    .post('/items/voice')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', WEBM_BYTES, { filename: 'memo.webm', contentType: 'audio/webm' })
    .expect(201);
  assert.equal(postRes.body.type, 'voice');

  const fileRes = await request(app)
    .get(postRes.body.fileUrl)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  assert.ok(fileRes.body.length > 0 || fileRes.text);
});

test('uploads an Ogg voice memo via /items/voice', async () => {
  const token = await pairedToken();
  await request(app)
    .post('/items/voice')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', OGG_BYTES, { filename: 'memo.ogg', contentType: 'audio/ogg' })
    .expect(201);
});

test('uploads a WAV voice memo via /items/voice', async () => {
  const token = await pairedToken();
  await request(app)
    .post('/items/voice')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', WAV_BYTES, { filename: 'memo.wav', contentType: 'audio/wav' })
    .expect(201);
});

test('rejects a /items/voice upload whose bytes are not actually audio', async () => {
  const token = await pairedToken();
  await request(app)
    .post('/items/voice')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from('not audio at all'), { filename: 'fake.webm', contentType: 'audio/webm' })
    .expect(400);
});

test('the raw-body ingestion path works for /items/file too (?encrypted not set, real PDF bytes)', async () => {
  const token = await pairedToken();
  const res = await request(app)
    .post('/items/file')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/pdf')
    .send(PDF_BYTES)
    .expect(201);
  assert.equal(res.body.type, 'file');
});

test('the raw-body ingestion path works for /items/voice too', async () => {
  const token = await pairedToken();
  const res = await request(app)
    .post('/items/voice')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'audio/wav')
    .send(WAV_BYTES)
    .expect(201);
  assert.equal(res.body.type, 'voice');
});

test('file and voice items show up in the other device\'s backlog like any other item, with the right fileUrl', async () => {
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
    .post('/items/file')
    .set('Authorization', `Bearer ${ownerToken}`)
    .attach('file', PDF_BYTES, { filename: 'shared.pdf', contentType: 'application/pdf' })
    .expect(201);

  const listRes = await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${otherToken}`)
    .expect(200);
  assert.equal(listRes.body.items.length, 1);
  assert.equal(listRes.body.items[0].type, 'file');
  assert.ok(listRes.body.items[0].fileUrl);
});

test('a file item cannot be fetched from a different inbox', async () => {
  const tokenA = await pairedToken('inbox A');
  const tokenB = await pairedToken('inbox B');

  const postRes = await request(app)
    .post('/items/file')
    .set('Authorization', `Bearer ${tokenA}`)
    .attach('file', PDF_BYTES, { filename: 'private.pdf', contentType: 'application/pdf' })
    .expect(201);

  await request(app)
    .get(postRes.body.fileUrl)
    .set('Authorization', `Bearer ${tokenB}`)
    .expect(404);
});
