const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { app } = require('electron');

const LINKS_DIR = path.join(app.getPath('documents'), 'Beam');
const PHOTOS_DIR = path.join(app.getPath('pictures'), 'Beam');
const FILES_DIR = path.join(app.getPath('documents'), 'Beam Files');
const VOICE_DIR = path.join(app.getPath('music'), 'Beam');
const LINKS_FILE = path.join(LINKS_DIR, 'links.jsonl');

function ensureFolders() {
  fs.mkdirSync(LINKS_DIR, { recursive: true });
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.mkdirSync(VOICE_DIR, { recursive: true });
}

function saveLink(item) {
  ensureFolders();
  const line = JSON.stringify({
    url: item.content,
    source: item.sourceLabel,
    timestamp: item.createdAt,
  });
  fs.appendFileSync(LINKS_FILE, line + '\n');
}

function extensionForMime(mimeType) {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/heic':
      return '.heic';
    case 'application/pdf':
      return '.pdf';
    case 'application/msword':
      return '.doc';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return '.docx';
    case 'application/zip':
    case 'application/x-zip-compressed':
      return '.zip';
    case 'audio/webm':
      return '.webm';
    case 'audio/ogg':
      return '.ogg';
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    case 'audio/mp4':
      return '.m4a';
    case 'audio/mpeg':
      return '.mp3';
    default:
      return '';
  }
}

// Shared by savePhoto/saveFile/saveVoiceMemo below. Handles both delivery
// shapes an item can arrive in:
// - P2P-direct (item.dataBase64 set): the bytes are already here in full —
//   a direct WebRTC transfer never touches the relay at all, so there's no
//   fileUrl to download from in the first place.
// - Relay-delivered (item.fileUrl set): fetched from the relay the same
//   way this always worked for photos.
function saveBinaryItem(item, relayUrl, token, destDir, filenamePrefix) {
  fs.mkdirSync(destDir, { recursive: true });
  const ext = extensionForMime(item.mimeType) || (item.filename ? path.extname(item.filename) : '');
  const baseName = item.filename ? path.parse(item.filename).name : `${filenamePrefix}-${item.createdAt}`;
  const filename = `${baseName}${item.id != null ? `-${item.id}` : ''}${ext}`;
  const destPath = path.join(destDir, filename);

  if (item.dataBase64) {
    fs.writeFileSync(destPath, Buffer.from(item.dataBase64, 'base64'));
    return Promise.resolve(destPath);
  }

  const url = new URL(item.fileUrl, relayUrl);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    client
      .get(url, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`failed to download ${filenamePrefix}: ${res.statusCode}`));
        }
        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => resolve(destPath));
        fileStream.on('error', reject);
      })
      .on('error', reject);
  });
}

function savePhoto(item, relayUrl, token) {
  return saveBinaryItem(item, relayUrl, token, PHOTOS_DIR, 'photo');
}

function saveFile(item, relayUrl, token) {
  return saveBinaryItem(item, relayUrl, token, FILES_DIR, 'file');
}

function saveVoiceMemo(item, relayUrl, token) {
  return saveBinaryItem(item, relayUrl, token, VOICE_DIR, 'voice');
}

module.exports = {
  saveLink,
  savePhoto,
  saveFile,
  saveVoiceMemo,
  LINKS_DIR,
  PHOTOS_DIR,
  FILES_DIR,
  VOICE_DIR,
  ensureFolders,
};
