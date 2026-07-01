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

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => clearInterval(keepAlive));
});

module.exports = router;
