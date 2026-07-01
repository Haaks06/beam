const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');

const router = express.Router();

const insertInbox = db.prepare('INSERT INTO inboxes (created_at) VALUES (?)');
const insertDevice = db.prepare(
  `INSERT INTO devices (inbox_id, token, label, created_at) VALUES (?, ?, ?, ?)`
);

// POST /inbox — creates a brand new, isolated inbox and mints its first
// (owner) device token in one round trip. This is the ONLY place a new
// inbox_id is ever minted; every other endpoint operates within an inbox
// that already exists. Unauthenticated by necessity — there's no token yet.
router.post('/', (req, res) => {
  const { label } = req.body || {};
  const now = Date.now();

  const inboxResult = insertInbox.run(now);
  const inboxId = inboxResult.lastInsertRowid;

  const token = crypto.randomBytes(32).toString('hex');
  insertDevice.run(inboxId, token, label || 'Owner device', now);

  res.status(201).json({ inboxId, token, label: label || 'Owner device' });
});

module.exports = router;
