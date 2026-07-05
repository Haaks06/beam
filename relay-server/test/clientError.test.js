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

test('POST /client-error accepts a report, unauthenticated, and logs it', async (t) => {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  t.after(() => {
    console.error = originalConsoleError;
  });

  await request(app)
    .post('/client-error')
    .send({ message: 'boom', stack: 'Error: boom\n  at x', url: 'https://example.com/app', userAgent: 'test-agent' })
    .expect(204);

  assert.ok(logged.some((args) => args[0] === '[client-error]' && args[1].includes('boom')));
});

test('POST /client-error tolerates a missing/malformed body', async () => {
  await request(app).post('/client-error').expect(204);
});

test('POST /client-error truncates oversized fields rather than storing them unbounded', async (t) => {
  const originalConsoleError = console.error;
  let loggedPayload = null;
  console.error = (...args) => {
    if (args[0] === '[client-error]') loggedPayload = JSON.parse(args[1]);
  };
  t.after(() => {
    console.error = originalConsoleError;
  });

  await request(app)
    .post('/client-error')
    .send({ message: 'x'.repeat(10000), stack: 'y'.repeat(10000) })
    .expect(204);

  assert.ok(loggedPayload.message.length <= 500);
  assert.ok(loggedPayload.stack.length <= 2000);
});

test('POST /client-error is rate limited', async () => {
  let sawLimit = false;
  for (let i = 0; i < 40; i++) {
    const res = await request(app).post('/client-error').send({ message: `error ${i}` });
    if (res.status === 429) {
      sawLimit = true;
      break;
    }
  }
  assert.ok(sawLimit, 'expected to hit the client-error rate limit');
});
