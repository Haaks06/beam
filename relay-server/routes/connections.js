const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const { requireToken } = require('../auth');

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

const insertConnectCode = db.prepare(
  `INSERT INTO connect_codes (inbox_id, label, code, status, created_at, expires_at)
   VALUES (?, ?, ?, 'pending', ?, ?)`
);
const getConnectCode = db.prepare("SELECT * FROM connect_codes WHERE code = ? AND status = 'pending'");
const claimConnectCode = db.prepare("UPDATE connect_codes SET status = 'claimed' WHERE id = ?");

const getConnectionByPair = db.prepare(
  'SELECT * FROM connections WHERE inbox_a_id = ? AND inbox_b_id = ?'
);
const insertConnection = db.prepare(
  `INSERT INTO connections
     (inbox_a_id, inbox_b_id, requester_inbox_id, target_inbox_id, requester_label, target_label, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
);
const resetConnectionToPending = db.prepare(
  `UPDATE connections
   SET requester_inbox_id = ?, target_inbox_id = ?, requester_label = ?, target_label = ?,
       status = 'pending', responded_at = NULL, created_at = ?
   WHERE id = ?`
);
const getConnectionById = db.prepare('SELECT * FROM connections WHERE id = ?');
const listConnectionsForInbox = db.prepare(
  'SELECT * FROM connections WHERE inbox_a_id = ? OR inbox_b_id = ? ORDER BY created_at DESC'
);
const setConnectionStatus = db.prepare(
  'UPDATE connections SET status = ?, responded_at = ? WHERE id = ?'
);

// POST /connect/init — mints a short-lived code that invites someone ELSE
// (a different inbox, not another of your own devices — see pair.js for
// that) to connect with you. The code owner becomes the "target": only
// they can accept the resulting connection request, never the claimer.
const initRouter = express.Router();
initRouter.post('/init', requireToken, async (req, res) => {
  const { label } = req.body || {};
  const now = Date.now();
  let code;
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generateCode();
    if (!db.prepare('SELECT 1 FROM connect_codes WHERE code = ?').get(code)) break;
  }
  insertConnectCode.run(req.device.inbox_id, label || null, code, now, now + CODE_TTL_MS);

  const relayUrl = `${req.protocol}://${req.get('host')}`;
  // Distinct query param name (connectCode, not code) so the web client can
  // tell "add a friend" apart from "add my own device" QR scans.
  const connectUrl = `${relayUrl}/?connectRelay=${encodeURIComponent(relayUrl)}&connectCode=${code}`;
  const qrDataUrl = await QRCode.toDataURL(connectUrl);

  res.json({ connectCode: code, relayUrl, connectUrl, qrDataUrl, expiresAt: now + CODE_TTL_MS });
});

// POST /connect/claim — unlike pair/claim, the caller here already has
// their OWN inbox/token (they're connecting AS themselves, not becoming a
// new device on someone else's inbox), so this requires auth. Creates a
// PENDING connection — claiming never grants access on its own; the target
// must separately accept it via POST /connections/:id/accept.
initRouter.post('/claim', requireToken, (req, res) => {
  const { code, label } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'code is required' });
  }

  const connectCode = getConnectCode.get(code.trim().toUpperCase());
  if (!connectCode || Date.now() > connectCode.expires_at) {
    return res.status(404).json({ error: 'unknown or expired code' });
  }

  const targetInboxId = connectCode.inbox_id;
  const requesterInboxId = req.device.inbox_id;
  if (targetInboxId === requesterInboxId) {
    return res.status(400).json({ error: "you can't connect to yourself — use Pair a device instead" });
  }

  claimConnectCode.run(connectCode.id);

  const inboxAId = Math.min(targetInboxId, requesterInboxId);
  const inboxBId = Math.max(targetInboxId, requesterInboxId);
  const existing = getConnectionByPair.get(inboxAId, inboxBId);
  const now = Date.now();

  let connectionId;
  if (!existing) {
    const result = insertConnection.run(
      inboxAId,
      inboxBId,
      requesterInboxId,
      targetInboxId,
      label || null,
      connectCode.label,
      now
    );
    connectionId = result.lastInsertRowid;
  } else if (existing.status === 'accepted') {
    // Already connected — claiming a fresh code from an existing friend is
    // a no-op, not a downgrade back to pending.
    connectionId = existing.id;
  } else {
    // Re-request after a rejection (or a stale pending from the other
    // direction) — reuse the one row for this pair instead of erroring on
    // the UNIQUE constraint, resetting whoever claimed this time as requester.
    resetConnectionToPending.run(requesterInboxId, targetInboxId, label || null, connectCode.label, now, existing.id);
    connectionId = existing.id;
  }

  const connection = getConnectionById.get(connectionId);
  res.status(201).json({ connectionId, status: connection.status });
});

// GET /connections + accept/reject — never expose raw inbox ids or leak
// whether a connection exists to a caller who isn't a party to it: a
// nonexistent id and "you're not part of this connection" return the
// identical generic response, so connection ids can't be enumerated to
// discover who's connected to whom.
const connectionsRouter = express.Router();

const getAccountDisplayNameByInboxId = db.prepare('SELECT display_name FROM accounts WHERE inbox_id = ?');

// Prefers the OTHER party's real account display_name (e.g. "frenzy
// horse") over whatever free-text label was supplied at claim/init time,
// looked up at READ time rather than baked in when the connection was
// created. Read-time means this self-heals: someone who connected while
// anonymous and later signs up for an account automatically shows their
// real name on existing connections, with no backfill needed. Falls back
// to the stored label for still-anonymous inboxes — unchanged behavior.
function serialize(row, callerInboxId) {
  const isTarget = row.target_inbox_id === callerInboxId;
  const otherInboxId = isTarget ? row.requester_inbox_id : row.target_inbox_id;
  const otherAccount = getAccountDisplayNameByInboxId.get(otherInboxId);
  const fallbackLabel = isTarget ? row.requester_label : row.target_label;
  return {
    id: row.id,
    role: isTarget ? 'target' : 'requester',
    otherLabel: (otherAccount && otherAccount.display_name) || fallbackLabel || 'Unnamed',
    status: row.status,
    createdAt: row.created_at,
  };
}

connectionsRouter.get('/', requireToken, (req, res) => {
  const rows = listConnectionsForInbox.all(req.device.inbox_id, req.device.inbox_id);
  res.json({ connections: rows.map((row) => serialize(row, req.device.inbox_id)) });
});

function respondToConnection(status) {
  return (req, res) => {
    const row = getConnectionById.get(req.params.id);
    // Same 404 whether the row doesn't exist, the caller isn't a party to
    // it, or the caller IS a party but isn't the target (e.g. the
    // requester trying to accept their own request) — no differentiated
    // response that could help enumerate connections.
    if (!row || row.target_inbox_id !== req.device.inbox_id || row.status !== 'pending') {
      return res.status(404).json({ error: 'connection not found' });
    }
    setConnectionStatus.run(status, Date.now(), row.id);
    res.json({ id: row.id, status });
  };
}

connectionsRouter.post('/:id/accept', requireToken, respondToConnection('accepted'));
connectionsRouter.post('/:id/reject', requireToken, respondToConnection('rejected'));

module.exports = { initRouter, connectionsRouter };
