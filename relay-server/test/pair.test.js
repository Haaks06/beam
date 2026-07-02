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

async function createInboxToken(label = 'owner') {
  const res = await request(app).post('/inbox').send({ label }).expect(201);
  return res.body.token;
}

test('pair init (authenticated) issues a claimable code', async () => {
  const ownerToken = await createInboxToken();

  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.ok(initRes.body.pairingCode);
  assert.ok(initRes.body.qrDataUrl.startsWith('data:image/'));

  const claimRes = await request(app)
    .post('/pair/claim')
    .send({ pairingCode: initRes.body.pairingCode, label: 'test device' })
    .expect(200);
  assert.ok(claimRes.body.token);
  assert.equal(claimRes.body.token.length, 64);
});

test('pair init without a token is rejected', async () => {
  await request(app).post('/pair/init').expect(401);
});

test('a pairing code cannot be claimed twice', async () => {
  const ownerToken = await createInboxToken();
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);

  await request(app)
    .post('/pair/claim')
    .send({ pairingCode: initRes.body.pairingCode, label: 'first' })
    .expect(200);

  await request(app)
    .post('/pair/claim')
    .send({ pairingCode: initRes.body.pairingCode, label: 'second' })
    .expect(410);
});

test('unknown pairing code is rejected', async () => {
  await request(app).post('/pair/claim').send({ pairingCode: 'ZZZZZZ' }).expect(404);
});

test('status reflects claimed state', async () => {
  const ownerToken = await createInboxToken();
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  const before = await request(app).get(`/pair/status/${initRes.body.pairingCode}`).expect(200);
  assert.equal(before.body.status, 'pending');

  await request(app)
    .post('/pair/claim')
    .send({ pairingCode: initRes.body.pairingCode, label: 'test' })
    .expect(200);

  const after = await request(app).get(`/pair/status/${initRes.body.pairingCode}`).expect(200);
  assert.equal(after.body.status, 'claimed');
});

test('claiming the second device stamps the inbox with a 2-minute expiry', async () => {
  const ownerToken = await createInboxToken();
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);

  const before = Date.now();
  const claimRes = await request(app)
    .post('/pair/claim')
    .send({ pairingCode: initRes.body.pairingCode, label: 'phone' })
    .expect(200);
  assert.ok(claimRes.body.expiresAt);
  assert.ok(claimRes.body.expiresAt >= before + 2 * 60 * 1000);
  assert.ok(claimRes.body.expiresAt <= Date.now() + 2 * 60 * 1000 + 1000);

  const statusRes = await request(app).get(`/pair/status/${initRes.body.pairingCode}`).expect(200);
  assert.equal(statusRes.body.expiresAt, claimRes.body.expiresAt);
});

test('a pairing already at two devices refuses to mint another code', async () => {
  const ownerToken = await createInboxToken();
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  await request(app)
    .post('/pair/claim')
    .send({ pairingCode: initRes.body.pairingCode, label: 'phone' })
    .expect(200);

  await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(409);
});

test('a code minted by one inbox cannot leak a device into a different inbox', async () => {
  const ownerA = await createInboxToken('owner A');
  const ownerB = await createInboxToken('owner B');

  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerA}`)
    .expect(200);
  const claimRes = await request(app)
    .post('/pair/claim')
    .send({ pairingCode: initRes.body.pairingCode, label: 'phone' })
    .expect(200);
  const phoneToken = claimRes.body.token;

  await request(app)
    .post('/items/link')
    .set('Authorization', `Bearer ${ownerA}`)
    .send({ url: 'https://inbox-a.example.com' })
    .expect(201);

  // The newly-claimed device sees inbox A's items...
  const asPhone = await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${phoneToken}`)
    .expect(200);
  assert.equal(asPhone.body.items.length, 1);

  // ...but inbox B's owner token still sees nothing from inbox A.
  const asOwnerB = await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${ownerB}`)
    .expect(200);
  assert.deepEqual(asOwnerB.body.items, []);
});
