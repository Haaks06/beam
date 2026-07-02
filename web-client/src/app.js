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
  // A new token means a (possibly different) inbox — start the received
  // feed over from the beginning rather than risk skipping its backlog.
  localStorage.setItem('lastSeenId', '0');
  return Promise.all([setConfigValue('relayUrl', relayUrl), setConfigValue('token', token)]);
}

function loadConfig() {
  return {
    relayUrl: localStorage.getItem('relayUrl') || '',
    token: localStorage.getItem('token') || '',
  };
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android device';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Mac/.test(ua)) return 'Mac';
  return ua.slice(0, 40);
}

const statusEl = document.getElementById('status');
const pairedBanner = document.getElementById('paired-banner');
const startSection = document.getElementById('start-section');
const pairedActions = document.getElementById('paired-actions');
const shareSection = document.getElementById('share-section');
const receivedSection = document.getElementById('received-section');
const receivedList = document.getElementById('received-list');
const receivedEmpty = document.getElementById('received-empty');
const repairLink = document.getElementById('repair-link');
const relayUrlInput = document.getElementById('relay-url');
const pairingCodeInput = document.getElementById('pairing-code');
const inviteSection = document.getElementById('invite-section');
const inviteCodeEl = document.getElementById('invite-code');
const inviteQrEl = document.getElementById('invite-qr');

let eventSource = null;
let invitePollTimer = null;

function setStatus(message, variant) {
  statusEl.textContent = message;
  statusEl.classList.remove('success', 'error');
  if (variant) statusEl.classList.add(variant);
}

// Once paired, the "get started" form has done its job — sweep it away so
// the page is just "send / receive," not a form you have to look past.
function refreshPairedState() {
  const { relayUrl, token } = loadConfig();
  const paired = Boolean(token);
  pairedBanner.style.display = paired ? 'block' : 'none';
  startSection.classList.toggle('collapsed', paired);
  pairedActions.style.display = paired ? 'block' : 'none';
  shareSection.style.display = paired ? 'block' : 'none';
  receivedSection.style.display = paired ? 'block' : 'none';
  repairLink.style.display = paired ? 'block' : 'none';
  if (relayUrl) relayUrlInput.value = relayUrl;
  if (paired) {
    connectReceivedFeed();
  } else {
    disconnectReceivedFeed();
  }
}

repairLink.addEventListener('click', () => {
  disconnectReceivedFeed();
  startSection.classList.remove('collapsed');
  pairedBanner.style.display = 'none';
  pairedActions.style.display = 'none';
  repairLink.style.display = 'none';
  inviteSection.style.display = 'none';
});

// Scanning another device's pairing QR opens this page with ?relay=&code=
// attached, so prefill the form instead of making the user type the code.
function prefillFromQrScan() {
  const params = new URLSearchParams(window.location.search);
  const relay = params.get('relay');
  const code = params.get('code');
  if (relay) relayUrlInput.value = relay;
  if (code) pairingCodeInput.value = code.toUpperCase();
}

// When this page is served BY the relay itself (the normal production
// setup — see docs/HOSTING.md), the relay IS the current origin, so there's
// nothing to type. Leave it blank for the Vite dev server, where relay and
// web client run on different ports.
function prefillRelayUrl() {
  if (relayUrlInput.value) return;
  const isDevServer = window.location.port === '5173';
  if (!isDevServer) relayUrlInput.value = window.location.origin;
}

document.getElementById('start-btn').addEventListener('click', async () => {
  const relayUrl = (relayUrlInput.value.trim() || window.location.origin).replace(/\/+$/, '');
  try {
    setStatus('Starting...');
    const res = await fetch(`${relayUrl}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: deviceLabel() }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'failed to start');
    const { token } = await res.json();
    await saveConfig({ relayUrl, token });
    refreshPairedState();
    setStatus('', null);
    // Immediately offer to invite a second device — that's the whole point
    // of starting fresh on a device with nobody else paired to it yet.
    await showInvite();
  } catch (err) {
    setStatus(`Couldn't start: ${err.message}`, 'error');
  }
});

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
      body: JSON.stringify({ pairingCode, label: deviceLabel() }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'pairing failed');
    const { token } = await res.json();
    await saveConfig({ relayUrl, token });
    refreshPairedState();
    setStatus('Paired! You can now send and receive.', 'success');
  } catch (err) {
    setStatus(`Pairing failed: ${err.message}`, 'error');
  }
});

