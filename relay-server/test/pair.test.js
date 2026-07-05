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

test('claiming the second device stamps the inbox with the default 5-minute expiry', async () => {
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
  assert.ok(claimRes.body.expiresAt >= before + 5 * 60 * 1000);
  assert.ok(claimRes.body.expiresAt <= Date.now() + 5 * 60 * 1000 + 1000);

  const statusRes = await request(app).get(`/pair/status/${initRes.body.pairingCode}`).expect(200);
  assert.equal(statusRes.body.expiresAt, claimRes.body.expiresAt);
});

test('a requested session duration within bounds is honored', async () => {
  const res = await request(app).post('/inbox').send({ label: 'owner', sessionDurationMs: 10 * 60 * 1000 }).expect(201);
  const ownerToken = res.body.token;
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);

  const before = Date.now();
  const claimRes = await request(app)
    .post('/pair/claim')
    .send({ pairingCode: initRes.body.pairingCode, label: 'phone' })
    .expect(200);
  assert.ok(claimRes.body.expiresAt >= before + 10 * 60 * 1000);
  assert.ok(claimRes.body.expiresAt <= Date.now() + 10 * 60 * 1000 + 1000);
});

test('a requested session duration outside bounds is clamped, not honored as-is', async () => {
  const res = await request(app).post('/inbox').send({ label: 'owner', sessionDurationMs: 60 * 60 * 1000 }).expect(201);
  const ownerToken = res.body.token;
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);

  const before = Date.now();
  const claimRes = await request(app)
    .post('/pair/claim')
    .send({ pairingCode: initRes.body.pairingCode, label: 'phone' })
    .expect(200);
  // Clamped to the 15-minute max, not the requested 60 minutes.
  assert.ok(claimRes.body.expiresAt <= before + 15 * 60 * 1000 + 1000);
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

// Same-network hint (Phase 1c) — each endpoint hands back whichever
// device is calling it its own apparent address, so client-side logic
// (Phase 2b) can compare it against the other device's over the /signal
// channel and decide whether to prefer local ICE candidates. Not
// persisted anywhere; just computed per-request.
test('POST /pair/claim includes the caller\'s remoteAddr', async () => {
  const ownerToken = await createInboxToken();
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);

  const claimRes = await request(app)
    .post('/pair/claim')
    .send({ pairingCode: initRes.body.pairingCode, label: 'phone' })
    .expect(200);
  assert.ok(typeof claimRes.body.remoteAddr === 'string' && claimRes.body.remoteAddr.length > 0);
});

test('GET /pair/status/:code includes the polling device\'s remoteAddr', async () => {
  const ownerToken = await createInboxToken();
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);

  const statusRes = await request(app).get(`/pair/status/${initRes.body.pairingCode}`).expect(200);
  assert.ok(typeof statusRes.body.remoteAddr === 'string' && statusRes.body.remoteAddr.length > 0);
});

// Phase 2c: trusted-device auto-reconnect derives a code from a locally-
// shared secret + time window on both devices independently, then asks
// /pair/init to mint that exact value instead of a random one, so the
// other device's /pair/claim can find it without ever seeing a QR.
test('POST /pair/init mints the exact preferredCode when it is valid and available', async () => {
  const ownerToken = await createInboxToken();
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ preferredCode: 'ABCDEF' })
    .expect(200);
  assert.equal(initRes.body.pairingCode, 'ABCDEF');

  // And it's a completely normal, fully-functional code from here on --
  // no different code path for claiming, expiry, or the second-device cap.
  await request(app)
    .post('/pair/claim')
    .send({ pairingCode: 'ABCDEF', label: 'trusted device' })
    .expect(200);
});

test('POST /pair/init falls back to a random code when preferredCode is already taken', async () => {
  const ownerA = await createInboxToken('owner A');
  await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerA}`)
    .send({ preferredCode: 'TAKEN1' })
    .expect(200);

  const ownerB = await createInboxToken('owner B');
  const secondRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerB}`)
    .send({ preferredCode: 'TAKEN1' })
    .expect(200);
  assert.notEqual(secondRes.body.pairingCode, 'TAKEN1');
});

test('POST /pair/init falls back to a random code when preferredCode is malformed', async () => {
  const ownerToken = await createInboxToken();
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ preferredCode: 'not-valid!!' })
    .expect(200);
  assert.notEqual(initRes.body.pairingCode, 'not-valid!!');
  assert.equal(initRes.body.pairingCode.length, 6);
});

test('POST /pair/init works exactly as before when no preferredCode is sent at all', async () => {
  const ownerToken = await createInboxToken();
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(initRes.body.pairingCode.length, 6);
});
