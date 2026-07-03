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
const sse = require('../lib/sse');

// Minimal fake ServerResponse, same shape as test/sse.test.js's — just
// enough for sse.js to subscribe to and write against.
function fakeRes() {
  const writes = [];
  const closeHandlers = [];
  return {
    writes,
    write: (chunk) => writes.push(chunk),
    on: (event, handler) => {
      if (event === 'close') closeHandlers.push(handler);
    },
    triggerClose: () => closeHandlers.forEach((h) => h()),
  };
}

async function pairedDevices() {
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
  return { ownerToken, otherToken: claimRes.body.token, inboxId: ownerRes.body.inboxId };
}

// requireToken doesn't expose device.id on the response body directly, but
// GET /events subscribes using it — for these tests it's simpler to
// subscribe fake SSE connections straight through lib/sse.js the same way
// test/sse.test.js does, keyed by the real inbox_id from POST /inbox.

test('rejects a signal without a token', async () => {
  await request(app).post('/signal').send({ type: 'offer', payload: {} }).expect(401);
});

test('rejects an unknown signal type', async () => {
  const { ownerToken } = await pairedDevices();
  await request(app)
    .post('/signal')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ type: 'not-a-real-type', payload: {} })
    .expect(400);
});

test('rejects a missing type', async () => {
  const { ownerToken } = await pairedDevices();
  await request(app)
    .post('/signal')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ payload: { foo: 'bar' } })
    .expect(400);
});

test('404s when the other device is not currently connected (no SSE subscriber)', async () => {
  const { ownerToken } = await pairedDevices();
  await request(app)
    .post('/signal')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ type: 'offer', payload: { sdp: 'v=0...' } })
    .expect(404);
});

test('delivers to the other device as a named "signal" SSE event when it is connected, and never echoes back to the sender', async () => {
  const { inboxId } = await pairedDevices();
  // Fake SSE connections for two arbitrary device ids sharing this inbox —
  // mirrors how test/sse.test.js exercises lib/sse.js directly, since
  // driving two real long-lived GET /events streams through supertest in
  // the same process is impractical.
  const senderConn = fakeRes();
  const otherConn = fakeRes();
  sse.subscribe(inboxId, 111, senderConn);
  sse.subscribe(inboxId, 222, otherConn);

  const delivered = sse.sendSignal(inboxId, 111, { type: 'offer', payload: { sdp: 'v=0...' } });

  assert.equal(delivered, true);
  assert.equal(senderConn.writes.length, 0, "the sender's own connection must not receive its own signal");
  assert.equal(otherConn.writes.length, 1);
  assert.match(otherConn.writes[0], /^event: signal\n/);
  assert.match(otherConn.writes[0], /"type":"offer"/);
});

test('POST /signal 202s and actually delivers through the real route + auth layer when the other device is subscribed', async () => {
  const { ownerToken, inboxId } = await pairedDevices();
  const otherConn = fakeRes();
  // 222 is an arbitrary id distinct from whatever device id requireToken
  // resolves ownerToken to — the point is just "some other device in this
  // inbox is listening."
  sse.subscribe(inboxId, 222, otherConn);

  const res = await request(app)
    .post('/signal')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ type: 'ice-candidate', payload: { candidate: 'candidate:1 1 UDP...' } })
    .expect(202);

  assert.deepEqual(res.body, { ok: true });
  assert.equal(otherConn.writes.length, 1);
  assert.match(otherConn.writes[0], /"type":"ice-candidate"/);
});

test('a pubkey signal round-trips its payload untouched', async () => {
  const { ownerToken, inboxId } = await pairedDevices();
  const otherConn = fakeRes();
  sse.subscribe(inboxId, 333, otherConn);

  const payload = { key: 'BASE64URL_ENCODED_P256_PUBLIC_KEY==' };
  await request(app)
    .post('/signal')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ type: 'pubkey', payload })
    .expect(202);

  const parsed = JSON.parse(otherConn.writes[0].split('data: ')[1]);
  assert.deepEqual(parsed.payload, payload);
});
