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
const friendsSection = document.getElementById('friends-section');
const friendCodeInput = document.getElementById('friend-code-input');
const friendInviteOverlay = document.getElementById('friend-invite-overlay');
const friendInviteCodeEl = document.getElementById('friend-invite-code');
const friendInviteQrEl = document.getElementById('friend-invite-qr');
const pendingRequestsWrap = document.getElementById('pending-requests');
const pendingList = document.getElementById('pending-list');
const friendsEmpty = document.getElementById('friends-empty');
const friendsList = document.getElementById('friends-list');
const sendToSelect = document.getElementById('send-to-select');

let eventSource = null;
let invitePollTimer = null;
let friendInvitePollTimer = null;

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
  friendsSection.style.display = paired ? 'block' : 'none';
  shareSection.style.display = paired ? 'block' : 'none';
  receivedSection.style.display = paired ? 'block' : 'none';
  repairLink.style.display = paired ? 'block' : 'none';
  if (relayUrl) relayUrlInput.value = relayUrl;
  if (paired) {
    connectReceivedFeed();
    loadConnections();
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

  // A friend's "Invite a friend" QR uses connectRelay/connectCode (not
  // relay/code) so it can never be confused with a device-pairing QR —
  // scanning one shouldn't silently join someone else's device sync.
  const connectCode = params.get('connectCode');
  if (connectCode) friendCodeInput.value = connectCode.toUpperCase();
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

// --- Friends (separate from device pairing above — connects two
// DIFFERENT people's inboxes, gated on the other side explicitly
// accepting, rather than joining the same shared inbox) ---

async function loadConnections() {
  const { relayUrl, token } = loadConfig();
  if (!token) return;
  try {
    const res = await fetch(`${relayUrl}/connections`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const { connections } = await res.json();
    renderConnections(connections);
  } catch {
    // Best-effort — friends list just won't update this cycle.
  }
}

function renderConnections(connections) {
  const pending = connections.filter((c) => c.status === 'pending' && c.role === 'target');
  const accepted = connections.filter((c) => c.status === 'accepted');

  pendingRequestsWrap.style.display = pending.length ? 'block' : 'none';
  pendingList.innerHTML = '';
  for (const conn of pending) {
    const row = document.createElement('div');
    row.className = 'connection-row';
    const name = document.createElement('span');
    name.textContent = conn.otherLabel;
    const actions = document.createElement('span');
    actions.className = 'actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'accept';
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', () => respondToConnection(conn.id, 'accept'));
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'reject';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => respondToConnection(conn.id, 'reject'));
    actions.append(acceptBtn, rejectBtn);
    row.append(name, actions);
    pendingList.appendChild(row);
  }

  friendsEmpty.style.display = accepted.length ? 'none' : 'block';
  friendsList.innerHTML = '';
  // Rebuild the send-to options: keep "My other devices", add one per friend.
  sendToSelect.innerHTML = '<option value="">My other devices</option>';
  for (const conn of accepted) {
    const row = document.createElement('div');
    row.className = 'connection-row';
    const name = document.createElement('span');
    name.textContent = conn.otherLabel;
    row.appendChild(name);
    friendsList.appendChild(row);

    const option = document.createElement('option');
    option.value = conn.id;
    option.textContent = conn.otherLabel;
    sendToSelect.appendChild(option);
  }
}

async function respondToConnection(connectionId, action) {
  const { relayUrl, token } = loadConfig();
  try {
    const res = await fetch(`${relayUrl}/connections/${connectionId}/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error((await res.json()).error || `${action} failed`);
    await loadConnections();
    setStatus(action === 'accept' ? 'Friend added!' : 'Request rejected.', action === 'accept' ? 'success' : null);
  } catch (err) {
    setStatus(`Couldn't ${action}: ${err.message}`, 'error');
  }
}

document.getElementById('invite-friend-btn').addEventListener('click', async () => {
  const { relayUrl, token } = loadConfig();
  if (!token) return setStatus('Start Beaming first.', 'error');
  try {
    const res = await fetch(`${relayUrl}/connect/init`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: deviceLabel() }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'failed to create invite');
    const data = await res.json();
    friendInviteCodeEl.textContent = data.connectCode;
    friendInviteQrEl.src = data.qrDataUrl;
    friendInviteOverlay.style.display = 'block';
    pollFriendInvite();
  } catch (err) {
    setStatus(`Couldn't invite a friend: ${err.message}`, 'error');
  }
});

function pollFriendInvite() {
  clearInterval(friendInvitePollTimer);
  // No separate "was it claimed yet" status endpoint for connect codes
  // (unlike device pairing) — claiming only creates a PENDING connection,
  // so there's nothing actionable to show here until the friends list
  // itself changes; just keep it refreshed while the overlay is open.
  friendInvitePollTimer = setInterval(loadConnections, 3000);
}

document.getElementById('friend-invite-cancel-btn').addEventListener('click', () => {
  clearInterval(friendInvitePollTimer);
  friendInviteOverlay.style.display = 'none';
});

document.getElementById('add-friend-btn').addEventListener('click', async () => {
  const { relayUrl, token } = loadConfig();
  const code = friendCodeInput.value.trim().toUpperCase();
  if (!token) return setStatus('Start Beaming first.', 'error');
  if (!code) return setStatus('Enter a code.', 'error');
  try {
    setStatus('Sending request...');
    const res = await fetch(`${relayUrl}/connect/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: deviceLabel() }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'failed to add friend');
    friendCodeInput.value = '';
    await loadConnections();
    setStatus('Request sent — waiting for them to accept.', 'success');
  } catch (err) {
    setStatus(`Couldn't add friend: ${err.message}`, 'error');
  }
});

document.getElementById('send-link-btn').addEventListener('click', async () => {
  const { relayUrl, token } = loadConfig();
  const url = document.getElementById('link-url').value.trim();
  if (!token) return setStatus('Pair this device first.', 'error');
  if (!url) return setStatus('Enter something to send.', 'error');
  const to = sendToSelect.value || undefined;
  try {
    setStatus('Sending...');
    const res = await fetch(`${relayUrl}/items/link`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, to }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'send failed');
    setStatus('Sent!', 'success');
    document.getElementById('link-url').value = '';
  } catch (err) {
    setStatus(`Failed to send: ${err.message}`, 'error');
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
    if (sendToSelect.value) fd.append('to', sendToSelect.value);
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

// The backend accepts arbitrary text now (see relay-server/routes/items.js),
// so content is only safe to render as a clickable href when it actually
// parses as http(s) — anything else (including something like
// "javascript:alert(1)") must render as inert text, never as a link target.
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function renderItem(item, { prepend } = { prepend: true }) {
  receivedEmpty.style.display = 'none';
  const { relayUrl, token } = loadConfig();
  const row = document.createElement('div');
  row.className = 'item-row';

  const time = new Date(item.createdAt).toLocaleString();
  const from = item.sourceLabel ? `from ${item.sourceLabel}` : '';

  if (item.type === 'link' && isHttpUrl(item.content)) {
    const a = document.createElement('a');
    a.href = item.content;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = item.content;
    row.appendChild(a);
  } else if (item.type === 'link') {
    const span = document.createElement('span');
    span.textContent = item.content;
    row.appendChild(span);
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

  if (item.isOwnDevice === false) {
    const badge = document.createElement('span');
    badge.className = 'friend-badge';
    badge.textContent = 'from a friend';
    row.appendChild(badge);
  }

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
  // Fires on the initial connect AND every automatic reconnect after a
  // drop — SSE has no delivery guarantee across a gap, so without re-running
  // the backlog fetch here, anything sent while disconnected would just be
  // silently missing with no indication anything went wrong.
  eventSource.onopen = () => loadBacklog();
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

// So it's always obvious which deploy is actually live, instead of guessing
// whether a change made it to production yet.
(async () => {
  try {
    const { relayUrl } = loadConfig();
    const base = (relayUrl || window.location.origin).replace(/\/+$/, '');
    const res = await fetch(`${base}/health`);
    const { version } = await res.json();
    if (version) document.getElementById('version-footer').textContent = `Beam v${version}`;
  } catch {
    // Non-essential — leave the footer blank if the relay isn't reachable yet.
  }
})();
