const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { app } = require('electron');

const LINKS_DIR = path.join(app.getPath('documents'), 'Beam');
const PHOTOS_DIR = path.join(app.getPath('pictures'), 'Beam');
const LINKS_FILE = path.join(LINKS_DIR, 'links.jsonl');

function ensureFolders() {
  fs.mkdirSync(LINKS_DIR, { recursive: true });
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
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
    default:
      return '';
  }
}

function savePhoto(item, relayUrl, token) {
  ensureFolders();
  const ext = extensionForMime(item.mimeType);
  const filename = `${item.createdAt}-${item.id}${ext}`;
  const destPath = path.join(PHOTOS_DIR, filename);

  const url = new URL(item.fileUrl, relayUrl);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    client
      .get(url, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`failed to download photo: ${res.statusCode}`));
        }
        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => resolve(destPath));
        fileStream.on('error', reject);
      })
      .on('error', reject);
  });
}

module.exports = { saveLink, savePhoto, LINKS_DIR, PHOTOS_DIR, ensureFolders };
