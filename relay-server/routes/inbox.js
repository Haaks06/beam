const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const { clampSessionDuration } = require('../lib/sessionDuration');

const router = express.Router();

const insertInbox = db.prepare('INSERT INTO inboxes (created_at, session_duration_ms) VALUES (?, ?)');
const insertDevice = db.prepare(
  `INSERT INTO devices (inbox_id, token, label, created_at) VALUES (?, ?, ?, ?)`
);

// POST /inbox — creates a brand new, isolated inbox and mints its first
// (owner) device token in one round trip. This is the ONLY place a new
// inbox_id is ever minted; every other endpoint operates within an inbox
// that already exists. Unauthenticated by necessity — there's no token yet.
// The initiating device chooses how long the session will run once a second
// device joins (see routes/pair.js's /claim) — clamped server-side so a
// client can't ask for an unbounded hold on relay resources.
router.post('/', (req, res) => {
  const { label, sessionDurationMs } = req.body || {};
  const now = Date.now();
  const duration = clampSessionDuration(sessionDurationMs);

  const inboxResult = insertInbox.run(now, duration);
  const inboxId = inboxResult.lastInsertRowid;

  const token = crypto.randomBytes(32).toString('hex');
  insertDevice.run(inboxId, token, label || 'Owner device', now);

  res.status(201).json({ inboxId, token, label: label || 'Owner device' });
});

module.exports = router;
