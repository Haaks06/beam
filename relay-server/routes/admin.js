const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { verifyCredentials, issueSessionToken, requireAdmin, COOKIE_NAME } = require('../lib/adminAuth');

const router = express.Router();

// Much stricter than the general per-prefix limiters elsewhere — this
// guards a single static credential against online brute force.
// timingSafeEqual (see lib/adminAuth.js) only stops timing side-channels,
// nothing stops someone just guessing repeatedly without this.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5 });

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!verifyCredentials(username, password)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = issueSessionToken();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    // req.secure respects `trust proxy` (already set in index.js), so this
    // is true behind Fly's HTTPS proxy in production and false for local
    // http://localhost dev — hardcoding true would silently break local
    // admin login testing entirely (browsers drop Secure cookies over http).
    secure: req.secure,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// Read-only for v1 — smallest reasonable admin surface. No destructive
// actions (delete inbox, revoke token, etc.) until there's an actual need.
router.get('/inboxes', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT i.id, i.created_at,
         (SELECT COUNT(*) FROM devices d WHERE d.inbox_id = i.id) AS deviceCount,
         (SELECT COUNT(*) FROM items it WHERE it.inbox_id = i.id) AS itemCount
       FROM inboxes i ORDER BY i.created_at DESC`
    )
    .all();
  res.json({ inboxes: rows });
});

router.get('/connections', requireAdmin, (req, res) => {
  const rows = db
    .prepare('SELECT id, status, created_at, responded_at FROM connections ORDER BY created_at DESC')
    .all();
  res.json({ connections: rows });
});

module.exports = router;
