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

// Generic small files (Phase 1d) — PDF, Word docs (old binary .doc and
// modern .docx), ZIP. .docx (and .xlsx/.pptx) are themselves ZIP
// containers under the hood, so lib/sniffFileType.js can only confirm "a
// valid ZIP" for those, not distinguish the exact Office format — the
// declared/stored mimeType still reflects whatever the client claimed.
const ALLOWED_FILE_EXT = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
};

// Voice memos (Phase 1d/2d) — covers MediaRecorder's default output
// across Chrome/Firefox/Safari plus standalone audio files.
const ALLOWED_AUDIO_EXT = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
};

// Same multer setup as the original photo-only uploader, parameterized by
// which allowlist applies — the actual security-relevant check (real
// bytes vs. an allowed magic number) happens after upload in routes/
// items.js, same as it always has; this filter is just the cheap
// declared-Content-Type-based first pass multer needs up front.
function makeUploader(allowedMimeExt) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      // Never trust the client-supplied filename: generate our own to avoid
      // path traversal / overwrite tricks.
      const ext = allowedMimeExt[file.mimetype] || '';
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });

  return multer({
    storage,
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      if (!allowedMimeExt[file.mimetype]) {
        return cb(new Error('unsupported file type'));
      }
      cb(null, true);
    },
  });
}

const upload = makeUploader(ALLOWED_MIME_EXT);
const uploadFile = makeUploader(ALLOWED_FILE_EXT);
const uploadAudio = makeUploader(ALLOWED_AUDIO_EXT);

module.exports = {
  upload,
  uploadFile,
  uploadAudio,
  UPLOAD_DIR,
  ALLOWED_MIME_EXT,
  ALLOWED_FILE_EXT,
  ALLOWED_AUDIO_EXT,
  MAX_UPLOAD_BYTES,
};
