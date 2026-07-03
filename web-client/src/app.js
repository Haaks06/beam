import './styles.css';
import jsQR from 'jsqr';

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

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Not every non-2xx response is guaranteed to be JSON — a rate limit, a
// proxy-level 502/504 HTML page, or a timeout can all return plain text or
// HTML instead. Blindly calling res.json() on those throws its own opaque
// parse error ("Unexpected token 'T' ... is not valid JSON") that then
// replaces the actually-useful message. This always resolves to *something*
// readable instead.
async function parseErrorMessage(res, fallback) {
  try {
    const data = await res.json();
    return data.error || fallback;
  } catch {
    if (res.status === 429) return 'Too many requests — wait a moment and try again.';
    return fallback;
  }
}

const statusEl = document.getElementById('status');
const startSection = document.getElementById('start-section');
const connectBtn = document.getElementById('connect-btn');
const relayUrlInput = document.getElementById('relay-url');
const pairingCodeInput = document.getElementById('pairing-code');
const showAdvancedBtn = document.getElementById('show-advanced-btn');
const advancedSection = document.getElementById('advanced-section');
const inviteSection = document.getElementById('invite-section');
const inviteCodeEl = document.getElementById('invite-code');
const inviteQrEl = document.getElementById('invite-qr');
const inviteFrame = document.getElementById('invite-frame');
const pairSuccessOverlay = document.getElementById('pair-success-overlay');
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
// There's no upfront "I want to send" / "I want to receive" choice anymore
// — connecting always shows your own QR AND a code-entry field at once,
// whichever side of the pairing actually completes it first. This only
// picks a sensible default tab once paired: generating your own code
// defaults to Send, claiming someone else's (typed, scanned, or via a
// scanned link) defaults to Receive.
let lastIntent = 'send';

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
  stopQrScan();
  if (connPill) connPill.style.display = 'none';
  advancedSection.style.display = 'none';
  showOnly('start');
}

// A brief, unmissable confirmation the instant a pairing completes — shown
// for every path (someone scanned your QR, you typed their code, or you
// scanned theirs with the camera), not just the QR-generation side, since
// all three used to only get a small status line easy to miss.
function showPairedAnimation() {
  return new Promise((resolve) => {
    pairSuccessOverlay.classList.add('visible');
    setTimeout(() => {
      pairSuccessOverlay.classList.remove('visible');
      resolve();
    }, 900);
  });
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
  activateTab(lastIntent);
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
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'failed to create invite'));
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
        lastIntent = 'send';
        await showPairedAnimation();
        enterActiveState();
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

