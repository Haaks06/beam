const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireToken } = require('../auth');
const { hashPassword, verifyPassword, DUMMY_HASH } = require('../lib/passwordHash');
const { randomDisplayName } = require('../lib/randomName');

const router = express.Router();

// A leaked/reused password is otherwise a permanent, invisible,
// unrevokable backdoor (no email, no password reset by design) — this cap
// stops a compromised credential from silently minting unlimited devices
// before anyone notices. Revoking one via DELETE /auth/devices/:id frees a
// slot.
const MAX_DEVICES_PER_INBOX = 20;

const insertInbox = db.prepare('INSERT INTO inboxes (created_at) VALUES (?)');
const insertDevice = db.prepare(
  'INSERT INTO devices (inbox_id, token, label, created_at) VALUES (?, ?, ?, ?)'
);
const insertAccount = db.prepare(
  'INSERT INTO accounts (username, password_hash, display_name, inbox_id, created_at) VALUES (?, ?, ?, ?, ?)'
);
const getAccountByUsername = db.prepare('SELECT * FROM accounts WHERE username = ?');
const getAccountByInboxId = db.prepare('SELECT * FROM accounts WHERE inbox_id = ?');
const countDevicesForInbox = db.prepare('SELECT COUNT(*) AS count FROM devices WHERE inbox_id = ?');
const listDevicesForInbox = db.prepare(
  'SELECT id, label, created_at, last_seen_at FROM devices WHERE inbox_id = ? ORDER BY created_at ASC'
);
const deleteDevice = db.prepare('DELETE FROM devices WHERE id = ? AND inbox_id = ?');

function isUniqueConstraintError(err) {
  return err && (err.errcode === 2067 || (err.message && err.message.includes('UNIQUE constraint failed')));
}

function normalizeUsername(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

// Mirrors POST /inbox's abuse concern (mass account creation), just also
// gated on a real credential now. Same reasoning as /inbox for the 30
// default — 5 was too easy to exhaust via normal retries/shared IPs.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.SIGNUP_LIMIT_PER_HOUR) || 30,
});
// Deliberately looser than admin's 5/15min — this is multi-tenant, and
// shared-IP/NAT households hitting it during normal use is a real,
// non-malicious case admin login never has to worry about.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_LIMIT_PER_15MIN) || 20,
});

router.post('/signup', signupLimiter, async (req, res) => {
  const { password, label } = req.body || {};
  const username = normalizeUsername(req.body && req.body.username);

  if (!/^[a-z0-9_-]{3,24}$/.test(username)) {
    return res.status(400).json({ error: 'username must be 3-24 characters: letters, numbers, _ or -' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'password must be 8-128 characters' });
  }

  // Friendly early check for the common case — NOT the authority. Once
  // hashPassword is awaited below, a second concurrent signup for the same
  // username could already have passed this same check; the UNIQUE
  // constraint on accounts.username at insert time is what actually
  // decides, caught below.
  if (getAccountByUsername.get(username)) {
    return res.status(409).json({ error: 'username already taken' });
  }

  const passwordHash = await hashPassword(password);
  const displayName = randomDisplayName();
  const now = Date.now();

  try {
    const inboxId = insertInbox.run(now).lastInsertRowid;
    const token = crypto.randomBytes(32).toString('hex');
    insertDevice.run(inboxId, token, label || 'Owner device', now);
    insertAccount.run(username, passwordHash, displayName, inboxId, now);
    res.status(201).json({ token, displayName });
  } catch (err) {
    // Leaves an orphaned, harmless, unreachable inbox+device pair on a
    // collision (no login path to it, no items) — same as an abandoned
    // POST /inbox call already does today with no cleanup.
    if (isUniqueConstraintError(err)) {
      return res.status(409).json({ error: 'username already taken' });
    }
    throw err;
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  const { password, label } = req.body || {};
  const username = normalizeUsername(req.body && req.body.username);

  const account = getAccountByUsername.get(username);
  // Always run a real verify, even on a lookup miss (against a fixed dummy
  // hash) — otherwise "no such user" returns near-instantly while "wrong
  // password" costs a full scrypt verify, a timing oracle for enumerating
  // valid usernames.
  const valid = await verifyPassword(
    typeof password === 'string' ? password : '',
    account ? account.password_hash : DUMMY_HASH
  );
  if (!account || !valid) {
    return res.status(401).json({ error: 'invalid username or password' });
  }

  const { count } = countDevicesForInbox.get(account.inbox_id);
  if (count >= MAX_DEVICES_PER_INBOX) {
    return res.status(403).json({ error: 'too many devices on this account — revoke one first' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  insertDevice.run(account.inbox_id, token, label || 'Device', Date.now());
  res.json({ token, displayName: account.display_name });
});

router.get('/me', requireToken, (req, res) => {
  const account = getAccountByInboxId.get(req.device.inbox_id);
  res.json({ isAccount: Boolean(account), displayName: account ? account.display_name : null });
});

router.get('/devices', requireToken, (req, res) => {
  const rows = listDevicesForInbox.all(req.device.inbox_id);
  res.json({
    devices: rows.map((d) => ({
      id: d.id,
      label: d.label,
      createdAt: d.created_at,
      lastSeenAt: d.last_seen_at,
      isCurrent: d.id === req.device.id,
    })),
  });
});

router.delete('/devices/:id', requireToken, (req, res) => {
  const result = deleteDevice.run(req.params.id, req.device.inbox_id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'device not found' });
  }
  res.json({ ok: true });
});

module.exports = router;
