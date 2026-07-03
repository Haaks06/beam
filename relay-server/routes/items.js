const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const { requireToken } = require('../auth');
const {
  upload,
  uploadFile,
  uploadAudio,
  UPLOAD_DIR,
  ALLOWED_MIME_EXT,
  ALLOWED_FILE_EXT,
  ALLOWED_AUDIO_EXT,
  MAX_UPLOAD_BYTES,
} = require('../lib/upload');
const { sniffImageMime } = require('../lib/sniffImageType');
const { sniffDocMime, sniffAudioMime } = require('../lib/sniffFileType');
const sse = require('../lib/sse');

const router = express.Router();
router.use(requireToken);

const insertLink = db.prepare(
  `INSERT INTO items (inbox_id, type, content, source_label, created_at, from_device_id, encrypted)
   VALUES (?, 'link', ?, ?, ?, ?, ?)`
);
// Shared by every binary item type (photo, file, voice) — `type` is a bind
// param rather than hardcoded, exactly the same insert/getItem pattern
// photo uploads always used, just parameterized instead of duplicated per
// type.
const insertBinaryItem = db.prepare(
  `INSERT INTO items (inbox_id, type, file_path, mime_type, source_label, created_at, from_device_id, encrypted)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
// Accepted from a JSON body field, a multipart form field, or a query
// param (the last one specifically for the raw-body ingestion paths
// below, which have no form fields to carry it since the entire body is
// the file's bytes) — all three arrive as either the string "true" or the
// literal boolean true depending on how the client serialized it.
function isTruthyFlag(value) {
  return value === true || value === 'true';
}
// Excludes the caller's own sends (from_device_id = this device) — a shared
// inbox otherwise means your own history reappears in "Received" as if it
// had looped back, which is what actually happens live via SSE too (see
// the broadcast calls below). Older rows from before from_device_id
// existed have it NULL; treated as "not mine" (shown) rather than guessed.
const getItemsSince = db.prepare(
  'SELECT * FROM items WHERE inbox_id = ? AND id > ? AND (from_device_id IS NULL OR from_device_id != ?) ORDER BY id ASC'
);
// Scoped by inbox_id, not just id — otherwise item ids are guessable
// across inboxes and one inbox could fetch another inbox's uploads.
const getItem = db.prepare('SELECT * FROM items WHERE id = ? AND inbox_id = ?');

// Item types whose content lives on disk rather than in the `content`
// column — used below to decide which rows GET /:id/file may serve.
const BINARY_ITEM_TYPES = new Set(['photo', 'file', 'voice']);

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
  // Set when the sender already AES-GCM encrypted `content` client-side
  // (see Phase 2a) before it ever reached this server -- content is then
  // ciphertext (typically base64), stored and forwarded exactly as any
  // other item, decrypted only on the receiving device.
  const encrypted = isTruthyFlag((req.body && req.body.encrypted) || req.query.encrypted);

  const createdAt = Date.now();
  const result = insertLink.run(
    req.device.inbox_id,
    content,
    req.device.label,
    createdAt,
    req.device.id,
    encrypted ? 1 : 0
  );
  const item = {
    id: result.lastInsertRowid,
    type: 'link',
    content,
    sourceLabel: req.device.label,
    createdAt,
    encrypted,
  };
  // Excludes the sender's own connection — it already knows what it just
  // sent (see the confirmation status the client shows immediately), so
  // echoing it back over the live stream just looks like a stray receive.
  sse.broadcast(req.device.inbox_id, item, req.device.id);
  res.status(201).json(item);
});

// Shared by every binary item type's ingestion paths below: sniffs the
// real bytes on disk against each allowed format's magic number (see
// lib/sniffImageType.js and lib/sniffFileType.js) — a spoofed
// Content-Type/mimetype doesn't get a file accepted on its word alone —
// then records the item and broadcasts it. `sniffFn` and `allowedExtMap`
// are the only things that differ between photo/file/voice.
//
// `encrypted` skips that sniff entirely. This is a deliberate tradeoff,
// not an oversight: an AES-GCM-encrypted file's bytes are ciphertext, not
// its original content, so they will never match a real magic number no
// matter how genuine the original content was -- sniffing would reject
// every single encrypted upload outright. The cost is real and worth
// naming plainly: the relay can no longer verify an encrypted upload's
// content at all -- docs/THREAT_MODEL.md's "Malicious file content"
// section covers plain uploads being checked this way; that guarantee
// does not extend to anything sent with encrypted: true. Mitigated the
// same way the rest of an encrypted payload is: the relay was never meant
// to be able to inspect it, and decryption (where any content mismatch
// would surface) happens only on the receiving device, never here.
function finishBinaryUpload(req, res, { filename, declaredMime, encrypted, itemType, sniffFn, allowedExtMap }) {
  const filePath = path.join(UPLOAD_DIR, filename);
  if (!encrypted) {
    const head = Buffer.alloc(16);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    const actualMime = sniffFn(head);
    if (!actualMime || !allowedExtMap[actualMime]) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: `file content does not match an allowed ${itemType} type` });
    }
  }

  const createdAt = Date.now();
  const result = insertBinaryItem.run(
    req.device.inbox_id,
    itemType,
    filename,
    declaredMime,
    req.device.label,
    createdAt,
    req.device.id,
    encrypted ? 1 : 0
  );
  const item = {
    id: result.lastInsertRowid,
    type: itemType,
    mimeType: declaredMime,
    sourceLabel: req.device.label,
    createdAt,
    fileUrl: `/items/${result.lastInsertRowid}/file`,
    encrypted,
  };
  sse.broadcast(req.device.inbox_id, item, req.device.id);
  res.status(201).json(item);
}

// Wires up one binary item type's two ingestion paths:
//   1. A raw body (Content-Type: <one of allowedExtMap's keys>, bytes as
//      the entire body) — Apple's Shortcuts app can set a request body to
//      a file's raw contents directly, but hand-authoring a correct
//      multipart/form-data body in that file format is the single most
//      error-prone part of it (see ios-shortcut/). Only engaged when
//      Content-Type isn't multipart at all, so path 2 is unaffected.
//   2. The multipart form the web client uses.
// Exactly the same two-path shape POST /items/photo already used —
// generalized so /file and /voice below don't duplicate it a second and
// third time.
function registerUploadRoute(routePath, itemType, uploader, allowedExtMap, sniffFn) {
  const rawBody = express.raw({ type: Object.keys(allowedExtMap), limit: MAX_UPLOAD_BYTES });

  router.post(
    routePath,
    (req, res, next) => (req.is('multipart/form-data') ? next() : rawBody(req, res, next)),
    (req, res, next) => {
      if (req.is('multipart/form-data') || !Buffer.isBuffer(req.body) || req.body.length === 0) return next();
      const declaredMime = (req.get('content-type') || '').split(';')[0].trim();
      const ext = allowedExtMap[declaredMime] || '';
      const filename = `${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.body);
      // No form fields on this path (the whole body is the file), so
      // `encrypted` can only travel as a query param here.
      finishBinaryUpload(req, res, {
        filename,
        declaredMime,
        encrypted: isTruthyFlag(req.query.encrypted),
        itemType,
        sniffFn,
        allowedExtMap,
      });
    },
    uploader.single('file'),
    (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'file is required' });
      }
      finishBinaryUpload(req, res, {
        filename: req.file.filename,
        declaredMime: req.file.mimetype,
        encrypted: isTruthyFlag(req.body.encrypted),
        itemType,
        sniffFn,
        allowedExtMap,
      });
    }
  );
}

registerUploadRoute('/photo', 'photo', upload, ALLOWED_MIME_EXT, sniffImageMime);
registerUploadRoute('/file', 'file', uploadFile, ALLOWED_FILE_EXT, sniffDocMime);
registerUploadRoute('/voice', 'voice', uploadAudio, ALLOWED_AUDIO_EXT, sniffAudioMime);

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
    fileUrl: BINARY_ITEM_TYPES.has(row.type) ? `/items/${row.id}/file` : undefined,
    encrypted: !!row.encrypted,
  }));
  res.json({ items });
});

router.get('/:id/file', (req, res) => {
  const item = getItem.get(req.params.id, req.device.inbox_id);
  if (!item || !BINARY_ITEM_TYPES.has(item.type) || !item.file_path) {
    return res.status(404).json({ error: 'not found' });
  }
  const filePath = path.join(UPLOAD_DIR, item.file_path);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'file missing' });
  }
  res.sendFile(path.resolve(filePath));
});

module.exports = router;
