// Handles the Web Share Target POST from Android's native share sheet.
// Runs in the service worker, which has no access to localStorage, so the
// pairing token/relay URL are read from IndexedDB (written by src/app.js).

const DB_NAME = 'share-to-pc';
const STORE_NAME = 'config';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
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
      return Response.redirect('/?error=not-paired', 303);
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

    return Response.redirect('/?shared=ok', 303);
  } catch (err) {
    return Response.redirect('/?shared=error', 303);
  }
}
