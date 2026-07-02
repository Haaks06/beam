const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const sse = require('./sse');
const { UPLOAD_DIR } = require('./upload');

// Never-paired inboxes (someone generated a code and nobody ever scanned
// it) don't have an expires_at yet — reuse the pairing code's own TTL so
// these don't linger forever either. Kept in sync with routes/pair.js's
// CODE_TTL_MS by value rather than import, since the two are conceptually
// independent knobs that only happen to match today.
const ABANDONED_TTL_MS = 10 * 60 * 1000;

const getExpiredPairedInboxes = db.prepare(
  'SELECT id FROM inboxes WHERE expires_at IS NOT NULL AND expires_at <= ?'
);
const getAbandonedInboxes = db.prepare(
  'SELECT id FROM inboxes WHERE paired_at IS NULL AND created_at <= ?'
);
const getFilePaths = db.prepare(
  "SELECT file_path FROM items WHERE inbox_id = ? AND file_path IS NOT NULL"
);
const deleteItems = db.prepare('DELETE FROM items WHERE inbox_id = ?');
const deleteDevices = db.prepare('DELETE FROM devices WHERE inbox_id = ?');
const deletePairingRequests = db.prepare('DELETE FROM pairing_requests WHERE inbox_id = ?');
const deleteInbox = db.prepare('DELETE FROM inboxes WHERE id = ?');

function destroyInbox(inboxId) {
  sse.expireInbox(inboxId);
  for (const row of getFilePaths.all(inboxId)) {
    fs.unlink(path.join(UPLOAD_DIR, row.file_path), () => {
      // Best-effort — an already-missing file is not an error here.
    });
  }
  deleteItems.run(inboxId);
  deleteDevices.run(inboxId);
  deletePairingRequests.run(inboxId);
  deleteInbox.run(inboxId);
}

// One inbox failing to delete (an unexpected FK reference, a locked file,
// anything) must never take the other rows in this sweep — or the whole
// process, since this runs on an unattended timer — down with it. Learned
// this the hard way: a single row's DELETE hitting a constraint violation
// once crashed the server on every 5-second tick until it hit Fly's max
// restart count.
function sweep() {
  const now = Date.now();
  for (const { id } of getExpiredPairedInboxes.all(now)) {
    try {
      destroyInbox(id);
    } catch (err) {
      console.error(`sessionCleanup: failed to destroy expired inbox ${id}`, err);
    }
  }
  for (const { id } of getAbandonedInboxes.all(now - ABANDONED_TTL_MS)) {
    try {
      destroyInbox(id);
    } catch (err) {
      console.error(`sessionCleanup: failed to destroy abandoned inbox ${id}`, err);
    }
  }
}

function startSessionCleanup(intervalMs = 5000) {
  return setInterval(sweep, intervalMs);
}

module.exports = { startSessionCleanup, sweep };
