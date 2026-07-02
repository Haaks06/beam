const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-to-pc-connections-test-'));
process.env.DB_PATH = path.join(tmpDir, 'relay.sqlite');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
process.env.INBOX_LIMIT_PER_HOUR = '50';
process.env.CONNECT_LIMIT_PER_MINUTE = '200';
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

const request = require('supertest');
const app = require('../index');

async function newInbox(label) {
  const res = await request(app).post('/inbox').send({ label }).expect(201);
  return res.body.token;
}

async function initConnect(token, label) {
  const res = await request(app)
    .post('/connect/init')
    .set('Authorization', `Bearer ${token}`)
    .send({ label })
    .expect(200);
  return res.body.connectCode;
}

// Deliberately NOT async — supertest's Test object is itself
// thenable/chainable, so callers can do
// `await claimConnect(...).expect(201)`. Wrapping this in `async` would
// return a Promise instead of the Test object, breaking that chaining.
function claimConnect(token, code, label) {
  return request(app)
    .post('/connect/claim')
    .set('Authorization', `Bearer ${token}`)
    .send({ code, label });
}

test('claiming a connect code creates a pending connection, not an accepted one', async () => {
  const alice = await newInbox('Alice');
  const bob = await newInbox('Bob');
  const code = await initConnect(alice, 'Alice');

  const claimRes = await claimConnect(bob, code, 'Bob').expect(201);
  assert.equal(claimRes.body.status, 'pending');

  // Bob (who claimed) trying to send using this connection must fail —
  // claiming never grants access on its own.
  const sendRes = await request(app)
    .post('/items/link')
    .set('Authorization', `Bearer ${bob}`)
    .send({ url: 'should not be deliverable yet', to: claimRes.body.connectionId })
    .expect(404);
  assert.match(sendRes.body.error, /connection not found/);
});

test('only the target (code owner) can accept or reject, never the requester', async () => {
  const alice = await newInbox('Alice');
  const bob = await newInbox('Bob');
  const code = await initConnect(alice, 'Alice');
  const claimRes = await claimConnect(bob, code, 'Bob').expect(201);
  const connectionId = claimRes.body.connectionId;

  // Bob is the requester (he claimed Alice's code) — he must NOT be able
  // to accept his own request.
  const bobAcceptRes = await request(app)
    .post(`/connections/${connectionId}/accept`)
    .set('Authorization', `Bearer ${bob}`);
  assert.equal(bobAcceptRes.status, 404);

  // Alice (the target/code owner) can.
  await request(app)
    .post(`/connections/${connectionId}/accept`)
    .set('Authorization', `Bearer ${alice}`)
    .expect(200);
});

test('a non-party gets an identical 404 to a nonexistent connection id (no enumeration)', async () => {
  const alice = await newInbox('Alice');
  const bob = await newInbox('Bob');
  const mallory = await newInbox('Mallory');
  const code = await initConnect(alice, 'Alice');
  const claimRes = await claimConnect(bob, code, 'Bob').expect(201);
  const connectionId = claimRes.body.connectionId;

  const realConnectionRes = await request(app)
    .post(`/connections/${connectionId}/accept`)
    .set('Authorization', `Bearer ${mallory}`);
  const fakeConnectionRes = await request(app)
    .post(`/connections/999999/accept`)
    .set('Authorization', `Bearer ${mallory}`);

  assert.equal(realConnectionRes.status, 404);
  assert.equal(fakeConnectionRes.status, 404);
  assert.deepEqual(realConnectionRes.body, fakeConnectionRes.body);
});

test('cannot connect to yourself', async () => {
  const alice = await newInbox('Alice');
  const code = await initConnect(alice, 'Alice');
  const res = await claimConnect(alice, code, 'Alice again');
  assert.equal(res.status, 400);
});

test('a reverse-direction claim reuses the same connection row instead of creating a second one', async () => {
  const alice = await newInbox('Alice');
  const bob = await newInbox('Bob');

  const aliceCode = await initConnect(alice, 'Alice');
  const first = await claimConnect(bob, aliceCode, 'Bob').expect(201);

  // Now Bob invites Alice back (reverse direction) before Alice has
  // responded to the first request.
  const bobCode = await initConnect(bob, 'Bob');
  const second = await claimConnect(alice, bobCode, 'Alice').expect(201);

  assert.equal(first.body.connectionId, second.body.connectionId, 'should collapse to the same row');

  const aliceConnections = await request(app)
    .get('/connections')
    .set('Authorization', `Bearer ${alice}`)
    .expect(200);
  assert.equal(aliceConnections.body.connections.length, 1, 'Alice should see exactly one connection, not two');
});

test('an accepted connection lets items flow to the recipient only, never back to the sender\'s own backlog', async () => {
  const alice = await newInbox('Alice');
  const bob = await newInbox('Bob');
  const code = await initConnect(alice, 'Alice');
  const claimRes = await claimConnect(bob, code, 'Bob').expect(201);
  const connectionId = claimRes.body.connectionId;
  await request(app).post(`/connections/${connectionId}/accept`).set('Authorization', `Bearer ${alice}`).expect(200);

  // Bob sends to Alice via the connection.
  const sendRes = await request(app)
    .post('/items/link')
    .set('Authorization', `Bearer ${bob}`)
    .send({ url: 'https://example.com/for-alice', to: connectionId })
    .expect(201);
  assert.equal(sendRes.body.isOwnDevice, false);

  // Alice sees it.
  const aliceItems = await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${alice}`)
    .expect(200);
  assert.equal(aliceItems.body.items.length, 1);
  assert.equal(aliceItems.body.items[0].content, 'https://example.com/for-alice');
  assert.equal(aliceItems.body.items[0].isOwnDevice, false);

  // Bob does NOT see it in his own backlog — it was sent TO Alice, not
  // saved to Bob's own inbox.
  const bobItems = await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${bob}`)
    .expect(200);
  assert.equal(bobItems.body.items.length, 0);
});

test('a self-sent item (no `to`) is still marked isOwnDevice: true, unaffected by connections existing', async () => {
  const alice = await newInbox('Alice');
  const res = await request(app)
    .post('/items/link')
    .set('Authorization', `Bearer ${alice}`)
    .send({ url: 'https://example.com/for-myself' })
    .expect(201);
  assert.equal(res.body.isOwnDevice, true);
});

test('rejecting a connection lets a later re-request go through', async () => {
  const alice = await newInbox('Alice');
  const bob = await newInbox('Bob');
  const code1 = await initConnect(alice, 'Alice');
  const claim1 = await claimConnect(bob, code1, 'Bob').expect(201);
  await request(app)
    .post(`/connections/${claim1.body.connectionId}/reject`)
    .set('Authorization', `Bearer ${alice}`)
    .expect(200);

  const code2 = await initConnect(alice, 'Alice');
  const claim2 = await claimConnect(bob, code2, 'Bob').expect(201);
  assert.equal(claim2.body.status, 'pending', 'should be re-claimable as pending after a rejection');

  await request(app)
    .post(`/connections/${claim2.body.connectionId}/accept`)
    .set('Authorization', `Bearer ${alice}`)
    .expect(200);
});

test('an unknown or expired connect code is rejected', async () => {
  const bob = await newInbox('Bob');
  const res = await claimConnect(bob, 'ZZZZZZ', 'Bob');
  assert.equal(res.status, 404);
});
