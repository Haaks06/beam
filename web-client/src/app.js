import './styles.css';
import jsQR from 'jsqr';
import { initP2P, bufToBase64, base64ToBuf } from './p2p.js';
import { openDb, CONFIG_STORE, saveReceivedItem, listReceivedItems, clearReceivedItems } from './idb.js';

async function setConfigValue(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONFIG_STORE, 'readwrite');
    tx.objectStore(CONFIG_STORE).put(value, key);
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
  localStorage.removeItem('lastIntent');
  localStorage.removeItem('myRemoteAddr');
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
const p2pIndicatorEl = document.getElementById('p2p-indicator');

let eventSource = null;
let invitePollTimer = null;
let countdownTimer = null;
// Phase 2a: peer-to-peer transfer with an encrypted-relay fallback (see
// p2p.js). Set up fresh in enterActiveState() for every new session, torn
// down in enterStartState()/enterEndedState() — never carried over between
// pairings, same lifecycle as eventSource itself.
let p2pController = null;
// Phase 2b: this device's own apparent address, as last reported by
// /pair/claim or /pair/status's remoteAddr (see relay-server/routes/
// pair.js) — captured wherever pairing actually completes, then handed to
// p2p.js so it can compare against the other device's and label a direct
// connection "same network" purely as an informational signal. Comparing
// remoteAddr doesn't change any connection logic itself — a real local
// fast-path already falls out of standard ICE candidate prioritization,
// which prefers lower-latency host candidates over STUN-reflexive ones on
// its own.
// Persisted alongside lastIntent for the same reason: a page reload mid-
// session shouldn't lose this purely-cosmetic "(same network)" label any
// more than it should lose the offerer/answerer role.
let myRemoteAddr = localStorage.getItem('myRemoteAddr') || null;
function setMyRemoteAddr(addr) {
  myRemoteAddr = addr;
  if (addr) localStorage.setItem('myRemoteAddr', addr);
  else localStorage.removeItem('myRemoteAddr');
}

function setP2pIndicator(mode) {
  if (!p2pIndicatorEl) return;
  if (mode === 'direct') {
    // Phase 2b: purely a label -- p2pController.isSameNetwork() reflects
    // whether both devices' relay-perceived addresses matched, computed
    // well before the connection itself settles, so it's always available
    // by the time 'direct' mode actually fires.
    const sameNetwork = p2pController?.isSameNetwork();
    p2pIndicatorEl.textContent = sameNetwork ? 'Direct (same network)' : 'Direct';
    p2pIndicatorEl.title = 'Sending straight to the other device, no relay in the middle';
  } else if (mode === 'relayed') {
    p2pIndicatorEl.textContent = 'Relayed (encrypted)';
    p2pIndicatorEl.title = "Couldn't connect directly — going through the relay, still end-to-end encrypted";
  } else {
    p2pIndicatorEl.textContent = 'Connecting…';
    p2pIndicatorEl.title = 'Trying a direct connection to the other device';
  }
  p2pIndicatorEl.style.display = 'inline-block';
  p2pIndicatorEl.classList.remove('direct', 'relayed');
  if (mode === 'direct' || mode === 'relayed') p2pIndicatorEl.classList.add(mode);
}

// Bumped every time we (re-)enter the invite flow or leave it (Cancel,
// pairing completing, page reload's own refreshState() call, etc). A
// /pair/init response's continuation only applies its result if this still
// matches the value captured when THAT specific request started — see
// enterInviteState()'s "stale invite" guard for the race this closes.
let inviteGeneration = 0;
// There's no upfront "I want to send" / "I want to receive" choice anymore
// — connecting always shows your own QR AND a code-entry field at once,
// whichever side of the pairing actually completes it first. This only
// picks a sensible default tab once paired: claiming someone else's code
// (typed, scanned, or via a scanned link) defaults to Send -- you scanned
// it because you want to send THEM something -- and generating your own
// code defaults to Receive, since that device is the one waiting for
// something to arrive.
//
// Also doubles as the deterministic WebRTC offerer/answerer split (see
// enterActiveState's isOfferer) -- which makes persisting it across a
// reload load-bearing, not just cosmetic. Found by testing a mid-session
// reload: without persistence this resets to the 'send' default on every
// reload, and if the device that originally claimed the code reloads, it
// silently starts computing the SAME role as the other side (both
// non-offerers), so the offer/answer exchange never happens and the P2P
// attempt hangs in 'connecting' forever with no error.
let lastIntent = localStorage.getItem('lastIntent') || 'send';
function setLastIntent(intent) {
  lastIntent = intent;
  localStorage.setItem('lastIntent', intent);
}

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
  p2pController?.teardown();
  p2pController = null;
  if (p2pIndicatorEl) p2pIndicatorEl.style.display = 'none';
  advancedSection.style.display = 'none';
  // Whatever P2P-direct items got locally cached for the session that's
  // now over (see saveReceivedItem in loadBacklog/renderItem below) are no
  // longer needed -- prune here so the store can't grow across many past
  // sessions.
  clearReceivedItems().catch(() => {});
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

