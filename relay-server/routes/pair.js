const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const { requireToken } = require('../auth');

const router = express.Router();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000;

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

// POST /pair/init — adds ANOTHER device to the caller's own inbox (the
// caller must already hold a token, e.g. the desktop app or an existing
// phone). The generated code is scoped to req.device.inbox_id, so whoever
// claims it joins that same inbox, never a different one.
router.post('/init', requireToken, async (req, res) => {
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

  const token = crypto.randomBytes(32).toString('hex');
  insertDevice.run(pairing.inbox_id, token, label || 'Unnamed device', Date.now());
  claimPairing.run(token, pairing.id);

  res.json({ token });
});

// GET /pair/status/:code — lets the initiating device (usually the desktop
// app) know once some client has claimed the code, without exposing the token.
router.get('/status/:code', (req, res) => {
  const pairing = getPairing.get(req.params.code.toUpperCase());
  if (!pairing) {
    return res.status(404).json({ error: 'unknown pairing code' });
  }
  res.json({ status: pairing.status });
});

module.exports = router;
