import './styles.css';

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
function saveConfig({ relayUrl, token, expiresAt }) {
  localStorage.setItem('relayUrl', relayUrl);
  localStorage.setItem('token', token);
  localStorage.setItem('expiresAt', expiresAt ? String(expiresAt) : '');
  // A new token means a new pairing — start the received feed over from the
  // beginning rather than risk skipping its backlog.
  localStorage.setItem('lastSeenId', '0');
  return Promise.all([setConfigValue('relayUrl', relayUrl), setConfigValue('token', token)]);
}

function clearConfig() {
  localStorage.removeItem('relayUrl');
  localStorage.removeItem('token');
  localStorage.removeItem('expiresAt');
  localStorage.removeItem('lastSeenId');
}

function loadConfig() {
  const expiresAtRaw = localStorage.getItem('expiresAt');
  return {
    relayUrl: localStorage.getItem('relayUrl') || '',
    token: localStorage.getItem('token') || '',
    expiresAt: expiresAtRaw ? Number(expiresAtRaw) : null,
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
const startSection = document.getElementById('start-section');
const relayUrlInput = document.getElementById('relay-url');
const pairingCodeInput = document.getElementById('pairing-code');
const codeSection = document.getElementById('code-section');
const showCodeBtn = document.getElementById('show-code-btn');
const inviteSection = document.getElementById('invite-section');
const inviteCodeEl = document.getElementById('invite-code');
const inviteQrEl = document.getElementById('invite-qr');
const inviteFrame = document.getElementById('invite-frame');
const appShell = document.getElementById('app-shell');
const endedSection = document.getElementById('ended-section');
const sessionTimerEl = document.getElementById('session-timer');
const repairLink = document.getElementById('repair-link');
const receivedList = document.getElementById('received-list');
const receivedEmpty = document.getElementById('received-empty');
const connPill = document.getElementById('conn-pill');
const connPillText = document.getElementById('conn-pill-text');

let eventSource = null;
let invitePollTimer = null;
let countdownTimer = null;

function setStatus(message, variant) {
  statusEl.textContent = message;
  statusEl.classList.remove('success', 'error');
  if (variant) statusEl.classList.add(variant);
}

// Send / Receive — the whole point of a paired session, nothing else
// competing for attention.
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = { send: document.getElementById('tab-send'), receive: document.getElementById('tab-receive') };
const tabIndicator = document.getElementById('tab-indicator');
function positionTabIndicator() {
  const active = document.querySelector('.tab-btn.active');
  if (!active || !tabIndicator) return;
  tabIndicator.style.left = `${active.offsetLeft}px`;
  tabIndicator.style.width = `${active.offsetWidth}px`;
}
function activateTab(name) {
  for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.tab === name);
  for (const [key, panel] of Object.entries(tabPanels)) panel.style.display = key === name ? 'block' : 'none';
  positionTabIndicator();
}
for (const btn of tabButtons) {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
}
window.addEventListener('resize', positionTabIndicator);

function showOnly(section) {
  startSection.style.display = section === 'start' ? 'block' : 'none';
  inviteSection.style.display = section === 'invite' ? 'block' : 'none';
  appShell.style.display = section === 'active' ? 'block' : 'none';
  endedSection.style.display = section === 'ended' ? 'block' : 'none';
}

// --- Session lifecycle: start -> invite (waiting for the other device) ->
// active (paired, 2-minute countdown running) -> ended (relay forgot
// everything; back to start). ---

function enterStartState() {
  disconnectReceivedFeed();
  clearInterval(invitePollTimer);
  clearInterval(countdownTimer);
  if (connPill) connPill.style.display = 'none';
  showOnly('start');
}

function enterEndedState() {
  clearConfig();
  disconnectReceivedFeed();
  clearInterval(invitePollTimer);
  clearInterval(countdownTimer);
  showOnly('ended');
}

function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function enterActiveState() {
  showOnly('active');
  activateTab('send');
  requestAnimationFrame(positionTabIndicator);
  connectReceivedFeed();

  clearInterval(countdownTimer);
  const tick = () => {
    const { expiresAt } = loadConfig();
    const remaining = (expiresAt || 0) - Date.now();
    if (remaining <= 0) {
      enterEndedState();
      return;
    }
    sessionTimerEl.textContent = `Session ends in ${formatRemaining(remaining)}`;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

async function enterInviteState() {
  const { relayUrl, token } = loadConfig();
  if (!token) return enterStartState();
  showOnly('invite');
  try {
    const res = await fetch(`${relayUrl}/pair/init`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error((await res.json()).error || 'failed to create invite');
    const data = await res.json();
    inviteCodeEl.textContent = data.pairingCode;
    inviteQrEl.classList.remove('loaded');
    inviteQrEl.onload = () => inviteQrEl.classList.add('loaded');
    inviteQrEl.src = data.qrDataUrl;
    inviteFrame?.classList.remove('locked');
    inviteFrame?.classList.add('active');
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
        inviteFrame?.classList.add('locked');
        const { token } = loadConfig();
        await saveConfig({ relayUrl, token, expiresAt: data.expiresAt });
        setStatus('Paired!', 'success');
        setTimeout(() => enterActiveState(), 500);
      }
    } catch {
      // Transient network hiccup — keep polling silently.
    }
  }, 2000);
}

// Reads whichever state was last persisted and shows the matching screen —
// called on cold load and after any state transition that doesn't already
// know exactly where to go next.
function refreshState() {
  const { token, expiresAt } = loadConfig();
  if (relayUrlInput.value === '') {
    const { relayUrl } = loadConfig();
    if (relayUrl) relayUrlInput.value = relayUrl;
  }
  if (!token) return enterStartState();
  if (expiresAt && expiresAt > Date.now()) return enterActiveState();
  if (expiresAt && expiresAt <= Date.now()) return enterEndedState();
  // Token exists but no expiresAt yet: this device is the one waiting to be
  // joined — re-mint a fresh code rather than trying to recover a stale one.
  return enterInviteState();
}

document.getElementById('start-btn').addEventListener('click', async () => {
  const relayUrl = (relayUrlInput.value.trim() || window.location.origin).replace(/\/+$/, '');
  const startBtn = document.getElementById('start-btn');
  startBtn.classList.add('sending');
  startBtn.disabled = true;
  try {
    setStatus('Starting...');
    const res = await fetch(`${relayUrl}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: deviceLabel() }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'failed to start');
    const { token } = await res.json();
    await saveConfig({ relayUrl, token, expiresAt: null });
    setStatus('', null);
    await enterInviteState();
  } catch (err) {
    setStatus(`Couldn't start: ${err.message}`, 'error');
  } finally {
    startBtn.classList.remove('sending');
    startBtn.disabled = false;
  }
});

if (showCodeBtn && codeSection) {
  showCodeBtn.addEventListener('click', () => {
    const willShow = codeSection.style.display === 'none';
    codeSection.style.display = willShow ? 'block' : 'none';
    if (willShow) pairingCodeInput?.focus();
  });
}

async function claimPairingCode(relayUrl, pairingCode) {
  const res = await fetch(`${relayUrl}/pair/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingCode, label: deviceLabel() }),
  });
  if (!res.ok) throw new Error((await res.json()).error || 'pairing failed');
  const { token, expiresAt } = await res.json();
  await saveConfig({ relayUrl, token, expiresAt });
  enterActiveState();
}

document.getElementById('pair-btn').addEventListener('click', async () => {
  const relayUrl = relayUrlInput.value.trim().replace(/\/+$/, '');
  const pairingCode = pairingCodeInput.value.trim().toUpperCase();
  if (!relayUrl || !pairingCode) {
    return setStatus('Enter both the relay URL and pairing code.', 'error');
  }
  try {
    setStatus('Pairing...');
    await claimPairingCode(relayUrl, pairingCode);
    setStatus('Paired! You can now send and receive.', 'success');
  } catch (err) {
    setStatus(`Pairing failed: ${err.message}`, 'error');
  }
});

document.getElementById('invite-cancel-btn').addEventListener('click', () => {
  clearInterval(invitePollTimer);
  enterStartState();
});

repairLink.addEventListener('click', () => enterStartState());
document.getElementById('restart-btn').addEventListener('click', () => enterStartState());

// Scanning another device's pairing QR opens this page with ?relay=&code=
// attached — pairs immediately rather than just prefilling the form, so
// scanning is the whole interaction on the joining device.
async function claimFromQrScan() {
  const params = new URLSearchParams(window.location.search);
  const relay = params.get('relay');
  const code = params.get('code');
  if (!relay || !code) return false;

  relayUrlInput.value = relay;
  pairingCodeInput.value = code.toUpperCase();
  codeSection.style.display = 'block';
  try {
    setStatus('Pairing...');
    await claimPairingCode(relay.replace(/\/+$/, ''), code.toUpperCase());
    setStatus('Paired! You can now send and receive.', 'success');
  } catch (err) {
    // Fall back to the manual form, prefilled, so the user can retry by hand.
    enterStartState();
    setStatus(`Pairing failed: ${err.message}`, 'error');
  }
  return true;
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
  // Only a genuinely live SSE arrival gets the "just landed" treatment —
  // backlog items (initial load, reconnect catch-up) appear instantly so
  // the animation stays meaningful instead of firing on every page visit.
  row.className = prepend ? 'item-row land-in' : 'item-row';

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
    if (res.status === 401) return enterEndedState();
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

function setConnPill(state) {
  if (!connPill) return;
  connPill.style.display = 'inline-flex';
  connPill.classList.remove('connected', 'connecting', 'disconnected');
  connPill.classList.add(state);
  connPillText.textContent = state === 'connected' ? 'live' : state === 'connecting' ? 'connecting…' : 'offline';
}

function connectReceivedFeed() {
  disconnectReceivedFeed();
  loadBacklog();
  const { relayUrl, token } = loadConfig();
  if (!relayUrl || !token) return;
  setConnPill('connecting');
  eventSource = new EventSource(`${relayUrl}/events?token=${encodeURIComponent(token)}`);
  // Fires on the initial connect AND every automatic reconnect after a
  // drop — SSE has no delivery guarantee across a gap, so without re-running
  // the backlog fetch here, anything sent while disconnected would just be
  // silently missing with no indication anything went wrong.
  eventSource.onopen = () => {
    setConnPill('connected');
    loadBacklog();
  };
  eventSource.onerror = () => setConnPill('disconnected');
  eventSource.onmessage = (event) => {
    const item = JSON.parse(event.data);
    renderItem(item, { prepend: true });
    localStorage.setItem('lastSeenId', String(item.id));
    const { relayUrl, token } = loadConfig();
    window.beamNative?.itemReceived(item, relayUrl, token);
  };
  // Pushed by the relay the instant it deletes an expired session (see
  // relay-server/lib/sessionCleanup.js) — reacting to this beats waiting for
  // the client's own countdown to reach zero, which could be seconds off if
  // this device's clock is skewed relative to the server's.
  eventSource.addEventListener('session-expired', () => enterEndedState());
}

function disconnectReceivedFeed() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  receivedList.innerHTML = '';
  receivedEmpty.style.display = 'block';
}

document.getElementById('send-link-btn').addEventListener('click', async () => {
  const { relayUrl, token } = loadConfig();
  const url = document.getElementById('link-url').value.trim();
  if (!token) return setStatus('Pair this device first.', 'error');
  if (!url) return setStatus('Enter something to send.', 'error');
  const btn = document.getElementById('send-link-btn');
  btn.classList.add('sending');
  btn.disabled = true;
  try {
    setStatus('Sending...');
    const res = await fetch(`${relayUrl}/items/link`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (res.status === 401) return enterEndedState();
    if (!res.ok) throw new Error((await res.json()).error || 'send failed');
    setStatus('Beamed!', 'success');
    document.getElementById('link-url').value = '';
  } catch (err) {
    setStatus(`Failed to send: ${err.message}`, 'error');
  } finally {
    btn.classList.remove('sending');
    btn.disabled = false;
  }
});

document.getElementById('send-photo-btn').addEventListener('click', async () => {
  const { relayUrl, token } = loadConfig();
  const fileInput = document.getElementById('photo-file');
  const file = fileInput.files[0];
  if (!token) return setStatus('Pair this device first.', 'error');
  if (!file) return setStatus('Choose a photo to send.', 'error');
  const btn = document.getElementById('send-photo-btn');
  btn.classList.add('sending');
  btn.disabled = true;
  try {
    setStatus('Sending photo...');
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${relayUrl}/items/photo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    if (res.status === 401) return enterEndedState();
    if (!res.ok) throw new Error((await res.json()).error || 'send failed');
    setStatus('Photo beamed!', 'success');
    fileInput.value = '';
  } catch (err) {
    setStatus(`Failed to send photo: ${err.message}`, 'error');
  } finally {
    btn.classList.remove('sending');
    btn.disabled = false;
  }
});

const shareStatus = new URLSearchParams(window.location.search).get('shared');
if (shareStatus === 'ok') setStatus('Shared!', 'success');
if (shareStatus === 'error') setStatus('Share failed — check pairing.', 'error');

prefillRelayUrl();
claimFromQrScan().then((scanned) => {
  if (!scanned) refreshState();
});

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