const BURN_OUT_MS = 550;

function enterEndedState() {
  clearConfig();
  disconnectReceivedFeed();
  clearInterval(invitePollTimer);
  clearInterval(countdownTimer);
  p2pController?.teardown();
  p2pController = null;
  if (p2pIndicatorEl) p2pIndicatorEl.style.display = 'none';

  // Only play the dissolve when there's actually an active session visibly
  // burning away -- a 401 hit while still on the start/invite screen (e.g.
  // an already-expired token from a stale reload) has nothing on screen to
  // animate, so just cut straight to the ended screen.
  if (appShell.style.display === 'block') {
    appShell.classList.add('burn-out');
    setTimeout(() => {
      appShell.classList.remove('burn-out');
      showOnly('ended');
    }, BURN_OUT_MS);
  } else {
    showOnly('ended');
  }
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
  renderedLocalItemKeys = new Set(); // fresh session, fresh local-item dedup tracking
  connectReceivedFeed();

  // Phase 2a: kick off the P2P attempt (ECDH pubkey exchange + WebRTC
  // offer/answer/ICE, all over /signal) the moment a session goes active.
  // isOfferer needs to be a deterministic, already-established asymmetry
  // between the two devices rather than a race — lastIntent already
  // captures exactly that: 'send' means this device just claimed the
  // other's pairing code (see claimPairingCode()) and defaults to the Send
  // tab, 'receive' means it's the one that generated the code and is
  // defaulting to Receive. Arbitrary which side offers as long as both
  // sides agree, and they always do since it's derived the same way on
  // both ends of one pairing.
  const { relayUrl: p2pRelayUrl, token: p2pToken } = loadConfig();
  p2pController?.teardown();
  p2pController = initP2P({
    relayUrl: p2pRelayUrl,
    token: p2pToken,
    isOfferer: lastIntent === 'receive',
    myRemoteAddr,
    onModeChange: setP2pIndicator,
    // Regression fix: the desktop app's native save-to-folder/clipboard/
    // notify pipeline (main.js's `item-received` IPC handler) previously
    // only ever fired from the SSE (relay-delivered) path below -- a
    // P2P-direct arrival never touched it at all, silently breaking that
    // whole feature for anyone on the same network as their paired phone
    // (the P2P fast path's exact common case). Found by actually testing
    // the desktop app end-to-end rather than assuming Phase 2a's P2P work
    // couldn't have affected it.
    onItem: (item) => {
      renderItem(item, { prepend: true });
      window.beamNative?.itemReceived(item, p2pRelayUrl, p2pToken);
      // Same auto-copy the SSE/relay-delivered path has always had (see
      // connectReceivedFeed) -- found missing here entirely while testing
      // this exact change: a P2P-direct arrival (the common case for a
      // same-network pair) never triggered any clipboard copy at all,
      // regardless of content type, so the transport mode silently
      // determined whether this feature worked.
      copyIfLink(item);
    },
  });

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
        setMyRemoteAddr(data.remoteAddr);
        // This device generated the code and is the one that was waiting —
        // whoever just scanned/typed it did so because THEY want to send
        // something, so the initiator's natural role is Receive.
        setLastIntent('receive');
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
  // This device just scanned/typed someone else's code -- that's something
  // you do because you want to send them something, not because you're
  // waiting to receive.
  setLastIntent('send');
  const res = await fetch(`${relayUrl}/pair/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairingCode, label: deviceLabel() }),
  });
  if (!res.ok) throw new Error(await parseErrorMessage(res, 'pairing failed'));
  const { token, expiresAt, remoteAddr } = await res.json();
  await saveConfig({ relayUrl, token, expiresAt });
  setMyRemoteAddr(remoteAddr);
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

// Broader than isHttpUrl on purpose, and used for a different decision:
// isHttpUrl gates whether something renders as a clickable <a href> (strict
// -- a bare "example.com" with no scheme is not a safe href target as-is),
// this gates whether a received item is link-*like* enough to silently
// land in the clipboard. The relay's own /items/link endpoint already
// accepts arbitrary text, not just strict URLs (typing "example.com" or
// pasting a plain note both work) -- this mirrors that same looseness for
// the auto-copy decision, so "example.com" (no scheme) still auto-copies
// while an ordinary sentence doesn't. Deliberately a lightweight pattern,
// not a full URL parser: a scheme prefix, or the whole trimmed content
// looking like host(.host)+.tld optionally followed by a path/query/
// fragment/port -- not just any text that happens to mention a domain
// somewhere in a sentence.
function looksLikeLink(value) {
  const trimmed = (value || '').trim();
  if (/^https?:\/\//i.test(trimmed)) return true;
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(trimmed);
}

// Shared by both live-arrival paths (SSE and P2P-direct, see
// connectReceivedFeed and enterActiveState's onItem below) so a received
// link auto-copies the same way regardless of which transport actually
// delivered it -- found by testing that without this shared as one
// function, it was easy for one path to have the check and the other not.
// Only actual links auto-copy, not plain text/notes -- see looksLikeLink's
// comment. A plain-text item still shows up normally in the Received list
// and stays manually copyable via its copy-icon button (see
// makeCopyButton), it just doesn't silently land in the clipboard on
// arrival.
function copyIfLink(item) {
  if (item.type !== 'link' || !looksLikeLink(item.content)) return;
  navigator.clipboard?.writeText(item.content).then(
    () => setStatus(`Copied to clipboard: "${truncate(item.content, 60)}"`, 'success'),
    () => {
      // Some browsers refuse a clipboard write outside a direct user
      // gesture (notably Safari) — not fatal, the item is still right
      // there in the Received list to copy by hand.
    }
  );
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
// Matches the checkmark already used for pair-success-badge elsewhere on
// this page, so "copied" reads as the same confirmation language.
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l6 6L20 6"></path></svg>';
const DOWNLOAD_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>';
const FILE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path></svg>';

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

// Async because a relayed (non-P2P) encrypted item needs to be decrypted
// before it can be shown — a P2P-received item (see p2p.js's onItem
// callback) is never encrypted at the app level (WebRTC's own mandatory
// DTLS already covers that path) and resolves through this immediately.
async function renderItem(item, { prepend, persist = true } = { prepend: true }) {
  receivedEmpty.style.display = 'none';
  const { relayUrl, token } = loadConfig();

  // Regression fix: an item sent over the live P2P data channel never
  // touches the relay, so it has no relay-assigned `id` and GET
  // /items?since=... can never hand it back after a reload. Cache it
  // locally so this device's own reload/reconnect can restore it (see
  // loadBacklog's merge below) -- `persist: false` is passed back in from
  // that exact restore path so a reload doesn't re-cache what it just
  // read out of the same cache.
  if (persist && !item.id && token) {
    saveReceivedItem(token, item).catch(() => {});
  }

  const row = document.createElement('div');
  // Only a genuinely live SSE arrival gets the "just landed" treatment —
  // backlog items (initial load, reconnect catch-up) appear instantly so
  // the animation stays meaningful instead of firing on every page visit.
  row.className = prepend ? 'item-row land-in' : 'item-row';

  const time = new Date(item.createdAt).toLocaleString();
  const from = item.sourceLabel ? `from ${item.sourceLabel}` : '';

  let displayContent = item.content;
  if (item.encrypted && item.type === 'link' && p2pController) {
    try {
      const decryptedBuf = await p2pController.decryptFromRelay(base64ToBuf(item.content));
      displayContent = new TextDecoder().decode(decryptedBuf);
    } catch {
      // Shared secret not established (e.g. this device reloaded mid-
      // session and lost its ephemeral keypair) -- show plainly that it
      // couldn't be read rather than silently rendering ciphertext as if
      // it were the real content.
      displayContent = '[Encrypted — could not decrypt]';
    }
  }

  if (item.type === 'link' && isHttpUrl(displayContent)) {
    const contentRow = document.createElement('div');
    contentRow.className = 'item-content-row';
    const a = document.createElement('a');
    a.href = displayContent;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = displayContent;
    contentRow.appendChild(a);
    contentRow.appendChild(makeCopyButton(displayContent));
    row.appendChild(contentRow);
  } else if (item.type === 'link') {
    const contentRow = document.createElement('div');
    contentRow.className = 'item-content-row';
    const span = document.createElement('span');
    span.textContent = displayContent;
    contentRow.appendChild(span);
    contentRow.appendChild(makeCopyButton(displayContent));
    row.appendChild(contentRow);
  } else if (item.type === 'photo') {
    // A P2P-direct photo (see p2p.js's onItem callback / the sendPhotoBtn
    // handler above) arrives as base64 bytes with no relay fileUrl at all
    // -- nothing to fetch or decrypt, just decode it straight to a Blob.
    let fileSrc;
    if (item.dataBase64) {
      fileSrc = URL.createObjectURL(new Blob([base64ToBuf(item.dataBase64)], { type: item.mimeType || 'image/jpeg' }));
    } else {
      fileSrc = `${relayUrl}${item.fileUrl}?token=${encodeURIComponent(token)}`;
      if (item.encrypted && p2pController) {
        try {
          const encRes = await fetch(fileSrc);
          const encBuf = await encRes.arrayBuffer();
          const decBuf = await p2pController.decryptFromRelay(encBuf);
          fileSrc = URL.createObjectURL(new Blob([decBuf], { type: item.mimeType || 'image/jpeg' }));
        } catch {
          // Falls through with the raw (still-encrypted) fileSrc -- the
          // <img> just fails to decode it, which is at least visibly wrong
          // rather than silently showing nothing or the wrong content.
        }
      }
    }
    const img = document.createElement('img');
    img.src = fileSrc;
    img.alt = 'Received photo';
    row.appendChild(img);
    const dl = document.createElement('a');
    dl.href = fileSrc;
    dl.download = '';
    dl.className = 'icon-btn download-btn';
    dl.title = 'Download';
    dl.setAttribute('aria-label', 'Download photo');
    dl.innerHTML = DOWNLOAD_ICON;
    row.appendChild(dl);
  } else if (item.type === 'file') {
    // Same dual-path shape as 'photo' above (P2P dataBase64 vs. relay
    // fileUrl+decrypt), just rendered as a filename/icon row instead of an
    // <img> since it's an arbitrary PDF/.doc/.docx/.zip.
    let fileSrc;
    if (item.dataBase64) {
      fileSrc = URL.createObjectURL(new Blob([base64ToBuf(item.dataBase64)], { type: item.mimeType || 'application/octet-stream' }));
    } else {
      fileSrc = `${relayUrl}${item.fileUrl}?token=${encodeURIComponent(token)}`;
      if (item.encrypted && p2pController) {
        try {
          const encRes = await fetch(fileSrc);
          const encBuf = await encRes.arrayBuffer();
          const decBuf = await p2pController.decryptFromRelay(encBuf);
          fileSrc = URL.createObjectURL(new Blob([decBuf], { type: item.mimeType || 'application/octet-stream' }));
        } catch {
          // Falls through with the raw (still-encrypted) fileSrc.
        }
      }
    }
    const contentRow = document.createElement('div');
    contentRow.className = 'item-content-row file-row';
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.innerHTML = FILE_ICON;
    contentRow.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = item.filename || 'file';
    contentRow.appendChild(name);
    const dl = document.createElement('a');
    dl.href = fileSrc;
    dl.download = item.filename || '';
    dl.className = 'icon-btn download-btn';
    dl.title = 'Download';
    dl.setAttribute('aria-label', 'Download file');
    dl.innerHTML = DOWNLOAD_ICON;
    contentRow.appendChild(dl);
    row.appendChild(contentRow);
  } else if (item.type === 'voice') {
    // Same dual-path shape again, rendered as a native <audio> player.
    let fileSrc;
    if (item.dataBase64) {
      fileSrc = URL.createObjectURL(new Blob([base64ToBuf(item.dataBase64)], { type: item.mimeType || 'audio/webm' }));
    } else {
      fileSrc = `${relayUrl}${item.fileUrl}?token=${encodeURIComponent(token)}`;
      if (item.encrypted && p2pController) {
        try {
          const encRes = await fetch(fileSrc);
          const encBuf = await encRes.arrayBuffer();
          const decBuf = await p2pController.decryptFromRelay(encBuf);
          fileSrc = URL.createObjectURL(new Blob([decBuf], { type: item.mimeType || 'audio/webm' }));
        } catch {
          // Falls through with the raw (still-encrypted) fileSrc.
        }
      }
    }
    const contentRow = document.createElement('div');
    contentRow.className = 'item-content-row voice-row';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = fileSrc;
    contentRow.appendChild(audio);
    const dl = document.createElement('a');
    dl.href = fileSrc;
    dl.download = '';
    dl.className = 'icon-btn download-btn';
    dl.title = 'Download';
    dl.setAttribute('aria-label', 'Download voice memo');
    dl.innerHTML = DOWNLOAD_ICON;
    contentRow.appendChild(dl);
    row.appendChild(contentRow);
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

// Regression fix: local-only cache of items received over the live P2P
// data channel, which the relay never sees and so can never hand back
// through GET /items?since=... -- without this, reloading (or an SSE
// reconnect re-running loadBacklog) mid-session would silently lose them.
// Keyed by this device's own IndexedDB autoIncrement key rather than a
// relay id (P2P items don't have one), so repeated loadBacklog calls
// within the same session -- every SSE reconnect calls it again, not just
// the first load -- don't re-render the same locally-cached item twice.
// Reset only when a genuinely new session starts (enterActiveState), not
// on every reconnect within the same one.
let renderedLocalItemKeys = new Set();

async function loadBacklog() {
  const { relayUrl, token } = loadConfig();
  if (!token) return;
  const since = Number(localStorage.getItem('lastSeenId') || '0');
  let relayItems = [];
  try {
    const res = await fetch(`${relayUrl}/items?since=${since}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) return enterEndedState();
    if (res.ok) ({ items: relayItems } = await res.json());
  } catch {
    // Best-effort — the live SSE stream will still pick up anything new.
  }

  let localEntries = [];
  try {
    localEntries = (await listReceivedItems(token)).filter((entry) => !renderedLocalItemKeys.has(entry.key));
  } catch {
    // IndexedDB unavailable/broken — not fatal, just skip local restore.
  }

  const merged = [
    ...relayItems.map((item) => ({ item })),
    ...localEntries.map((entry) => ({ item: entry.item, key: entry.key })),
  ].sort((a, b) => (a.item.createdAt || 0) - (b.item.createdAt || 0));

  let maxRelayId = since;
  for (const { item, key } of merged) {
    await renderItem(item, { prepend: false, persist: false });
    if (item.id && item.id > maxRelayId) maxRelayId = item.id;
    if (key !== undefined) renderedLocalItemKeys.add(key);
  }
  if (maxRelayId > since) localStorage.setItem('lastSeenId', String(maxRelayId));
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
    copyIfLink(item);
  };
  // Pushed by the relay the instant it deletes an expired session (see
  // relay-server/lib/sessionCleanup.js) — reacting to this beats waiting for
  // the client's own countdown to reach zero, which could be seconds off if
  // this device's clock is skewed relative to the server's.
  eventSource.addEventListener('session-expired', () => enterEndedState());
  // Phase 2a: WebRTC/E2E-setup signaling (pubkey/offer/answer/ICE) — see
  // relay-server/routes/signal.js and p2p.js. A distinct named event from
  // the generic unnamed item message above, exactly so the two can never
  // be confused for one another.
  eventSource.addEventListener('signal', (event) => {
    p2pController?.handleSignal(JSON.parse(event.data));
  });

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
    // Phase 2a: try the P2P data channel first (waitUntilReady resolves
    // once a mode is actually settled, capped at p2p.js's own connect
    // timeout — never hangs indefinitely). Falls through to the relay,
    // AES-GCM encrypted with the derived shared secret, if direct send
    // isn't available (not yet connected, or it never connected at all).
    let sentDirect = false;
    if (p2pController) {
      await p2pController.waitUntilReady();
      sentDirect = p2pController.trySendDirect({ type: 'link', content: url, createdAt: Date.now() });
    }
    if (!sentDirect) {
      const encryptedBuf = await p2pController?.encryptForRelay(new TextEncoder().encode(url));
      const body = encryptedBuf
        ? { url: bufToBase64(encryptedBuf), encrypted: true }
        : { url }; // no p2pController (shouldn't happen while paired) -- plain send rather than failing outright
      const res = await fetch(`${relayUrl}/items/link`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 401) return enterEndedState();
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'send failed'));
    }
    // Names the actual content sent instead of a generic "Beamed!" — the
    // sender no longer sees this item echo back into their own Received
    // tab (the relay excludes them from their own broadcast now), so this
    // status line is the one place confirming exactly what went out.
    setStatus(`Sent (${sentDirect ? 'direct' : 'relayed'}): "${truncate(url, 60)}"`, 'success');
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
    const fileBuf = await selectedPhotoFile.arrayBuffer();

    // Phase 2a: same P2P-first, encrypted-relay-fallback shape as the link
    // sender. The data channel can't carry raw binary through this
    // module's JSON-envelope design, so a direct send base64-encodes the
    // bytes into the same envelope shape p2p.js's onItem hands back on the
    // receiving end (see renderItem()'s dataBase64 branch below) --
    // accepted overhead for a photo this size, not worth a second
    // wire format just to avoid it.
    let sentDirect = false;
    if (p2pController) {
      await p2pController.waitUntilReady();
      sentDirect = p2pController.trySendDirect({
        type: 'photo',
        mimeType: selectedPhotoFile.type || 'image/jpeg',
        dataBase64: bufToBase64(fileBuf),
        createdAt: Date.now(),
      });
    }
    if (!sentDirect) {
      const encryptedBuf = await p2pController?.encryptForRelay(fileBuf);
      let res;
      if (encryptedBuf) {
        res = await fetch(`${relayUrl}/items/photo?encrypted=true`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': selectedPhotoFile.type || 'image/jpeg' },
          body: encryptedBuf,
        });
      } else {
        // No p2pController (shouldn't happen while paired) -- plain
        // multipart send rather than failing outright.
        const fd = new FormData();
        fd.append('file', selectedPhotoFile);
        res = await fetch(`${relayUrl}/items/photo`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
      }
      if (res.status === 401) return enterEndedState();
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'send failed'));
    }
    setStatus(`Sent (${sentDirect ? 'direct' : 'relayed'}): ${truncate(selectedPhotoFile.name || 'photo', 60)}`, 'success');
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

