const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-to-pc-test-'));
process.env.DB_PATH = path.join(tmpDir, 'relay.sqlite');
process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
process.env.INBOX_LIMIT_PER_HOUR = '3';
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

const request = require('supertest');
const app = require('../index');

test('creating an inbox returns a usable token in one call', async () => {
  const res = await request(app).post('/inbox').send({}).expect(201);
  assert.ok(res.body.inboxId);
  assert.ok(res.body.token);
  assert.equal(res.body.token.length, 64);
  assert.equal(res.body.label, 'Owner device');

  // The token works immediately, with no follow-up /pair/claim needed.
  const listRes = await request(app)
    .get('/items?since=0')
    .set('Authorization', `Bearer ${res.body.token}`)
    .expect(200);
  assert.deepEqual(listRes.body.items, []);
});

test('creating an inbox honors a custom label', async () => {
  const res = await request(app).post('/inbox').send({ label: 'My Laptop' }).expect(201);
  assert.equal(res.body.label, 'My Laptop');
});

test('inbox creation is rate limited', async () => {
  // INBOX_LIMIT_PER_HOUR=3 above; this test alone already used 2 inboxes,
  // so a couple more calls should trip the limiter.
  let sawLimit = false;
  for (let i = 0; i < 5; i++) {
    const res = await request(app).post('/inbox').send({});
    if (res.status === 429) {
      sawLimit = true;
      break;
    }
  }
  assert.ok(sawLimit, 'expected to hit the inbox creation rate limit');
});
