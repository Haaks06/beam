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

  sse.subscribe(req.device.inbox_id, res);

  // Shorter than before as a defensive margin against proxy/NAT idle
  // timeouts (mobile carriers in particular can be aggressive) — cheap
  // insurance against exactly the "keeps losing connection" symptom this
  // is meant to prevent.
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(keepAlive));
});

module.exports = router;
