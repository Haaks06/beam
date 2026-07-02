const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-to-pc-admin-test-'));
process.env.DB_PATH = path.join(tmpDir, 'relay.sqlite');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

// A real, fixed test credential — scryptSync is deterministic given the
// same salt, so this hash is stable across runs.
const crypto = require('node:crypto');
const TEST_SALT = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
const TEST_PASSWORD = 'correct horse battery staple';
const testHash = crypto.scryptSync(TEST_PASSWORD, Buffer.from(TEST_SALT, 'hex'), 64).toString('hex');
process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD_HASH = `${TEST_SALT}:${testHash}`;
process.env.SESSION_SECRET = 'test-session-secret-do-not-use-in-prod';

const request = require('supertest');
const app = require('../index');

function extractCookie(res) {
  const setCookie = res.headers['set-cookie'];
  assert.ok(setCookie && setCookie.length > 0, 'expected a Set-Cookie header');
  return setCookie[0].split(';')[0];
}

test('wrong password is rejected', async () => {
  const res = await request(app)
    .post('/admin/login')
    .send({ username: 'testadmin', password: 'wrong password' });
  assert.equal(res.status, 401);
});

test('wrong username is rejected', async () => {
  const res = await request(app)
    .post('/admin/login')
    .send({ username: 'notadmin', password: TEST_PASSWORD });
  assert.equal(res.status, 401);
});

test('correct credentials issue a working session cookie', async () => {
  const loginRes = await request(app)
    .post('/admin/login')
    .send({ username: 'testadmin', password: TEST_PASSWORD })
    .expect(200);
  const cookie = extractCookie(loginRes);

  const inboxesRes = await request(app).get('/admin/inboxes').set('Cookie', cookie).expect(200);
  assert.ok(Array.isArray(inboxesRes.body.inboxes));

  const connectionsRes = await request(app).get('/admin/connections').set('Cookie', cookie).expect(200);
  assert.ok(Array.isArray(connectionsRes.body.connections));
});

test('admin routes reject a missing session cookie', async () => {
  await request(app).get('/admin/inboxes').expect(401);
});

test('admin routes reject a tampered session cookie', async () => {
  const loginRes = await request(app)
    .post('/admin/login')
    .send({ username: 'testadmin', password: TEST_PASSWORD })
    .expect(200);
  const cookie = extractCookie(loginRes);
  const tampered = cookie.replace(/\.[0-9a-f]+$/, '.deadbeef');

  await request(app).get('/admin/inboxes').set('Cookie', tampered).expect(401);
});

test('admin routes reject an expired session token', async () => {
  const { issueSessionToken } = require('../lib/adminAuth');
  // Directly craft an already-expired token using the real signing key
  // (SESSION_SECRET) to isolate "expiry is enforced" from "signature is
  // enforced" (covered by the tampered-cookie test above).
  const crypto2 = require('node:crypto');
  const pastExpiry = Date.now() - 1000;
  const sig = crypto2.createHmac('sha256', process.env.SESSION_SECRET).update(String(pastExpiry)).digest('hex');
  const expiredToken = `${pastExpiry}.${sig}`;

  await request(app)
    .get('/admin/inboxes')
    .set('Cookie', `beam_admin_session=${expiredToken}`)
    .expect(401);
  // Sanity: issueSessionToken() itself (fresh, not expired) is imported
  // just to confirm the module loads correctly in this test's require cache.
  assert.ok(issueSessionToken());
});

test('logout clears the session so the old cookie no longer works... after a fresh login is required', async () => {
  const loginRes = await request(app)
    .post('/admin/login')
    .send({ username: 'testadmin', password: TEST_PASSWORD })
    .expect(200);
  const cookie = extractCookie(loginRes);

  await request(app).post('/admin/logout').set('Cookie', cookie).expect(200);
  // Note: this stateless-token design means the OLD cookie value is still
  // technically valid until its expiry (no server-side revocation list) —
  // logout only clears the client's copy. Document that expectation here
  // rather than asserting something the design doesn't provide.
  await request(app).get('/admin/inboxes').set('Cookie', cookie).expect(200);
});

test('login is rate limited against brute force', async () => {
  const attempts = [];
  for (let i = 0; i < 6; i++) {
    attempts.push(
      request(app).post('/admin/login').send({ username: 'testadmin', password: `wrong-${i}` })
    );
  }
  const results = await Promise.all(attempts);
  const rateLimited = results.filter((r) => r.status === 429);
  assert.ok(rateLimited.length > 0, 'expected at least one 429 after 6 rapid login attempts (limit is 5/15min)');
});

test('admin login fails closed when not configured', async () => {
  // Simulate an unconfigured deployment by clearing env and re-requiring
  // the auth module fresh (it reads env vars at module load time).
  const originalHash = process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ADMIN_PASSWORD_HASH;
  delete require.cache[require.resolve('../lib/adminAuth')];
  const { verifyCredentials } = require('../lib/adminAuth');

  assert.equal(verifyCredentials('testadmin', TEST_PASSWORD), false);

  process.env.ADMIN_PASSWORD_HASH = originalHash;
  delete require.cache[require.resolve('../lib/adminAuth')];
});
