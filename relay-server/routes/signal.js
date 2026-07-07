const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireToken } = require('../auth');
const rateLimitHandler = require('../lib/rateLimitHandler');
const sse = require('../lib/sse');

const router = express.Router();
router.use(requireToken);

const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice-candidate', 'pubkey', 'unpaired']);

// ICE candidate exchange during connection setup is chatty — several
// candidates per attempt, from both sides — so this gets a much more
// generous bucket than /items' 120/min, sized to how bursty a real WebRTC
// handshake actually is rather than to abuse-prevention alone.
const signalLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, handler: rateLimitHandler });

// POST /signal { type, payload } — WebRTC/E2E-setup signaling (SDP
// offer/answer, ICE candidates, public-key exchange) between the two
// devices in a pairing. Deliberately NOT persisted anywhere: no table,
// nothing for lib/sessionCleanup.js to clean up, no replay/queue if the
// other side isn't listening right this second. This is scaffolding for
// establishing a connection, not a durable item — best-effort delivery is
// the whole point, and a dropped message just means the sender retries
// (the same way a real WebRTC handshake already tolerates lost candidates).
router.post('/', signalLimiter, (req, res) => {
  const { type, payload } = req.body || {};
  if (!type || !SIGNAL_TYPES.has(type)) {
    return res.status(400).json({ error: 'type must be one of: offer, answer, ice-candidate, pubkey, unpaired' });
  }

  const delivered = sse.sendSignal(req.device.inbox_id, req.device.id, { type, payload });
  if (!delivered) {
    return res.status(404).json({ error: 'the other device is not currently connected' });
  }
  res.status(202).json({ ok: true });
});

module.exports = router;
