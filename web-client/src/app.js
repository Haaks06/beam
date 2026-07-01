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

async function setConfigValue(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// The service worker can only read config from IndexedDB, but this page
// (and repeat visits) reads from localStorage since it's synchronous and simple.
function saveConfig({ relayUrl, token }) {
  localStorage.setItem('relayUrl', relayUrl);
  localStorage.setItem('token', token);
  return Promise.all([setConfigValue('relayUrl', relayUrl), setConfigValue('token', token)]);
}

function loadConfig() {
  return {
    relayUrl: localStorage.getItem('relayUrl') || '',
    token: localStorage.getItem('token') || '',
  };
}

const statusEl = document.getElementById('status');
const pairedBanner = document.getElementById('paired-banner');
const relayUrlInput = document.getElementById('relay-url');
const pairingCodeInput = document.getElementById('pairing-code');

function setStatus(message, variant) {
  statusEl.textContent = message;
  statusEl.classList.remove('success', 'error');
  if (variant) statusEl.classList.add(variant);
}

function refreshPairedState() {
  const { relayUrl, token } = loadConfig();
  pairedBanner.style.display = token ? 'block' : 'none';
  if (relayUrl) relayUrlInput.value = relayUrl;
}

// Scanning the desktop app's pairing QR opens this page with ?relay=&code=
// attached, so prefill the form instead of making the user type the code.
function prefillFromQrScan() {
  const params = new URLSearchParams(window.location.search);
  const relay = params.get('relay');
  const code = params.get('code');
  if (relay) relayUrlInput.value = relay;
  if (code) pairingCodeInput.value = code.toUpperCase();
}

document.getElementById('pair-btn').addEventListener('click', async () => {
  const relayUrl = relayUrlInput.value.trim().replace(/\/+$/, '');
  const pairingCode = pairingCodeInput.value.trim().toUpperCase();
  if (!relayUrl || !pairingCode) {
    return setStatus('Enter both the relay URL and pairing code.', 'error');
  }
  try {
    setStatus('Pairing...');
    const res = await fetch(`${relayUrl}/pair/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode, label: navigator.userAgent.slice(0, 40) }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'pairing failed');
    const { token } = await res.json();
    await saveConfig({ relayUrl, token });
    refreshPairedState();
    setStatus('Paired! You can now share links and photos.', 'success');
  } catch (err) {
    setStatus(`Pairing failed: ${err.message}`, 'error');
  }
});

document.getElementById('send-link-btn').addEventListener('click', async () => {
  const { relayUrl, token } = loadConfig();
  const url = document.getElementById('link-url').value.trim();
  if (!token) return setStatus('Pair this device first.', 'error');
  if (!url) return setStatus('Enter a link to send.', 'error');
  try {
    setStatus('Sending link...');
    const res = await fetch(`${relayUrl}/items/link`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'send failed');
    setStatus('Link sent!', 'success');
    document.getElementById('link-url').value = '';
  } catch (err) {
    setStatus(`Failed to send link: ${err.message}`, 'error');
  }
});

document.getElementById('send-photo-btn').addEventListener('click', async () => {
  const { relayUrl, token } = loadConfig();
  const fileInput = document.getElementById('photo-file');
  const file = fileInput.files[0];
  if (!token) return setStatus('Pair this device first.', 'error');
  if (!file) return setStatus('Choose a photo to send.', 'error');
  try {
    setStatus('Sending photo...');
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${relayUrl}/items/photo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    if (!res.ok) throw new Error((await res.json()).error || 'send failed');
    setStatus('Photo sent!', 'success');
    fileInput.value = '';
  } catch (err) {
    setStatus(`Failed to send photo: ${err.message}`, 'error');
  }
});

const shareStatus = new URLSearchParams(window.location.search).get('shared');
if (shareStatus === 'ok') setStatus('Shared to your PC!', 'success');
if (shareStatus === 'error') setStatus('Share failed — check pairing.', 'error');

refreshPairedState();
prefillFromQrScan();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { type: 'module' }).catch((err) => {
    console.error('service worker registration failed', err);
  });
}
