const test = require('node:test');
const assert = require('node:assert/strict');
const sse = require('../lib/sse');

// Minimal fake ServerResponse: just enough for sse.js to subscribe to and
// write against, with an EventEmitter-shaped .on('close', ...) since
// subscribe() registers a cleanup handler on it.
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

test('broadcast delivers to every subscriber on the inbox when no exclusion is given', () => {
  const resA = fakeRes();
  const resB = fakeRes();
  sse.subscribe(9001, 1, resA);
  sse.subscribe(9001, 2, resB);

  sse.broadcast(9001, { id: 1, type: 'link', content: 'hello' });

  assert.equal(resA.writes.length, 1);
  assert.equal(resB.writes.length, 1);
});

test('broadcast skips the excluded device but still reaches everyone else', () => {
  const sender = fakeRes();
  const other = fakeRes();
  sse.subscribe(9002, 10, sender);
  sse.subscribe(9002, 20, other);

  sse.broadcast(9002, { id: 2, type: 'link', content: 'from device 10' }, 10);

  assert.equal(sender.writes.length, 0, "the sending device's own connection must not get the echo");
  assert.equal(other.writes.length, 1);
  assert.match(other.writes[0], /from device 10/);
});

test('a closed connection is removed and stops receiving further broadcasts', () => {
  const resA = fakeRes();
  sse.subscribe(9003, 1, resA);
  resA.triggerClose();

  sse.broadcast(9003, { id: 3, type: 'link', content: 'after close' });
  assert.equal(resA.writes.length, 0);
});