// One button: generates this device's own inbox + pairing code immediately,
// which enterInviteState() shows as a QR alongside a code-entry field and
// the camera scanner — so it never matters which device actually "started"
// it, whichever side completes the pairing first wins.
connectBtn.addEventListener('click', async () => {
  const relayUrl = (relayUrlInput.value.trim() || window.location.origin).replace(/\/+$/, '');
  connectBtn.classList.add('sending');
  connectBtn.disabled = true;
  try {
    setStatus('Connecting...');
    const res = await fetch(`${relayUrl}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: deviceLabel() }),
    });
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'failed to start'));
    const { token } = await res.json();
    await saveConfig({ relayUrl, token, expiresAt: null });
    setStatus('', null);
    await enterInviteState();
  } catch (err) {
    setStatus(`Couldn't connect: ${err.message}`, 'error');
  } finally {
    connectBtn.classList.remove('sending');
    connectBtn.disabled = false;
  }
});

if (showAdvancedBtn && advancedSection) {
  showAdvancedBtn.addEventListener('click', () => {
    const willShow = advancedSection.style.display === 'none';
    advancedSection.style.display = willShow ? 'block' : 'none';
  });
}

async function claimPairingCode(relayUrl, pairingCode) {
  lastIntent = 'receive';
  const res = await fetch(`${relayUrl}/pair/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingCode, label: deviceLabel() }),
  });
  if (!res.ok) throw new Error(await parseErrorMessage(res, 'pairing failed'));
  const { token, expiresAt } = await res.json();
  await saveConfig({ relayUrl, token, expiresAt });
  clearInterval(invitePollTimer);
  await showPairedAnimation();
  enterActiveState();
}

// --- In-browser QR scanning: previously the only way to "scan" was to
// leave the site and use the OS camera app, which doesn't exist on every
// device (a PC's webcam has no such affordance) and adds a context switch
// on ones that do. This decodes the camera feed directly on the page. ---

const scanQrBtn = document.getElementById('scan-qr-btn');
const scanSection = document.getElementById('scan-section');
const scanVideo = document.getElementById('scan-video');
const scanStatus = document.getElementById('scan-status');
const scanCancelBtn = document.getElementById('scan-cancel-btn');
const scanCanvas = document.createElement('canvas');
const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

let scanStream = null;
let scanRafId = null;

// window.beamNative only exists inside the packaged Electron app (see
// desktop-app/preload.js) — camera permissions there aren't wired up the
// way a real browser handles them, so getUserMedia just fails/hangs
// instead of prompting properly. Scanning still works fine in an actual
// mobile/desktop browser, where this stays available.
const isDesktopApp = !!window.beamNative;
const canScanQr = !isDesktopApp && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
if (!canScanQr && scanQrBtn) scanQrBtn.style.display = 'none';

function stopQrScan() {
  if (scanRafId) cancelAnimationFrame(scanRafId);
  scanRafId = null;
  if (scanStream) {
    for (const track of scanStream.getTracks()) track.stop();
    scanStream = null;
  }
  scanSection.style.display = 'none';
}

function scanVideoFrame() {
  if (scanVideo.readyState === scanVideo.HAVE_ENOUGH_DATA) {
    scanCanvas.width = scanVideo.videoWidth;
    scanCanvas.height = scanVideo.videoHeight;
    scanCtx.drawImage(scanVideo, 0, 0, scanCanvas.width, scanCanvas.height);
    const imageData = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
    const decoded = jsQR(imageData.data, imageData.width, imageData.height);
    if (decoded) {
      handleScannedQr(decoded.data);
      return;
    }
  }
  scanRafId = requestAnimationFrame(scanVideoFrame);
}

function handleScannedQr(text) {
  stopQrScan();
  inviteSection.style.display = 'block';

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return setStatus("That QR code doesn't look like a Beam pairing code.", 'error');
  }
  const relay = parsed.searchParams.get('relay');
  const code = parsed.searchParams.get('code');
  if (!relay || !code) {
    return setStatus("That QR code doesn't look like a Beam pairing code.", 'error');
  }

  relayUrlInput.value = relay;
  pairingCodeInput.value = code.toUpperCase();
  setStatus('Pairing...');
  claimPairingCode(relay.replace(/\/+$/, ''), code.toUpperCase()).catch((err) =>
    setStatus(`Pairing failed: ${err.message}`, 'error')
  );
}

if (scanQrBtn) {
  scanQrBtn.addEventListener('click', async () => {
    inviteSection.style.display = 'none';
    scanSection.style.display = 'block';
    scanStatus.textContent = 'Requesting camera access…';
    try {
      // "environment" (the back/main camera) beats the front-facing default
      // on a phone — that's the one that can actually see another screen.
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      scanVideo.srcObject = scanStream;
      await scanVideo.play();
      scanStatus.textContent = 'Point your camera at the QR code';
      scanRafId = requestAnimationFrame(scanVideoFrame);
    } catch (err) {
      scanStatus.textContent = `Couldn't access the camera: ${err.message}`;
    }
  });
}
if (scanCancelBtn) {
  scanCancelBtn.addEventListener('click', () => {
    stopQrScan();
    inviteSection.style.display = 'block';
  });
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

  // The scanned link's ?relay=&code= stays in the URL after a successful
  // pairing (nothing ever cleared it) — refreshing the phone re-ran this
  // exact function every time, re-claiming an already-used code, which
  // fails and wipes out the perfectly valid session that was already
  // active. This is "refreshing loses the connection." Strip the params
  // unconditionally, before anything else, so no later reload can retrigger
  // this regardless of which branch below runs.
  window.history.replaceState(null, '', window.location.pathname);

  // Also don't attempt to re-claim if this device is already mid-session —
  // covers the case where the params somehow survive (e.g. a bookmarked
  // link) while a still-valid token already exists in localStorage.
  const existing = loadConfig();
  if (existing.token && existing.expiresAt && existing.expiresAt > Date.now()) {
    return false;
  }

  relayUrlInput.value = relay;
  pairingCodeInput.value = code.toUpperCase();
  startSection.style.display = 'none';
  inviteSection.style.display = 'block';
  try {
    setStatus('Pairing...');
    await claimPairingCode(relay.replace(/\/+$/, ''), code.toUpperCase());
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
    // Only a genuinely live arrival copies to clipboard — same reasoning as
    // land-in's animation only firing for live items, not backlog: copying
    // every item in a reconnect catch-up batch would silently clobber
    // whatever the user had just copied themselves. Restores what earlier
    // versions of the desktop app used to do (see saveHandlers.js's git
    // history) — beaming a link over is meant to be used right away.
    if (item.type === 'link' && isHttpUrl(item.content)) {
      navigator.clipboard?.writeText(item.content).then(
        () => setStatus(`Copied to clipboard: "${truncate(item.content, 60)}"`, 'success'),
        () => {
          // Some browsers refuse a clipboard write outside a direct user
          // gesture (notably Safari) — not fatal, the item is still right
          // there in the Received list to copy by hand.
        }
      );
    }
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
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'send failed'));
    // Names the actual content sent instead of a generic "Beamed!" — the
    // sender no longer sees this item echo back into their own Received
    // tab (the relay excludes them from their own broadcast now), so this
    // status line is the one place confirming exactly what went out.
    setStatus(`Sent: "${truncate(url, 60)}"`, 'success');
    document.getElementById('link-url').value = '';
  } catch (err) {
    setStatus(`Failed to send: ${err.message}`, 'error');
  } finally {
    btn.classList.remove('sending');
    btn.disabled = false;
  }
});