// -- Phase 2d: generic file picker (PDF/.doc/.docx/.zip) -----------------
// Same P2P-first, encrypted-relay-fallback shape as sendPhotoBtn's
// handler, targeting /items/file instead.

const showFileBtn = document.getElementById('show-file-btn');
const fileSection = document.getElementById('file-section');
const genericFileInput = document.getElementById('generic-file-input');
const chooseFileBtn = document.getElementById('choose-file-btn');
const selectedFileNameEl = document.getElementById('selected-file-name');
const sendFileBtn = document.getElementById('send-file-btn');
let selectedGenericFile = null;

if (showFileBtn && fileSection) {
  showFileBtn.addEventListener('click', () => {
    const willShow = fileSection.style.display === 'none';
    fileSection.style.display = willShow ? 'block' : 'none';
  });
}
chooseFileBtn?.addEventListener('click', () => genericFileInput.click());
genericFileInput?.addEventListener('change', () => {
  selectedGenericFile = genericFileInput.files[0] || null;
  selectedFileNameEl.textContent = selectedGenericFile ? selectedGenericFile.name : '';
  sendFileBtn.disabled = !selectedGenericFile;
});

sendFileBtn?.addEventListener('click', async () => {
  const { relayUrl, token } = loadConfig();
  if (!token) return setStatus('Pair this device first.', 'error');
  if (!selectedGenericFile) return setStatus('Choose a file to send.', 'error');
  sendFileBtn.classList.add('sending');
  sendFileBtn.disabled = true;
  try {
    setStatus('Sending file...');
    const fileBuf = await selectedGenericFile.arrayBuffer();
    const mimeType = selectedGenericFile.type || 'application/octet-stream';

    let sentDirect = false;
    if (p2pController) {
      await p2pController.waitUntilReady();
      sentDirect = p2pController.trySendDirect({
        type: 'file',
        mimeType,
        filename: selectedGenericFile.name,
        dataBase64: bufToBase64(fileBuf),
        createdAt: Date.now(),
      });
    }
    if (!sentDirect) {
      const encryptedBuf = await p2pController?.encryptForRelay(fileBuf);
      let res;
      if (encryptedBuf) {
        res = await fetch(`${relayUrl}/items/file?encrypted=true`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
          body: encryptedBuf,
        });
      } else {
        const fd = new FormData();
        fd.append('file', selectedGenericFile);
        res = await fetch(`${relayUrl}/items/file`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
      }
      if (res.status === 401) return enterEndedState();
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'send failed'));
    }
    setStatus(`Sent (${sentDirect ? 'direct' : 'relayed'}): ${truncate(selectedGenericFile.name, 60)}`, 'success');
    selectedGenericFile = null;
    selectedFileNameEl.textContent = '';
    genericFileInput.value = '';
    sendFileBtn.disabled = true;
  } catch (err) {
    setStatus(`Failed to send file: ${err.message}`, 'error');
  } finally {
    sendFileBtn.classList.remove('sending');
    sendFileBtn.disabled = !selectedGenericFile;
  }
});

