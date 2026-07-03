import './styles.css';
import jsQR from 'jsqr';

const DB_NAME = 'beam';
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

let eventSource = null;
let invitePollTimer = null;
let countdownTimer = null;
// Bumped every time we (re-)enter the invite flow or leave it (Cancel,
// pairing completing, page reload's own refreshState() call, etc). A
// /pair/init response's continuation only applies its result if this still
// matches the value captured when THAT specific request started — see
// enterInviteState()'s "stale invite" guard for the race this closes.
let inviteGeneration = 0;
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
  window.beamNative?.resizeWindow(section);
}

// --- Session lifecycle: start -> invite (waiting for the other device) ->
// active (paired, 2-minute countdown running) -> ended (relay forgot
// everything; back to start). ---

function enterStartState() {
  // Invalidate any /pair/init still in flight from an invite we're now
  // leaving (Cancel, "Start over", etc.) — without this, that request can
  // still resolve later and silently repopulate the (currently hidden)
  // invite code/QR and restart the poll interval in the background, purely
  // because nothing ever told it to stand down.
  inviteGeneration++;
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
  sseRetryDelay = SSE_BASE_RETRY_MS; // fresh session, fresh backoff
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
  // Claim this invite attempt's own generation number *before* the request
  // goes out. enterInviteState() can end up in flight more than once close
  // together — e.g. Cancel then Connect again fast, or reloading the page
  // while already mid-invite (refreshState() calls this too, independently
  // of Connect's own button-disabled guard) — and fetches don't necessarily
  // resolve in the order they were sent. Without this, a slower/older
  // request's .then can land after a newer one already rendered a fresh
  // code + QR, and unconditionally overwrite it: the code text flips to the
  // stale one, the QR image loses its "loaded" class (instantly fading back
  // to invisible mid-transition, which is the actual "QR doesn't show up"
  // symptom) before reloading with the wrong/abandoned code, and the poll
  // interval gets redirected to that dead code — so pairing then silently
  // never completes. Comparing against the live counter after the await
  // lets any response whose invite has since been superseded discard itself
  // instead.
  const myGeneration = ++inviteGeneration;
  showOnly('invite');
  try {
    const res = await fetch(`${relayUrl}/pair/init`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (myGeneration !== inviteGeneration) return; // superseded — discard this stale response
    // A 401 here means the relay no longer recognizes this token — most
    // often because it minted an invite, never got paired, and the relay's
    // own abandoned-session sweep (see relay-server/lib/sessionCleanup.js,
    // 10-minute TTL) deleted the device row before this same page/window got
    // reopened. Without this, refreshState() keeps re-entering this exact
    // function with the same dead token on every load, showing a
    // permanently blank invite (no code, no QR) forever — the token is
    // dead and no amount of retrying fixes that, so clear it and let the
    // user start clean instead of getting stuck.
    if (res.status === 401) {
      clearConfig();
      enterStartState();
      setStatus('That connection expired — click Connect to start a new one.', 'error');
      return;
    }
    if (!res.ok) throw new Error(await parseErrorMessage(res, 'failed to create invite'));
    const data = await res.json();
    if (myGeneration !== inviteGeneration) return; // superseded — discard this stale response
    inviteCodeEl.textContent = data.pairingCode;
    inviteQrEl.classList.remove('loaded');
    inviteQrEl.onload = () => inviteQrEl.classList.add('loaded');
    inviteQrEl.src = data.qrDataUrl;
    inviteFrame?.classList.remove('locked');
    inviteFrame?.classList.add('active');
    pollInvite(relayUrl, data.pairingCode);
  } catch (err) {
    if (myGeneration !== inviteGeneration) return; // superseded — don't show a stale error either
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
// ?src=extension is set by chrome-extension/background.js when it opens
// this page in its popup window — a laptop webcam scanning a phone's QR
// isn't a real flow there, so the button hides in that context too, same
// reasoning as the desktop app above. Phones/other browsers keep it.
const isExtensionPopup = new URLSearchParams(window.location.search).get('src') === 'extension';
const canScanQr = !isDesktopApp && !isExtensionPopup && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
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

// Pairing links come in two shapes: the path-based one relay-server/routes/
// pair.js generates now (e.g. https://beamsend.com/ABC123 — relay is just
// the link's own origin, since one server always serves both the API and
// this page) and the older ?relay=&code= query-string form, kept so any
// link/QR already in circulation from before this change still works. Both
// the camera scanner and cold-load URL handling need the same parsing, so
// it lives here once.
const PAIRING_CODE_RE = /^[A-Za-z0-9]{6}$/;
function parsePairingLink(url) {
  const relayParam = url.searchParams.get('relay');
  const codeParam = url.searchParams.get('code');
  if (relayParam && codeParam) return { relay: relayParam, code: codeParam };

  const pathCode = url.pathname.replace(/^\/+/, '');
  if (PAIRING_CODE_RE.test(pathCode)) return { relay: url.origin, code: pathCode };

  return null;
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
  const link = parsePairingLink(parsed);
  if (!link) {
    return setStatus("That QR code doesn't look like a Beam pairing code.", 'error');
  }

  relayUrlInput.value = link.relay;
  pairingCodeInput.value = link.code.toUpperCase();
  setStatus('Pairing...');
  claimPairingCode(link.relay.replace(/\/+$/, ''), link.code.toUpperCase()).catch((err) =>
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

// Opening another device's pairing link (path-based /ABC123, or the older
// ?relay=&code=) pairs immediately rather than just prefilling the form, so
// opening/scanning it is the whole interaction on the joining device.
async function claimFromQrScan() {
  const link = parsePairingLink(new URL(window.location.href));
  if (!link) return false;
  const { relay, code } = link;

  // Either link shape stays in the URL after a successful pairing (nothing
  // ever cleared it) — refreshing the phone re-ran this exact function every
  // time, re-claiming an already-used code, which fails and wipes out the
  // perfectly valid session that was already active. This is "refreshing
  // loses the connection." Strip it unconditionally, before anything else,
  // so no later reload can retrigger this regardless of which branch below
  // runs. Always back to "/", not just stripping the query string — the
  // path-based form carries the code IN the path itself.
  window.history.replaceState(null, '', '/');

  // Also don't attempt to re-claim if this device is already mid-session —
  // covers the case where the link somehow survives (e.g. a bookmarked
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

const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
// Matches the checkmark already used for pair-success-badge elsewhere on
// this page, so "copied" reads as the same confirmation language.
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l6 6L20 6"></path></svg>';
const DOWNLOAD_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>';

function makeCopyButton(text) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn copy-btn';
  btn.title = 'Copy';
  btn.setAttribute('aria-label', 'Copy to clipboard');
  btn.innerHTML = COPY_ICON;
  let revertTimer = null;
  btn.addEventListener('click', () => {
    navigator.clipboard?.writeText(text).then(() => {
      clearTimeout(revertTimer);
      btn.innerHTML = CHECK_ICON;
      btn.classList.add('copied');
      revertTimer = setTimeout(() => {
        btn.innerHTML = COPY_ICON;
        btn.classList.remove('copied');
      }, 1500);
    });
  });
  return btn;
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
    const contentRow = document.createElement('div');
    contentRow.className = 'item-content-row';
    const a = document.createElement('a');
    a.href = item.content;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = item.content;
    contentRow.appendChild(a);
    contentRow.appendChild(makeCopyButton(item.content));
    row.appendChild(contentRow);
  } else if (item.type === 'link') {
    const contentRow = document.createElement('div');
    contentRow.className = 'item-content-row';
    const span = document.createElement('span');
    span.textContent = item.content;
    contentRow.appendChild(span);
    contentRow.appendChild(makeCopyButton(item.content));
    row.appendChild(contentRow);
  } else if (item.type === 'photo') {
    const fileUrl = `${relayUrl}${item.fileUrl}?token=${encodeURIComponent(token)}`;
    const img = document.createElement('img');
    img.src = fileUrl;
    img.alt = 'Received photo';
    row.appendChild(img);
    const dl = document.createElement('a');
    dl.href = fileUrl;
    dl.download = '';
    dl.className = 'icon-btn download-btn';
    dl.title = 'Download';
    dl.setAttribute('aria-label', 'Download photo');
    dl.innerHTML = DOWNLOAD_ICON;
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
  connPill.title = state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting…' : 'Disconnected';
  connPill.classList.remove('connected', 'connecting', 'disconnected');
  connPill.classList.add(state);
}

// -- SSE reconnect: two independent layers -------------------------------
// 1) Exponential backoff, taken over from EventSource's own native retry
//    (which is a fixed, largely opaque interval, not exponential, and not
//    observable from here). onerror closes the dead connection explicitly
//    and schedules the next attempt itself, backing off 1s -> 2s -> 4s...
//    capped at 30s, so a genuinely down network doesn't hammer the relay
//    while a brief blip still recovers fast. Reset to the base delay
//    happens in exactly two places: a successful onopen, and the top of
//    enterActiveState() for a brand-new session (so a previous session's
//    backoff never leaks into the next one).
// 2) A staleness watchdog for the OTHER failure mode this exists for: a
//    connection that never errors at all, just silently stops delivering
//    data — the classic "OS suspended the socket during sleep" case.
//    EventSource has no way to notice that on its own since nothing
//    actually failed at the API level, so this checks elapsed time since
//    the last message/ping instead of waiting on an error that may never
//    come.
const SSE_BASE_RETRY_MS = 1000;
const SSE_MAX_RETRY_MS = 30000;
let sseRetryDelay = SSE_BASE_RETRY_MS;
let sseRetryTimer = null;

// Just over 2x the relay's 15s keep-alive ping (see relay-server/routes/
// stream.js) — a couple of missed pings from ordinary scheduling jitter
// don't trigger this, but a connection that's gone properly silent does.
const SSE_STALE_MS = 40000;
let lastSseActivityAt = 0;
let sseWatchdog = null;

function noteSseActivity() {
  lastSseActivityAt = Date.now();
}

// Shared by the periodic watchdog below and the "check right now" triggers
// (tab becoming visible again, desktop app window shown from the tray or
// the system waking from sleep — see the visibilitychange listener and
// window.beamNative.onResumeCheck near the bottom of this file) so a stale
// connection gets caught immediately when the user actually looks at the
// screen again, not just whenever the next periodic tick happens to land.
function checkSseHealth() {
  if (!eventSource) return;
  if (Date.now() - lastSseActivityAt > SSE_STALE_MS) {
    connectReceivedFeed();
  }
}

function scheduleSseReconnect() {
  clearTimeout(sseRetryTimer);
  sseRetryTimer = setTimeout(connectReceivedFeed, sseRetryDelay);
  sseRetryDelay = Math.min(sseRetryDelay * 2, SSE_MAX_RETRY_MS);
}

function connectReceivedFeed() {
  disconnectReceivedFeed();
  loadBacklog();
  const { relayUrl, token } = loadConfig();
  if (!relayUrl || !token) return;
  setConnPill('connecting');
  noteSseActivity();
  eventSource = new EventSource(`${relayUrl}/events?token=${encodeURIComponent(token)}`);
  // Fires on the initial connect AND every automatic reconnect after a
  // drop — SSE has no delivery guarantee across a gap, so without re-running
  // the backlog fetch here, anything sent while disconnected would just be
  // silently missing with no indication anything went wrong.
  eventSource.onopen = () => {
    setConnPill('connected');
    noteSseActivity();
    sseRetryDelay = SSE_BASE_RETRY_MS; // a real connection resets the backoff
    loadBacklog();
  };
  eventSource.onerror = () => {
    setConnPill('disconnected');
    // Take over reconnection ourselves — close the dead connection
    // explicitly so the browser's own native auto-retry never also fires,
    // which would otherwise race our own scheduled attempt below.
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    scheduleSseReconnect();
  };
  eventSource.addEventListener('ping', noteSseActivity);
  eventSource.onmessage = (event) => {
    noteSseActivity();
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

  clearInterval(sseWatchdog);
  sseWatchdog = setInterval(checkSseHealth, 10000);
}

function disconnectReceivedFeed() {
  clearInterval(sseWatchdog);
  sseWatchdog = null;
  // Deliberately does NOT reset sseRetryDelay — this runs as the first line
  // of connectReceivedFeed() too (cleaning up before opening a new
  // connection), and a backoff-triggered retry needs its escalated delay
  // to survive that inner call. The delay only resets on a real onopen or
  // at the top of enterActiveState() for a brand-new session.
  clearTimeout(sseRetryTimer);
  sseRetryTimer = null;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  receivedList.innerHTML = '';
  receivedEmpty.style.display = 'block';
}

// The same staleness check that guards against a silently-dead connection
// on its own periodic timer (above) also runs immediately the moment the
// user actually looks at the screen again — a phone's browser tab coming
// back to the foreground, or (via beamNative.onResumeCheck, exposed by
// desktop-app/preload.js) the tray app's window being shown again or the
// whole system waking from sleep. Catching it right then, instead of
// waiting for the next periodic tick, is what actually fixes "reopening
// from the tray shows a stale view" at the source rather than papering
// over it with an unconditional reload.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkSseHealth();
});
window.beamNative?.onResumeCheck?.(() => checkSseHealth());

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
