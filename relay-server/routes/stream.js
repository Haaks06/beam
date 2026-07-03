const express = require('express');
const { requireToken } = require('../auth');
const sse = require('../lib/sse');

const router = express.Router();

router.get('/', requireToken, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');

  sse.subscribe(req.device.inbox_id, req.device.id, res);

  // Shorter than before as a defensive margin against proxy/NAT idle
  // timeouts (mobile carriers in particular can be aggressive) — cheap
  // insurance against exactly the "keeps losing connection" symptom this
  // is meant to prevent. A named event rather than a bare `:` comment
  // specifically so the client can observe it (see the staleness watchdog
  // in web-client/src/app.js) — a pure comment line is invisible to
  // EventSource's API entirely, so the client would have no way to notice
  // "no ping in a while" as a sign of a silently-dead connection.
  const keepAlive = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 15000);
  req.on('close', () => clearInterval(keepAlive));
});

module.exports = router;