// --- Photo drop zone: click to pick, drag-and-drop, or paste from the
// clipboard — sending a photo is the primary action on this tab (see
// index.html), so it gets the same affordances a real "airdrop"-style tool
// would, not a bare <input type=file>. ---

const photoDropZone = document.getElementById('photo-drop-zone');
const photoFileInput = document.getElementById('photo-file');
const dropZoneEmpty = document.getElementById('drop-zone-empty');
const dropZonePreview = document.getElementById('drop-zone-preview');
const photoPreviewImg = document.getElementById('photo-preview-img');
const photoClearBtn = document.getElementById('photo-clear-btn');
const sendPhotoBtn = document.getElementById('send-photo-btn');

let selectedPhotoFile = null;
let selectedPhotoPreviewUrl = null;

function setSelectedPhoto(file) {
  if (selectedPhotoPreviewUrl) {
    URL.revokeObjectURL(selectedPhotoPreviewUrl);
    selectedPhotoPreviewUrl = null;
  }
  selectedPhotoFile = file || null;
  if (file) {
    selectedPhotoPreviewUrl = URL.createObjectURL(file);
    photoPreviewImg.src = selectedPhotoPreviewUrl;
    dropZoneEmpty.style.display = 'none';
    dropZonePreview.style.display = 'block';
  } else {
    dropZoneEmpty.style.display = 'flex';
    dropZonePreview.style.display = 'none';
  }
  sendPhotoBtn.disabled = !file;
}

photoDropZone.addEventListener('click', () => {
  if (!selectedPhotoFile) photoFileInput.click();
});
photoDropZone.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && !selectedPhotoFile) {
    event.preventDefault();
    photoFileInput.click();
  }
});
photoFileInput.addEventListener('change', () => setSelectedPhoto(photoFileInput.files[0]));
photoClearBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  setSelectedPhoto(null);
  photoFileInput.value = '';
});

for (const evt of ['dragenter', 'dragover']) {
  photoDropZone.addEventListener(evt, (event) => {
    event.preventDefault();
    photoDropZone.classList.add('drag-active');
  });
}
for (const evt of ['dragleave', 'drop']) {
  photoDropZone.addEventListener(evt, (event) => {
    event.preventDefault();
    photoDropZone.classList.remove('drag-active');
  });
}
photoDropZone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file && file.type.startsWith('image/')) setSelectedPhoto(file);
});

// Paste-to-send only fires while the Send tab is actually the one showing —
// otherwise pasting an image while reading the Receive tab would silently
// load it into a hidden form the user never asked for.
document.addEventListener('paste', (event) => {
  if (document.getElementById('tab-send').style.display === 'none') return;
  const items = event.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      setSelectedPhoto(item.getAsFile());
      break;
    }
  }
});

sendPhotoBtn.addEventListener('click', async () => {
  const { relayUrl, token } = loadConfig();
  if (!token) return setStatus('Pair this device first.', 'error');
  if (!selectedPhotoFile) return setStatus('Choose a photo to send.', 'error');
  sendPhotoBtn.classList.add('sending');
  sendPhotoBtn.disabled = true;
  try {
    setStatus('Sending photo...');
    const fd = new FormData();
    fd.append('file', selectedPhotoFile);
    const res = await fetch(`${relayUrl}/items/photo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    if (res.status === 401) return enterEndedState();
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'send failed'));
    setStatus(`Sent: ${truncate(selectedPhotoFile.name || 'photo', 60)}`, 'success');
    setSelectedPhoto(null);
    photoFileInput.value = '';
  } catch (err) {
    setStatus(`Failed to send photo: ${err.message}`, 'error');
  } finally {
    sendPhotoBtn.classList.remove('sending');
    sendPhotoBtn.disabled = !selectedPhotoFile;
  }
});

const showTextBtn = document.getElementById('show-text-btn');
const textSection = document.getElementById('text-section');
if (showTextBtn && textSection) {
  showTextBtn.addEventListener('click', () => {
    const willShow = textSection.style.display === 'none';
    textSection.style.display = willShow ? 'block' : 'none';
    if (willShow) document.getElementById('link-url')?.focus();
  });
}

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
