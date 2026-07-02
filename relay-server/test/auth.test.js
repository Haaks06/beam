const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-to-pc-auth-test-'));
process.env.DB_PATH = path.join(tmpDir, 'relay.sqlite');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
process.env.INBOX_LIMIT_PER_HOUR = '50';
process.env.CONNECT_LIMIT_PER_MINUTE = '200';
// Comfortably above the ~15 legitimate signup calls the non-rate-limit
// tests below need cumulatively, so only the dedicated exhaustion test
// (which is last, deliberately, since the 1-hour window can't reset mid
// test-run) actually trips it.
process.env.SIGNUP_LIMIT_PER_HOUR = '30';
process.env.LOGIN_LIMIT_PER_15MIN = '8';
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

const request = require('supertest');
const app = require('../index');

let userCounter = 0;
function uniqueUsername() {
  userCounter += 1;
  return `testuser${userCounter}${Date.now()}`;
}

// Deliberately NOT async — supertest's Test object is itself
// thenable/chainable, so callers can do `await signup(...).expect(201)`.
// Wrapping in `async` would return a Promise instead of the Test object,
// breaking that chaining (bit us once already in connections.test.js).
function signup(username, password = 'a-fine-password', label = 'Test device') {
  return request(app).post('/auth/signup').send({ username, password, label });
}
function login(username, password = 'a-fine-password', label = 'Test device') {
  return request(app).post('/auth/login').send({ username, password, label });
}

test('signup creates a working token and a random display name', async () => {
  const username = uniqueUsername();
  const res = await signup(username).expect(201);
  assert.ok(res.body.token);
  assert.match(res.body.displayName, /^\w+ \w+$/, 'display name should be "adjective noun"');

  const meRes = await request(app)
    .get('/auth/me')
    .set('Authorization', `Bearer ${res.body.token}`)
    .expect(200);
  assert.equal(meRes.body.isAccount, true);
  assert.equal(meRes.body.displayName, res.body.displayName);
});

test('an anonymous token reports isAccount: false', async () => {
  const inboxRes = await request(app).post('/inbox').send({ label: 'anon' }).expect(201);
  const meRes = await request(app)
    .get('/auth/me')
    .set('Authorization', `Bearer ${inboxRes.body.token}`)
    .expect(200);
  assert.equal(meRes.body.isAccount, false);
  assert.equal(meRes.body.displayName, null);
});

test('duplicate username (case-insensitive) is rejected', async () => {
  const username = uniqueUsername();
  await signup(username).expect(201);
  const dupe = await signup(username.toUpperCase());
  assert.equal(dupe.status, 409);
});

test('password too short is rejected', async () => {
  const res = await signup(uniqueUsername(), 'short');
  assert.equal(res.status, 400);
});

test('username with invalid characters is rejected', async () => {
  const res = await signup('bad username!', 'a-fine-password');
  assert.equal(res.status, 400);
});

test('login with correct credentials mints a new working device token', async () => {
  const username = uniqueUsername();
  await signup(username).expect(201);
  const loginRes = await login(username, 'a-fine-password', 'Second device').expect(200);
  assert.ok(loginRes.body.token);

  const devicesRes = await request(app)
    .get('/auth/devices')
    .set('Authorization', `Bearer ${loginRes.body.token}`)
    .expect(200);
  assert.equal(devicesRes.body.devices.length, 2, 'signup device + login device');
});

test('wrong username and wrong password both return the same generic 401', async () => {
  const username = uniqueUsername();
  await signup(username).expect(201);

  const wrongPassword = await login(username, 'totally-wrong-password');
  const wrongUsername = await login('no-such-user-exists-xyz', 'a-fine-password');

  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongUsername.status, 401);
  assert.deepEqual(wrongPassword.body, wrongUsername.body, 'error shape must not reveal which case it was');
});

test('device list marks the calling device isCurrent, others not', async () => {
  await signup(uniqueUsername(), 'a-fine-password', 'PC'); // establishes username below is unique per-call
  const username = uniqueUsername();
  await signup(username, 'a-fine-password', 'PC').expect(201);
  const loginRes = await login(username, 'a-fine-password', 'Phone').expect(200);

  const devicesRes = await request(app)
    .get('/auth/devices')
    .set('Authorization', `Bearer ${loginRes.body.token}`)
    .expect(200);
  const current = devicesRes.body.devices.find((d) => d.isCurrent);
  const other = devicesRes.body.devices.find((d) => !d.isCurrent);
  assert.equal(current.label, 'Phone');
  assert.equal(other.label, 'PC');
});

test('revoking a device deletes it and its token stops working', async () => {
  const username = uniqueUsername();
  const signupRes = await signup(username, 'a-fine-password', 'PC').expect(201);
  const loginRes = await login(username, 'a-fine-password', 'Phone').expect(200);

  const devicesRes = await request(app)
    .get('/auth/devices')
    .set('Authorization', `Bearer ${loginRes.body.token}`)
    .expect(200);
  const phoneDevice = devicesRes.body.devices.find((d) => d.label === 'Phone');

  await request(app)
    .delete(`/auth/devices/${phoneDevice.id}`)
    .set('Authorization', `Bearer ${signupRes.body.token}`)
    .expect(200);

  await request(app)
    .get('/auth/me')
    .set('Authorization', `Bearer ${loginRes.body.token}`)
    .expect(401);
});

test('cannot revoke a device belonging to a different inbox', async () => {
  const userA = uniqueUsername();
  const userB = uniqueUsername();
  const signupA = await signup(userA).expect(201);
  const signupB = await signup(userB).expect(201);

  const devicesA = await request(app)
    .get('/auth/devices')
    .set('Authorization', `Bearer ${signupA.body.token}`)
    .expect(200);
  const deviceAId = devicesA.body.devices[0].id;

  await request(app)
    .delete(`/auth/devices/${deviceAId}`)
    .set('Authorization', `Bearer ${signupB.body.token}`)
    .expect(404);
});

test('login rate limit engages after repeated attempts', async () => {
  const username = uniqueUsername();
  await signup(username).expect(201);
  const attempts = [];
  for (let i = 0; i < 12; i++) {
    attempts.push(login(username, 'wrong-password'));
  }
  const results = await Promise.all(attempts);
  assert.ok(results.some((r) => r.status === 429), 'expected at least one 429 (limit is 8/15min)');
});

test('two simultaneous signups for the same username: exactly one succeeds', async () => {
  const username = uniqueUsername();
  const [a, b] = await Promise.all([signup(username), signup(username)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409], 'exactly one should succeed and one should get a clean 409, not a crash');
});

// Deliberately LAST: this exhausts the signup rate limit for the rest of
// the 1-hour window, which can't reset mid test-run, so nothing after this
// point may rely on a successful signup.
test('signup rate limit engages after repeated attempts', async () => {
  const attempts = [];
  for (let i = 0; i < 35; i++) {
    attempts.push(signup(`ratelimited${i}${Date.now()}`));
  }
  const results = await Promise.all(attempts);
  assert.ok(results.some((r) => r.status === 429), 'expected at least one 429 (limit is 30/hour)');
});