// -- Phase 2d: hold-to-record/release-to-send voice memo ------------------
// MediaRecorder's actual output MIME type varies by browser (Chrome/
// Firefox default to audio/webm, Safari to audio/mp4) -- whatever it
// reports is exactly what gets sent, matching one of lib/upload.js's
// ALLOWED_AUDIO_EXT entries either way.

const showVoiceBtn = document.getElementById('show-voice-btn');
const voiceSection = document.getElementById('voice-section');
const recordVoiceBtn = document.getElementById('record-voice-btn');
const voiceRecordStatus = document.getElementById('voice-record-status');

if (showVoiceBtn && voiceSection) {
  showVoiceBtn.addEventListener('click', () => {
    const willShow = voiceSection.style.display === 'none';
    voiceSection.style.display = willShow ? 'block' : 'none';
  });
}

let voiceRecorder = null;
let voiceChunks = [];
let voiceStream = null;

// A quick accidental tap on the record button used to start recording
// immediately, which was easy to trigger by mistake. Now a press has to be
// held past RECORD_ARM_DELAY_MS before it actually starts -- a tap shorter
// than that does nothing at all. recordState drives both the button's
// visual state (idle/arming/recording/sent, see styles.css) and the
// control flow below.
const RECORD_ARM_DELAY_MS = 350;
let recordState = 'idle'; // 'idle' | 'arming' | 'recording' | 'sent'
let armTimer = null;
let sentResetTimer = null;
// getUserMedia's permission prompt (first use) can take long enough that
// the user releases before it resolves -- without tracking this, that
// release would silently no-op (stopVoiceRecordingAndSend's own guard
// bails out when voiceRecorder is still null) and recording would start
// anyway right after release and never stop.
let releaseRequestedWhileStarting = false;

