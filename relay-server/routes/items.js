const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const db = require('../db');
const { requireToken } = require('../auth');
const { upload, UPLOAD_DIR } = require('../lib/upload');
const sse = require('../lib/sse');

const router = express.Router();
router.use(requireToken);

const insertLink = db.prepare(
  `INSERT INTO items (inbox_id, from_inbox_id, type, content, source_label, created_at) VALUES (?, ?, 'link', ?, ?, ?)`
);
const insertPhoto = db.prepare(
  `INSERT INTO items (inbox_id, from_inbox_id, type, file_path, mime_type, source_label, created_at)
   VALUES (?, ?, 'photo', ?, ?, ?, ?)`
);
const getItemsSince = db.prepare(
  'SELECT * FROM items WHERE inbox_id = ? AND id > ? ORDER BY id ASC'
);
// Scoped by inbox_id, not just id — otherwise item ids are guessable
// across inboxes and one inbox could fetch another inbox's photos.
const getItem = db.prepare('SELECT * FROM items WHERE id = ? AND inbox_id = ?');
const getConnectionById = db.prepare('SELECT * FROM connections WHERE id = ?');

// Resolves who an item should actually be delivered to. No `to` in the
// request body means today's exact behavior — send to your own inbox
// (device-sync). A `to` means "deliver to whoever's on the other side of
// this accepted connection" — resolved AND authorized in one lookup, since
// connection ids (not raw inbox ids) are what clients pass. Returns null
// (caller responds 404) for anything not usable: unknown connection,
// caller isn't a party to it, or it isn't accepted yet — same response for
// all three so connection ids can't be enumerated (mirrors routes/connections.js).
function resolveRecipientInboxId(req) {
  const { to } = req.body || {};
  if (!to) return req.device.inbox_id;

  const connection = getConnectionById.get(to);
  if (!connection || connection.status !== 'accepted') return null;
  if (connection.inbox_a_id !== req.device.inbox_id && connection.inbox_b_id !== req.device.inbox_id) {
    return null;
  }
  return connection.inbox_a_id === req.device.inbox_id ? connection.inbox_b_id : connection.inbox_a_id;
}

router.post('/link', (req, res) => {
  // Despite the route name, this accepts arbitrary text, not just http(s)
  // URLs — requiring a scheme meant typing "example.com" or pasting a note
  // failed outright. The web client only linkifies content that actually
  // parses as a URL; anything else renders as plain text.
  const { url } = req.body || {};
  const content = typeof url === 'string' ? url.trim() : '';
  if (!content) {
    return res.status(400).json({ error: 'text is required' });
  }

  const recipientInboxId = resolveRecipientInboxId(req);
  if (recipientInboxId === null) {
    return res.status(404).json({ error: 'connection not found' });
  }

  const createdAt = Date.now();
  const result = insertLink.run(recipientInboxId, req.device.inbox_id, content, req.device.label, createdAt);
  const item = {
    id: result.lastInsertRowid,
    type: 'link',
    content,
    sourceLabel: req.device.label,
    createdAt,
    isOwnDevice: recipientInboxId === req.device.inbox_id,
  };
  sse.broadcast(recipientInboxId, item);
  res.status(201).json(item);
});

router.post('/photo', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'file is required' });
  }

  const recipientInboxId = resolveRecipientInboxId(req);
  if (recipientInboxId === null) {
    return res.status(404).json({ error: 'connection not found' });
  }

  const createdAt = Date.now();
  const result = insertPhoto.run(
    recipientInboxId,
    req.device.inbox_id,
    req.file.filename,
    req.file.mimetype,
    req.device.label,
    createdAt
  );
  const item = {
    id: result.lastInsertRowid,
    type: 'photo',
    mimeType: req.file.mimetype,
    sourceLabel: req.device.label,
    createdAt,
    fileUrl: `/items/${result.lastInsertRowid}/file`,
    isOwnDevice: recipientInboxId === req.device.inbox_id,
  };
  sse.broadcast(recipientInboxId, item);
  res.status(201).json(item);
});

// GET /items?since=<id> — backlog/catch-up endpoint. SSE has no delivery
// guarantee across reconnects, so clients pull anything missed using this.
router.get('/', (req, res) => {
  const since = Number(req.query.since) || 0;
  const rows = getItemsSince.all(req.device.inbox_id, since);
  const items = rows.map((row) => ({
    id: row.id,
    type: row.type,
    content: row.content,
    mimeType: row.mime_type,
    sourceLabel: row.source_label,
    createdAt: row.created_at,
    fileUrl: row.type === 'photo' ? `/items/${row.id}/file` : undefined,
    // Derived boolean, never a raw inbox id — lets clients show "from a
    // friend" styling without ever seeing numeric ids on the wire.
    isOwnDevice: row.from_inbox_id === row.inbox_id,
  }));
  res.json({ items });
});

router.get('/:id/file', (req, res) => {
  const item = getItem.get(req.params.id, req.device.inbox_id);
  if (!item || item.type !== 'photo' || !item.file_path) {
    return res.status(404).json({ error: 'not found' });
  }
  const filePath = path.join(UPLOAD_DIR, item.file_path);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'file missing' });
  }
  res.sendFile(path.resolve(filePath));
});

module.exports = router;
