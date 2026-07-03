const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const db = require('../db');
const { requireToken } = require('../auth');
const rateLimitHandler = require('../lib/rateLimitHandler');

const router = express.Router();

// /pair/status/:code is polled every 2 seconds by the initiating device
// while the connect screen is open (see web-client's pollInvite()) — that
// alone is ~30 requests/minute from completely normal, non-abusive use,
// before counting multiple browser tabs or a phone+desktop both polling.
// It used to share a single 20/min bucket with the mutating routes below,
// so just leaving the connect screen open for under a minute could exhaust
// it and make pairing look broken. It's read-only and cheap (one indexed
// SELECT), so it gets its own generous limiter instead of none at all.
const statusLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, handler: rateLimitHandler });

// The actual mutations are rare by comparison — one /init per connect
// attempt, one /claim per device joining — so a real, tighter limit here
// still protects against abuse without affecting normal usage.
const mutationLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, handler: rateLimitHandler });

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

// Matches CODE_ALPHABET at CODE_LENGTH exactly -- the same shape a
// server-generated code always has, just letting the caller suggest the
// specific value instead of always randomizing it (see Phase 2c's
// trusted-device auto-reconnect: both devices independently derive the
// same code from a locally-shared secret + a time window, so whichever
// calls /pair/init first can request that exact value, and the other
// device's /pair/claim then finds it already there without ever seeing a
// QR or typing anything). This is NOT a new server-side identity or
// account concept -- the server still only ever sees a short-lived,
// single-use, rate-limited ephemeral code exactly like any other; it just
// isn't always the one that generateCode() would have picked.
const PREFERRED_CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

// POST /pair/init — generates a code that adds the SECOND (and only the
// second) device to the caller's inbox. A pairing is exactly two devices,
// so this refuses to mint a code once that slot is already filled.
router.post('/init', mutationLimiter, requireToken, async (req, res) => {
  if (countDevices.get(req.device.inbox_id).count >= 2) {
    return res.status(409).json({ error: 'this pairing is already full' });
  }

  const now = Date.now();
  let code;
  const preferred = (req.body && req.body.preferredCode || '').toUpperCase();
  // Same availability check a random collision retry would need -- a
  // preferred code that's already taken (extremely unlikely in practice,
  // since it's derived from a secret+time-window only the other trusted
  // device knows) just falls back to a normal random one below, exactly
  // as if none was requested at all.
  if (PREFERRED_CODE_RE.test(preferred) && !getPairing.get(preferred)) {
    code = preferred;
  } else {
    // Extremely unlikely to collide, but guard anyway.
    for (let attempt = 0; attempt < 5; attempt++) {
      code = generateCode();
      if (!getPairing.get(code)) break;
    }
  }
  insertPairing.run(req.device.inbox_id, code, now, now + CODE_TTL_MS);

  const relayUrl = `${req.protocol}://${req.get('host')}`;
  // A real, openable URL (not bare JSON) so any phone camera can scan it
  // directly into a browser. Path-based (beamsend.com/ABC123) rather than
  // ?relay=&code= — nicer to share/read aloud, and the relay is always
  // implied by the link's own origin anyway (this same server serves both
  // the API and the web client — see relay-server/index.js). The web client
  // (see parsePairingLink() in web-client/src/app.js) still understands the
  // old ?relay=&code= query-string form too, for any link already in
  // circulation.
  const pairingUrl = `${relayUrl}/${code}`;
  const qrDataUrl = await QRCode.toDataURL(pairingUrl);

  res.json({ pairingCode: code, relayUrl, pairingUrl, qrDataUrl, expiresAt: now + CODE_TTL_MS });
});

// POST /pair/claim { pairingCode, label } — exchanges a short-lived code for
// a long-lived device token scoped to whichever inbox minted the code.
// Unauthenticated by necessity: the claiming device doesn't have a token yet.
// Claiming the second device is what starts the 2-minute session clock.
router.post('/claim', mutationLimiter, (req, res) => {
  // Query-param fallback alongside the JSON body: the iOS Shortcut (see
  // ios-shortcut/) builds its whole request as a URL string with an
  // embedded variable, which is a far simpler, less error-prone thing to
  // hand-author in Apple's Shortcuts file format than a JSON request body.
  // Body still wins if both are somehow present.
  const pairingCode = (req.body && req.body.pairingCode) || req.query.pairingCode;
  const label = (req.body && req.body.label) || req.query.label;
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

  // req.ip already respects index.js's `trust proxy` setting, so this is
  // the real client address (from X-Forwarded-For) rather than the
  // reverse proxy's own — same reasoning as the QR/pairing URL relying on
  // X-Forwarded-Proto. Purely informational: never written to the DB,
  // just computed fresh per-request and handed back so each device can
  // learn its own apparent address. Exchanging that with the other device
  // to actually compare and decide on a local-network fast-path (Phase 2b)
  // happens over the already-established /signal channel, not here.
  res.json({ token, expiresAt, remoteAddr: req.ip });
});

// GET /pair/status/:code — lets the initiating device (usually the desktop
// app) know once some client has claimed the code, without exposing the
// token. Also surfaces expiresAt once claimed, since the initiating device
// never calls /pair/claim itself and needs its own countdown start time.
router.get('/status/:code', statusLimiter, (req, res) => {
  const pairing = getPairing.get(req.params.code.toUpperCase());
  if (!pairing) {
    return res.status(404).json({ error: 'unknown pairing code' });
  }
  let expiresAt = null;
  if (pairing.status === 'claimed') {
    const inbox = getInbox.get(pairing.inbox_id);
    expiresAt = inbox ? inbox.expires_at : null;
  }
  // Same remoteAddr hint as /pair/claim above, for the initiating device —
  // it never calls /pair/claim itself, so this (already-polled) endpoint is
  // how it learns its own apparent address instead.
  res.json({ status: pairing.status, expiresAt, remoteAddr: req.ip });
});

module.exports = router;