function setRecordState(state) {
  recordState = state;
  recordVoiceBtn.classList.remove('arming', 'recording', 'sent');
  if (state !== 'idle') recordVoiceBtn.classList.add(state);
}

function beginRecordPress() {
  if (recordState !== 'idle') return; // already arming/recording/sent -- ignore a duplicate press event
  clearTimeout(sentResetTimer);
  setRecordState('arming');
  voiceRecordStatus.textContent = 'Keep holding…';
  armTimer = setTimeout(() => {
    armTimer = null;
    startVoiceRecording();
  }, RECORD_ARM_DELAY_MS);
}

function endRecordPress() {
  if (recordState === 'arming') {
    // Released before the arm delay elapsed -- exactly the accidental-tap
    // case this is meant to absorb. Nothing was ever recorded.
    clearTimeout(armTimer);
    armTimer = null;
    setRecordState('idle');
    voiceRecordStatus.textContent = '';
    return;
  }
  if (recordState === 'recording') {
    if (!voiceRecorder) {
      // Still waiting on getUserMedia -- see releaseRequestedWhileStarting's
      // comment above. startVoiceRecording checks this flag once the
      // recorder actually starts.
      releaseRequestedWhileStarting = true;
      return;
    }
    stopVoiceRecordingAndSend();
  }
}

