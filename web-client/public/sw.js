// Handles the Web Share Target POST from Android's native share sheet.
// Runs in the service worker, which has no access to localStorage, so the
// pairing token/relay URL are read from IndexedDB (written by src/app.js).

const DB_NAME = 'beam';
const STORE_NAME = 'config';
// Kept in sync with src/idb.js's DB_VERSION -- opening the same IndexedDB
// database at a lower version than it's already been upgraded to (by
// src/app.js, which added a second object store in version 2 for Phase
// 2c's trusted-device list) throws. This file doesn't need that store
// itself, so its own upgrade logic only ever touches CONFIG_STORE.
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getConfigValue(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShareTarget(event.request));
  }
});

async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const token = await getConfigValue('token');
    const relayUrl = await getConfigValue('relayUrl');
    if (!token || !relayUrl) {
      // /app, not the bare root — root now serves beamlot.com's marketing
      // landing page; the actual pairing app (which reads ?error=/?shared=
      // off the URL — see src/app.js) lives at /app.
      return Response.redirect('/app?error=not-paired', 303);
    }

    const url = formData.get('url') || formData.get('text');
    const photo = formData.get('photo');

    if (photo && photo.size > 0) {
      const fd = new FormData();
      fd.append('file', photo);
      await fetch(`${relayUrl}/items/photo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
    } else if (url) {
      await fetch(`${relayUrl}/items/link`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
    }

    return Response.redirect('/app?shared=ok', 303);
  } catch (err) {
    return Response.redirect('/app?shared=error', 303);
  }
}
