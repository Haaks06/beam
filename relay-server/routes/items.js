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
  `INSERT INTO items (inbox_id, type, content, source_label, created_at) VALUES (?, 'link', ?, ?, ?)`
);
const insertPhoto = db.prepare(
  `INSERT INTO items (inbox_id, type, file_path, mime_type, source_label, created_at)
   VALUES (?, 'photo', ?, ?, ?, ?)`
);
const getItemsSince = db.prepare(
  'SELECT * FROM items WHERE inbox_id = ? AND id > ? ORDER BY id ASC'
);
// Scoped by inbox_id, not just id — otherwise item ids are guessable
// across inboxes and one inbox could fetch another inbox's photos.
const getItem = db.prepare('SELECT * FROM items WHERE id = ? AND inbox_id = ?');

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

  const createdAt = Date.now();
  const result = insertLink.run(req.device.inbox_id, content, req.device.label, createdAt);
  const item = { id: result.lastInsertRowid, type: 'link', content, sourceLabel: req.device.label, createdAt };
  sse.broadcast(req.device.inbox_id, item);
  res.status(201).json(item);
});

router.post('/photo', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'file is required' });
  }

  const createdAt = Date.now();
  const result = insertPhoto.run(
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
  };
  sse.broadcast(req.device.inbox_id, item);
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