async function startVoiceRecording() {
  if (voiceRecorder) return; // already recording -- ignore a duplicate press
  setRecordState('recording');
  voiceRecordStatus.textContent = 'Recording… release to send';
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    voiceRecordStatus.textContent = `Couldn't access the microphone: ${err.message}`;
    setRecordState('idle');
    return;
  }
  voiceChunks = [];
  voiceRecorder = new MediaRecorder(voiceStream);
  voiceRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) voiceChunks.push(event.data);
  };
  voiceRecorder.start();
  if (releaseRequestedWhileStarting) {
    releaseRequestedWhileStarting = false;
    stopVoiceRecordingAndSend();
  }
}

async function stopVoiceRecordingAndSend() {
  if (!voiceRecorder || voiceRecorder.state === 'inactive') {
    setRecordState('idle');
    return;
  }
  const mimeType = voiceRecorder.mimeType || 'audio/webm';
  const stopped = new Promise((resolve) => {
    voiceRecorder.onstop = resolve;
  });
  voiceRecorder.stop();
  await stopped;
  for (const track of voiceStream.getTracks()) track.stop();

  const blob = new Blob(voiceChunks, { type: mimeType });
  voiceRecorder = null;
  voiceChunks = [];
  voiceStream = null;

  if (blob.size === 0) {
    voiceRecordStatus.textContent = 'Recording was empty — hold the button a moment longer.';
    setRecordState('idle');
    return;
  }

  const { relayUrl, token } = loadConfig();
  if (!token) {
    voiceRecordStatus.textContent = 'Pair this device first.';
    setRecordState('idle');
    return;
  }
  try {
    voiceRecordStatus.textContent = 'Sending…';
    const fileBuf = await blob.arrayBuffer();

    let sentDirect = false;
    if (p2pController) {
      await p2pController.waitUntilReady();
      sentDirect = p2pController.trySendDirect({
        type: 'voice',
        mimeType,
        dataBase64: bufToBase64(fileBuf),
        createdAt: Date.now(),
      });
    }
    if (!sentDirect) {
      const encryptedBuf = await p2pController?.encryptForRelay(fileBuf);
      let res;
      if (encryptedBuf) {
        res = await fetch(`${relayUrl}/items/voice?encrypted=true`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
          body: encryptedBuf,
        });
      } else {
        const fd = new FormData();
        fd.append('file', blob, `memo.${mimeType.includes('webm') ? 'webm' : 'audio'}`);
        res = await fetch(`${relayUrl}/items/voice`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
      }
      if (res.status === 401) return enterEndedState();
      if (!res.ok) throw new Error(await parseErrorMessage(res, 'send failed'));
    }
    setRecordState('sent');
    voiceRecordStatus.textContent = `Sent (${sentDirect ? 'direct' : 'relayed'}) — hold to record another.`;
    // "Sent" is a brief confirmation, not a sticky state -- back to idle
    // once it's had a moment to register.
    sentResetTimer = setTimeout(() => {
      if (recordState === 'sent') setRecordState('idle');
    }, 1500);
  } catch (err) {
    voiceRecordStatus.textContent = `Failed to send: ${err.message}`;
    setRecordState('idle');
  }
}

