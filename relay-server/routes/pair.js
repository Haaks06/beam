const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const { requireToken } = require('../auth');

const router = express.Router();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000;
// A pairing only ever runs for 2 minutes once both devices are present —
// see lib/sessionCleanup.js, which deletes everything once expires_at passes.
const SESSION_DURATION_MS = 2 * 60 * 1000;

function generateCode() {
  let code = '';
  const bytes = crypto.randomBytes(CODE_LENGTH);
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

const insertPairing = db.prepare(
  `INSERT INTO pairing_requests (inbox_id, pairing_code, status, created_at, expires_at)
   VALUES (?, ?, 'pending', ?, ?)`
);
const getPairing = db.prepare('SELECT * FROM pairing_requests WHERE pairing_code = ?');
const claimPairing = db.prepare(
  `UPDATE pairing_requests SET status = 'claimed', issued_token = ? WHERE id = ?`
);
const insertDevice = db.prepare(
  `INSERT INTO devices (inbox_id, token, label, created_at) VALUES (?, ?, ?, ?)`
);
const countDevices = db.prepare('SELECT COUNT(*) AS count FROM devices WHERE inbox_id = ?');
const markPaired = db.prepare('UPDATE inboxes SET paired_at = ?, expires_at = ? WHERE id = ?');
const getInbox = db.prepare('SELECT * FROM inboxes WHERE id = ?');

// POST /pair/init — generates a code that adds the SECOND (and only the
// second) device to the caller's inbox. A pairing is exactly two devices,
// so this refuses to mint a code once that slot is already filled.
router.post('/init', requireToken, async (req, res) => {
  if (countDevices.get(req.device.inbox_id).count >= 2) {
    return res.status(409).json({ error: 'this pairing is already full' });
  }

  const now = Date.now();
  let code;
  // Extremely unlikely to collide, but guard anyway.
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generateCode();
    if (!getPairing.get(code)) break;
  }
  insertPairing.run(req.device.inbox_id, code, now, now + CODE_TTL_MS);

  const relayUrl = `${req.protocol}://${req.get('host')}`;
  // Encode a real, openable URL (not bare JSON) so any phone camera can
  // scan it directly into a browser. The web client reads ?relay=&code=
  // from the query string to prefill the pairing form.
  const pairingUrl = `${relayUrl}/?relay=${encodeURIComponent(relayUrl)}&code=${code}`;
  const qrDataUrl = await QRCode.toDataURL(pairingUrl);

  res.json({ pairingCode: code, relayUrl, pairingUrl, qrDataUrl, expiresAt: now + CODE_TTL_MS });
});

// POST /pair/claim { pairingCode, label } — exchanges a short-lived code for
// a long-lived device token scoped to whichever inbox minted the code.
// Unauthenticated by necessity: the claiming device doesn't have a token yet.
// Claiming the second device is what starts the 2-minute session clock.
router.post('/claim', (req, res) => {
  const { pairingCode, label } = req.body || {};
  if (!pairingCode || typeof pairingCode !== 'string') {
    return res.status(400).json({ error: 'pairingCode is required' });
  }

  const pairing = getPairing.get(pairingCode.toUpperCase());
  if (!pairing) {
    return res.status(404).json({ error: 'unknown pairing code' });
  }
  if (pairing.status !== 'pending') {
    return res.status(410).json({ error: 'pairing code already used' });
  }
  if (Date.now() > pairing.expires_at) {
    return res.status(410).json({ error: 'pairing code expired' });
  }
  // Re-checked here (not just in /init) to close the race where two
  // devices claim near-simultaneously and both would otherwise squeeze in.
  if (countDevices.get(pairing.inbox_id).count >= 2) {
    return res.status(409).json({ error: 'this pairing is already full' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  insertDevice.run(pairing.inbox_id, token, label || 'Unnamed device', now);
  claimPairing.run(token, pairing.id);

  let expiresAt = null;
  if (countDevices.get(pairing.inbox_id).count >= 2) {
    expiresAt = now + SESSION_DURATION_MS;
    markPaired.run(now, expiresAt, pairing.inbox_id);
  }

  res.json({ token, expiresAt });
});

// GET /pair/status/:code — lets the initiating device (usually the desktop
// app) know once some client has claimed the code, without exposing the
// token. Also surfaces expiresAt once claimed, since the initiating device
// never calls /pair/claim itself and needs its own countdown start time.
router.get('/status/:code', (req, res) => {
  const pairing = getPairing.get(req.params.code.toUpperCase());
  if (!pairing) {
    return res.status(404).json({ error: 'unknown pairing code' });
  }
  let expiresAt = null;
  if (pairing.status === 'claimed') {
    const inbox = getInbox.get(pairing.inbox_id);
    expiresAt = inbox ? inbox.expires_at : null;
  }
  res.json({ status: pairing.status, expiresAt });
});

module.exports = router;
