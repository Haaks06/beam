const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');

const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads';
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 15 * 1024 * 1024;

// Unlike DB_PATH's directory (created in db.js), nothing else ever creates
// this. Worked locally by accident — the repo ships data/uploads/.gitkeep
// — but a fresh volume (e.g. Fly.io's empty /data mount) has no such
// directory, so every photo upload failed with ENOENT until first fixed here.
fs.mkdirSync(path.resolve(UPLOAD_DIR), { recursive: true });

const ALLOWED_MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Never trust the client-supplied filename: generate our own to avoid
    // path traversal / overwrite tricks.
    const ext = ALLOWED_MIME_EXT[file.mimetype] || '';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_EXT[file.mimetype]) {
      return cb(new Error('unsupported file type'));
    }
    cb(null, true);
  },
});

module.exports = { upload, UPLOAD_DIR, ALLOWED_MIME_EXT, MAX_UPLOAD_BYTES };