if (recordVoiceBtn) {
  recordVoiceBtn.addEventListener('mousedown', beginRecordPress);
  recordVoiceBtn.addEventListener('touchstart', (event) => {
    event.preventDefault(); // avoid the synthetic mousedown that would otherwise also fire
    beginRecordPress();
  });
  for (const evt of ['mouseup', 'mouseleave', 'touchend', 'touchcancel']) {
    recordVoiceBtn.addEventListener(evt, endRecordPress);
  }
}

// Phase 3b: chrome-extension's right-click "Beam this image/link" context
// menu items. The extension's background.js can't reach this page's own
// module state directly (no stable, published extension ID to address
// before this actually ships to the Web Store — see chrome-extension's
// STORE_LISTING.md), so chrome-extension/content-bridge.js -- a content
// script, which always has an implicit channel to its own extension's
// background regardless of ID -- relays the pending share in over
// window.postMessage instead. Entirely inert for every normal visit
// (phone, desktop app, plain browser): isExtensionPopup is only true when
// background.js itself opened this exact tab.
if (isExtensionPopup) {
  window.addEventListener('message', async (event) => {
    if (event.origin !== window.location.origin) return;
    const share = event.data;
    if (!share || share.source !== 'beam-extension') return;

    if (share.kind === 'error') {
      setStatus(share.message, 'error');
      return;
    }

    const { relayUrl, token, expiresAt } = loadConfig();
    if (!token || !expiresAt || expiresAt <= Date.now()) {
      setStatus('Pair this device first, then use "Beam this…" again.', 'error');
      return;
    }

    try {
      if (share.kind === 'link') {
        setStatus('Sending...');
        let sentDirect = false;
        if (p2pController) {
          await p2pController.waitUntilReady();
          sentDirect = p2pController.trySendDirect({ type: 'link', content: share.url, createdAt: Date.now() });
        }
        if (!sentDirect) {
          const encryptedBuf = await p2pController?.encryptForRelay(new TextEncoder().encode(share.url));
          const body = encryptedBuf ? { url: bufToBase64(encryptedBuf), encrypted: true } : { url: share.url };
          const res = await fetch(`${relayUrl}/items/link`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (res.status === 401) return enterEndedState();
          if (!res.ok) throw new Error(await parseErrorMessage(res, 'send failed'));
        }
        setStatus(`Sent (${sentDirect ? 'direct' : 'relayed'}): "${truncate(share.url, 60)}"`, 'success');
      } else if (share.kind === 'image') {
        setStatus('Sending image...');
        const fileBuf = base64ToBuf(share.dataBase64);
        const mimeType = share.mimeType || 'image/jpeg';
        let sentDirect = false;
        if (p2pController) {
          await p2pController.waitUntilReady();
          sentDirect = p2pController.trySendDirect({ type: 'photo', mimeType, dataBase64: share.dataBase64, createdAt: Date.now() });
        }
        if (!sentDirect) {
          const encryptedBuf = await p2pController?.encryptForRelay(fileBuf);
          const res = await fetch(`${relayUrl}/items/photo${encryptedBuf ? '?encrypted=true' : ''}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
            body: encryptedBuf || fileBuf,
          });
          if (res.status === 401) return enterEndedState();
          if (!res.ok) throw new Error(await parseErrorMessage(res, 'send failed'));
        }
        setStatus(`Sent (${sentDirect ? 'direct' : 'relayed'}): image`, 'success');
      }
    } catch (err) {
      setStatus(`Failed to send: ${err.message}`, 'error');
    }
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