async function showInvite() {
  const { relayUrl, token } = loadConfig();
  if (!token) return;
  try {
    const res = await fetch(`${relayUrl}/pair/init`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error((await res.json()).error || 'failed to create invite');
    const data = await res.json();
    inviteCodeEl.textContent = data.pairingCode;
    inviteQrEl.src = data.qrDataUrl;
    inviteSection.style.display = 'block';
    pollInvite(relayUrl, data.pairingCode);
  } catch (err) {
    setStatus(`Couldn't create invite: ${err.message}`, 'error');
  }
}

function pollInvite(relayUrl, code) {
  clearInterval(invitePollTimer);
  invitePollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${relayUrl}/pair/status/${code}`);
      const data = await res.json();
      if (data.status === 'claimed') {
        clearInterval(invitePollTimer);
        inviteSection.style.display = 'none';
        setStatus('Device paired!', 'success');
      }
    } catch {
      // Transient network hiccup — keep polling silently.
    }
  }, 2000);
}

document.getElementById('invite-btn').addEventListener('click', showInvite);
document.getElementById('invite-cancel-btn').addEventListener('click', () => {
  clearInterval(invitePollTimer);
  inviteSection.style.display = 'none';
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

function renderItem(item, { prepend } = { prepend: true }) {
  receivedEmpty.style.display = 'none';
  const { relayUrl, token } = loadConfig();
  const row = document.createElement('div');
  row.className = 'item-row';

  const time = new Date(item.createdAt).toLocaleString();
  const from = item.sourceLabel ? `from ${item.sourceLabel}` : '';

  if (item.type === 'link') {
    const a = document.createElement('a');
    a.href = item.content;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = item.content;
    row.appendChild(a);
  } else if (item.type === 'photo') {
    const fileUrl = `${relayUrl}${item.fileUrl}?token=${encodeURIComponent(token)}`;
    const img = document.createElement('img');
    img.src = fileUrl;
    img.alt = 'Received photo';
    row.appendChild(img);
    const dl = document.createElement('a');
    dl.href = fileUrl;
    dl.download = '';
    dl.className = 'download';
    dl.textContent = 'Download';
    row.appendChild(dl);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = [time, from].filter(Boolean).join(' · ');
  row.appendChild(meta);

  if (prepend) {
    receivedList.prepend(row);
  } else {
    receivedList.appendChild(row);
  }
}

async function loadBacklog() {
  const { relayUrl, token } = loadConfig();
  if (!token) return;
  const since = Number(localStorage.getItem('lastSeenId') || '0');
  try {
    const res = await fetch(`${relayUrl}/items?since=${since}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const { items } = await res.json();
    for (const item of items) {
      renderItem(item, { prepend: false });
      localStorage.setItem('lastSeenId', String(item.id));
    }
  } catch {
    // Best-effort — the live SSE stream will still pick up anything new.
  }
}

function connectReceivedFeed() {
  disconnectReceivedFeed();
  loadBacklog();
  const { relayUrl, token } = loadConfig();
  if (!relayUrl || !token) return;
  eventSource = new EventSource(`${relayUrl}/events?token=${encodeURIComponent(token)}`);
  eventSource.onmessage = (event) => {
    const item = JSON.parse(event.data);
    renderItem(item, { prepend: true });
    localStorage.setItem('lastSeenId', String(item.id));
  };
}

function disconnectReceivedFeed() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  receivedList.innerHTML = '';
  receivedEmpty.style.display = 'block';
}

const shareStatus = new URLSearchParams(window.location.search).get('shared');
if (shareStatus === 'ok') setStatus('Shared!', 'success');
if (shareStatus === 'error') setStatus('Share failed — check pairing.', 'error');

prefillRelayUrl();
prefillFromQrScan();
refreshPairedState();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { type: 'module' }).catch((err) => {
    console.error('service worker registration failed', err);
  });
}

// PWA install prompt — browsers hide the built-in install affordance often
// enough that a visible button meaningfully improves discoverability.
let deferredInstallPrompt = null;
const installBtn = document.getElementById('install-btn');
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installBtn.style.display = 'inline-block';
});
installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.style.display = 'none';
});
window.addEventListener('appinstalled', () => {
  installBtn.style.display = 'none';
});
