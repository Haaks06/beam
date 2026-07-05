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

// Set before requiring the app -- routes/pair.js and index.js both read
// PUBLIC_RELAY_URL at module-load time.
process.env.PUBLIC_RELAY_URL = 'https://app.beamlot.com';

const request = require('supertest');
const app = require('../index');

test('pairing links always use PUBLIC_RELAY_URL, never the request host', async () => {
  const inboxRes = await request(app).post('/inbox').send({ label: 'owner' }).expect(201);
  const initRes = await request(app)
    .post('/pair/init')
    .set('Authorization', `Bearer ${inboxRes.body.token}`)
    .set('Host', 'beam-wckn2w.fly.dev') // simulates hitting the raw fly.dev address directly
    .expect(200);
  assert.equal(initRes.body.relayUrl, 'https://app.beamlot.com');
  assert.equal(initRes.body.pairingUrl, `https://app.beamlot.com/${initRes.body.pairingCode}`);
});

test('a page request on a non-canonical host is redirected to PUBLIC_RELAY_URL', async () => {
  const res = await request(app).get('/app').set('Host', 'beam-wckn2w.fly.dev');
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, 'https://app.beamlot.com/app');
});

test('a pairing-code link on a non-canonical host is redirected, preserving the path', async () => {
  const res = await request(app).get('/ABC123').set('Host', 'beam-wckn2w.fly.dev');
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, 'https://app.beamlot.com/ABC123');
});

test('API routes are never redirected, even on a non-canonical host', async () => {
  const res = await request(app).post('/inbox').set('Host', 'beam-wckn2w.fly.dev').send({ label: 'x' });
  assert.equal(res.status, 201);
});

test('/health is never redirected, even on a non-canonical host', async () => {
  const res = await request(app).get('/health').set('Host', 'beam-wckn2w.fly.dev');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('a request on the canonical host is never redirected', async () => {
  const res = await request(app).get('/app').set('Host', 'app.beamlot.com');
  assert.notEqual(res.status, 301);
});
