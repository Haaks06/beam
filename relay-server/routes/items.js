const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const { requireToken } = require('../auth');
const { upload, UPLOAD_DIR, ALLOWED_MIME_EXT, MAX_UPLOAD_BYTES } = require('../lib/upload');
const { sniffImageMime } = require('../lib/sniffImageType');
const sse = require('../lib/sse');

const router = express.Router();
router.use(requireToken);

const insertLink = db.prepare(
  `INSERT INTO items (inbox_id, type, content, source_label, created_at, from_device_id) VALUES (?, 'link', ?, ?, ?, ?)`
);
const insertPhoto = db.prepare(
  `INSERT INTO items (inbox_id, type, file_path, mime_type, source_label, created_at, from_device_id)
   VALUES (?, 'photo', ?, ?, ?, ?, ?)`
);
// Excludes the caller's own sends (from_device_id = this device) — a shared
// inbox otherwise means your own history reappears in "Received" as if it
// had looped back, which is what actually happens live via SSE too (see
// the broadcast calls below). Older rows from before from_device_id
// existed have it NULL; treated as "not mine" (shown) rather than guessed.
const getItemsSince = db.prepare(
  'SELECT * FROM items WHERE inbox_id = ? AND id > ? AND (from_device_id IS NULL OR from_device_id != ?) ORDER BY id ASC'
);
// Scoped by inbox_id, not just id — otherwise item ids are guessable
// across inboxes and one inbox could fetch another inbox's photos.
const getItem = db.prepare('SELECT * FROM items WHERE id = ? AND inbox_id = ?');

router.post('/link', (req, res) => {
  // Despite the route name, this accepts arbitrary text, not just http(s)
  // URLs — requiring a scheme meant typing "example.com" or pasting a note
  // failed outright. The web client only linkifies content that actually
  // parses as a URL; anything else renders as plain text.
  //
  // Query-param fallback alongside the JSON body: the iOS Shortcut (see
  // ios-shortcut/) builds this as a URL string with embedded variables
  // (token + the shared content) rather than a JSON body — much simpler to
  // hand-author correctly in Apple's Shortcuts file format.
  const url = (req.body && req.body.url) || req.query.url;
  const content = typeof url === 'string' ? url.trim() : '';
  if (!content) {
    return res.status(400).json({ error: 'text is required' });
  }

  const createdAt = Date.now();
  const result = insertLink.run(req.device.inbox_id, content, req.device.label, createdAt, req.device.id);
  const item = {
    id: result.lastInsertRowid,
    type: 'link',
    content,
    sourceLabel: req.device.label,
    createdAt,
  };
  // Excludes the sender's own connection — it already knows what it just
  // sent (see the confirmation status the client shows immediately), so
  // echoing it back over the live stream just looks like a stray receive.
  sse.broadcast(req.device.inbox_id, item, req.device.id);
  res.status(201).json(item);
});

// Shared by both ingestion paths below: sniffs the real bytes on disk
// against each allowed format's magic number (see lib/sniffImageType.js) —
// a spoofed Content-Type/mimetype doesn't get a file accepted on its word
// alone — then records the item and broadcasts it.
function finishPhotoUpload(req, res, filename, declaredMime) {
  const filePath = path.join(UPLOAD_DIR, filename);
  const head = Buffer.alloc(16);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  const actualMime = sniffImageMime(head);
  if (!actualMime || !ALLOWED_MIME_EXT[actualMime]) {
    fs.unlinkSync(filePath);
    return res.status(400).json({ error: 'file content does not match an allowed image type' });
  }

  const createdAt = Date.now();
  const result = insertPhoto.run(
    req.device.inbox_id,
    filename,
    declaredMime,
    req.device.label,
    createdAt,
    req.device.id
  );
  const item = {
    id: result.lastInsertRowid,
    type: 'photo',
    mimeType: declaredMime,
    sourceLabel: req.device.label,
    createdAt,
    fileUrl: `/items/${result.lastInsertRowid}/file`,
  };
  sse.broadcast(req.device.inbox_id, item, req.device.id);
  res.status(201).json(item);
}

// A raw image body (Content-Type: image/jpeg etc, bytes as the entire
// body) is a second, simpler way in alongside the multipart form the web
// client uses — Apple's Shortcuts app can set a request body to a file's
// raw contents directly, but hand-authoring a correct multipart/form-data
// body in that file format is the single most error-prone part of it (see
// ios-shortcut/). Only engaged when Content-Type isn't multipart at all,
// so the existing web-client upload path below is completely unaffected.
const rawImageBody = express.raw({ type: Object.keys(ALLOWED_MIME_EXT), limit: MAX_UPLOAD_BYTES });

router.post(
  '/photo',
  (req, res, next) => (req.is('multipart/form-data') ? next() : rawImageBody(req, res, next)),
  (req, res, next) => {
    if (req.is('multipart/form-data') || !Buffer.isBuffer(req.body) || req.body.length === 0) return next();
    const declaredMime = (req.get('content-type') || '').split(';')[0].trim();
    const ext = ALLOWED_MIME_EXT[declaredMime] || '';
    const filename = `${crypto.randomUUID()}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.body);
    finishPhotoUpload(req, res, filename, declaredMime);
  },
  upload.single('file'),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'file is required' });
    }
    finishPhotoUpload(req, res, req.file.filename, req.file.mimetype);
  }
);

// GET /items?since=<id> — backlog/catch-up endpoint. SSE has no delivery
// guarantee across reconnects, so clients pull anything missed using this.
router.get('/', (req, res) => {
  const since = Number(req.query.since) || 0;
  const rows = getItemsSince.all(req.device.inbox_id, since, req.device.id);
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
