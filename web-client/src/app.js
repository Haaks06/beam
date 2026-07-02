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
const appShell = document.getElementById('app-shell');
const myLabelEl = document.getElementById('my-label');
const myLabelDetailEl = document.getElementById('my-label-detail');
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
const inviteFrame = document.getElementById('invite-frame');
const friendsSection = document.getElementById('friends-section');
const friendCodeInput = document.getElementById('friend-code-input');
const friendInviteOverlay = document.getElementById('friend-invite-overlay');
const friendInviteCodeEl = document.getElementById('friend-invite-code');
const friendInviteQrEl = document.getElementById('friend-invite-qr');
const friendInviteFrame = document.getElementById('friend-invite-frame');
const pendingRequestsWrap = document.getElementById('pending-requests');
const pendingList = document.getElementById('pending-list');
const friendsEmpty = document.getElementById('friends-empty');
const friendsList = document.getElementById('friends-list');
const sendToSelect = document.getElementById('send-to-select');
const accountUsernameInput = document.getElementById('account-username');
const accountPasswordInput = document.getElementById('account-password');
const togglePasswordBtn = document.getElementById('toggle-password-btn');
const modeSignupBtn = document.getElementById('mode-signup-btn');
const modeLoginBtn = document.getElementById('mode-login-btn');
const accountSubmitBtn = document.getElementById('account-submit-btn');
const devicesEmpty = document.getElementById('devices-empty');
const devicesList = document.getElementById('devices-list');
const tabNav = document.getElementById('tab-nav');
const tabIndicator = document.getElementById('tab-indicator');
const connPill = document.getElementById('conn-pill');
const connPillText = document.getElementById('conn-pill-text');

let eventSource = null;
let invitePollTimer = null;
let friendInvitePollTimer = null;

function setStatus(message, variant) {
  statusEl.textContent = message;
  statusEl.classList.remove('success', 'error');
  if (variant) statusEl.classList.add(variant);
}

// Send / Manage — separates "do something now" (Send: pick a recipient,
// pick text/link/photo, send) from occasional setup (Manage: pairing
// other devices, adding friends), instead of three tabs and a dozen
// visible sections all competing for attention at once.
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = { send: document.getElementById('tab-send'), manage: document.getElementById('tab-manage') };
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

// Once paired, the "get started" form has done its job — sweep it away so
// the page is just the tabbed app shell, not a form you have to look past.
function refreshPairedState() {
  const { relayUrl, token } = loadConfig();
  const paired = Boolean(token);
  startSection.classList.toggle('collapsed', paired);
  appShell.style.display = paired ? 'block' : 'none';
  if (paired) {
    // Fallback shown immediately; replaced by the real account display_name
    // (e.g. "frenzy horse") a moment later if this token belongs to an
    // account — checked on every load via GET /auth/me, not just once at
    // signup time, so it persists correctly across reloads.
    const label = deviceLabel();
    myLabelEl.textContent = label;
    myLabelDetailEl.textContent = label;
    loadIdentity();
    // Layout only settles once the shell is actually visible, so the tab
    // indicator's first position has to wait a frame rather than being
    // computed against a still-collapsed (0-width) nav.
    requestAnimationFrame(positionTabIndicator);
  } else if (connPill) {
    connPill.style.display = 'none';
  }
  if (relayUrl) relayUrlInput.value = relayUrl;
  if (paired) {
    connectReceivedFeed();
    loadConnections();
    loadDevices();
  } else {
    disconnectReceivedFeed();
  }
}

async function loadIdentity() {
  const { relayUrl, token } = loadConfig();
  try {
    const res = await fetch(`${relayUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const { isAccount, displayName } = await res.json();
    if (isAccount && displayName) {
      myLabelEl.textContent = displayName;
      myLabelDetailEl.textContent = displayName;
    }
  } catch {
    // Best-effort — keep the device-label fallback already shown.
  }
}

function setConnPill(state) {
  if (!connPill) return;
  connPill.style.display = 'inline-flex';
  connPill.classList.remove('connected', 'connecting', 'disconnected');
  connPill.classList.add(state);
  connPillText.textContent = state === 'connected' ? 'live' : state === 'connecting' ? 'connecting…' : 'offline';
}

repairLink.addEventListener('click', () => {
  disconnectReceivedFeed();
  startSection.classList.remove('collapsed');
  appShell.style.display = 'none';
  inviteSection.style.display = 'none';
  activateTab('send');
});

// The landing screen leads with one action (Start Beaming); signing in
// and joining-with-a-code are secondary paths tucked behind links so a
// first-time visitor isn't shown two forms' worth of fields before doing
// anything.
const showAccountBtn = document.getElementById('show-account-btn');
const showCodeBtn = document.getElementById('show-code-btn');
const accountSection = document.getElementById('account-section');
const codeSection = document.getElementById('code-section');
if (showAccountBtn && accountSection) {
  showAccountBtn.addEventListener('click', () => {
    const willShow = accountSection.style.display === 'none';
    accountSection.style.display = willShow ? 'block' : 'none';
    if (willShow) accountUsernameInput?.focus();
  });
}
if (showCodeBtn && codeSection) {
  showCodeBtn.addEventListener('click', () => {
    const willShow = codeSection.style.display === 'none';
    codeSection.style.display = willShow ? 'block' : 'none';
    if (willShow) pairingCodeInput?.focus();
  });
}

// Scanning another device's pairing QR opens this page with ?relay=&code=
// attached, so prefill the form instead of making the user type the code.
function prefillFromQrScan() {
  const params = new URLSearchParams(window.location.search);
  const relay = params.get('relay');
  const code = params.get('code');
  if (relay) relayUrlInput.value = relay;
  if (code) {
    pairingCodeInput.value = code.toUpperCase();
    // Scanning a pairing QR means the code section is exactly what this
    // visit is for — it can't stay collapsed behind the "Have a pairing
    // code?" link the way it does for a cold landing-page visit.
    if (codeSection) codeSection.style.display = 'block';
    // The scanning device (usually a phone) is very often already paired
    // to something else from an earlier session — refreshPairedState()
    // would otherwise collapse this whole form to zero height (the same
    // CSS "start-section is done, get out of the way" behavior a normal
    // already-paired visit relies on), making the code it just scanned
    // completely inaccessible. A scanned code always wins: force the
    // pairing form open and stop the old inbox's live feed, exactly like
    // clicking "Pair a different device" would.
    disconnectReceivedFeed();
    startSection.classList.remove('collapsed');
    appShell.style.display = 'none';
  }

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
    await saveConfig({ relayUrl, token });
    refreshPairedState();
    setStatus('', null);
    // Immediately offer to invite a second device — that's the whole point
    // of starting fresh on a device with nobody else paired to it yet.
    await showInvite();
  } catch (err) {
    setStatus(`Couldn't start: ${err.message}`, 'error');
  } finally {
    startBtn.classList.remove('sending');
    startBtn.disabled = false;
  }
});

// --- Accounts: one field set, one primary button — the mode toggle
// changes which action the button takes instead of showing two competing
// forms for the same two fields, which read as "which one do I want?"
// rather than a single clear next step. ---

if (togglePasswordBtn && accountPasswordInput) {
  togglePasswordBtn.addEventListener('click', () => {
    const revealed = accountPasswordInput.type === 'text';
    accountPasswordInput.type = revealed ? 'password' : 'text';
    togglePasswordBtn.textContent = revealed ? 'Show' : 'Hide';
  });
}

let accountMode = 'signup';
function setAccountMode(mode) {
  accountMode = mode;
  modeSignupBtn.classList.toggle('active', mode === 'signup');
  modeLoginBtn.classList.toggle('active', mode === 'login');
  accountSubmitBtn.textContent = mode === 'signup' ? 'Create account' : 'Log in';
  accountPasswordInput.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
}
if (modeSignupBtn && modeLoginBtn) {
  modeSignupBtn.addEventListener('click', () => setAccountMode('signup'));
  modeLoginBtn.addEventListener('click', () => setAccountMode('login'));
}

if (accountSubmitBtn) {
  accountSubmitBtn.addEventListener('click', async () => {
    const relayUrl = (relayUrlInput.value.trim() || window.location.origin).replace(/\/+$/, '');
    const username = accountUsernameInput.value.trim();
    const password = accountPasswordInput.value;
    if (!username || !password) return setStatus('Enter a username and password.', 'error');
    const endpoint = accountMode === 'signup' ? '/auth/signup' : '/auth/login';
    accountSubmitBtn.disabled = true;
    accountSubmitBtn.classList.add('sending');
    try {
      setStatus(accountMode === 'signup' ? 'Creating account...' : 'Logging in...');
      const res = await fetch(`${relayUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, label: deviceLabel() }),
      });
      if (!res.ok) throw new Error((await res.json()).error || `${accountMode} failed`);
      const { token, displayName } = await res.json();
      await saveConfig({ relayUrl, token });
      refreshPairedState();
      setStatus(accountMode === 'signup' ? `Welcome! You're "${displayName}".` : `Logged in as "${displayName}".`, 'success');
      accountPasswordInput.value = '';
    } catch (err) {
      setStatus(`Couldn't ${accountMode === 'signup' ? 'create account' : 'log in'}: ${err.message}`, 'error');
    } finally {
      accountSubmitBtn.disabled = false;
      accountSubmitBtn.classList.remove('sending');
    }
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
    inviteQrEl.classList.remove('loaded');
    inviteQrEl.onload = () => inviteQrEl.classList.add('loaded');
    inviteQrEl.src = data.qrDataUrl;
    inviteFrame?.classList.remove('locked');
    inviteFrame?.classList.add('active');
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
        // A beat of "locked on" feedback (frame + code flash to the beam's
        // bright core color) before the section disappears, rather than an
        // abrupt cut straight to gone.
        inviteFrame?.classList.add('locked');
        setStatus('Device paired!', 'success');
        setTimeout(() => {
          inviteSection.style.display = 'none';
        }, 700);
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
  // Rebuild the send-to options: keep "My devices", add one per friend.
  sendToSelect.innerHTML = '<option value="">My devices</option>';
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
    friendInviteQrEl.classList.remove('loaded');
    friendInviteQrEl.onload = () => friendInviteQrEl.classList.add('loaded');
    friendInviteQrEl.src = data.qrDataUrl;
    friendInviteFrame?.classList.add('active');
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

// --- Devices: works for both account holders and anonymous inboxes (the
// underlying GET /auth/devices only needs a valid token, not an account) —
// this is also the recovery path once a password exists with no reset
// flow, so it's not optional polish.
async function loadDevices() {
  const { relayUrl, token } = loadConfig();
  if (!token) return;
  try {
    const res = await fetch(`${relayUrl}/auth/devices`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const { devices } = await res.json();
    renderDevices(devices);
  } catch {
    // Best-effort — device list just won't update this cycle.
  }
}

function renderDevices(devices) {
  devicesEmpty.style.display = devices.length ? 'none' : 'block';
  devicesList.innerHTML = '';
  for (const device of devices) {
    const row = document.createElement('div');
    row.className = 'device-row';
    const meta = document.createElement('span');
    meta.textContent = device.label || 'Unnamed device';
    if (device.isCurrent) {
      const badge = document.createElement('span');
      badge.className = 'current-badge';
      badge.textContent = 'this device';
      meta.appendChild(badge);
    }
    row.appendChild(meta);
    if (!device.isCurrent) {
      const revokeBtn = document.createElement('button');
      revokeBtn.className = 'revoke';
      revokeBtn.textContent = 'Revoke';
      revokeBtn.addEventListener('click', () => revokeDevice(device.id));
      row.appendChild(revokeBtn);
    }
    devicesList.appendChild(row);
  }
}

async function revokeDevice(deviceId) {
  const { relayUrl, token } = loadConfig();
  try {
    const res = await fetch(`${relayUrl}/auth/devices/${deviceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error((await res.json()).error || 'revoke failed');
    await loadDevices();
    setStatus('Device revoked.', 'success');
  } catch (err) {
    setStatus(`Couldn't revoke device: ${err.message}`, 'error');
  }
}

// Toggles the beam-sweep-while-sending affordance on a button — the button
// itself visualizes "beaming" for the duration of the request, instead of
// only the text changing to "Sending...".
function withSendingState(btn, fn) {
  btn.classList.add('sending');
  btn.disabled = true;
  return fn().finally(() => {
    btn.classList.remove('sending');
    btn.disabled = false;
  });
}

document.getElementById('send-link-btn').addEventListener('click', async () => {
  const { relayUrl, token } = loadConfig();
  const url = document.getElementById('link-url').value.trim();
  if (!token) return setStatus('Pair this device first.', 'error');
  if (!url) return setStatus('Enter something to send.', 'error');
  const to = sendToSelect.value || undefined;
  const btn = document.getElementById('send-link-btn');
  await withSendingState(btn, async () => {
    try {
      setStatus('Sending...');
      const res = await fetch(`${relayUrl}/items/link`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, to }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'send failed');
      setStatus('Beamed!', 'success');
      document.getElementById('link-url').value = '';
    } catch (err) {
      setStatus(`Failed to send: ${err.message}`, 'error');
    }
  });
});

document.getElementById('send-photo-btn').addEventListener('click', async () => {
  const { relayUrl, token } = loadConfig();
  const fileInput = document.getElementById('photo-file');
  const file = fileInput.files[0];
  if (!token) return setStatus('Pair this device first.', 'error');
  if (!file) return setStatus('Choose a photo to send.', 'error');
  const btn = document.getElementById('send-photo-btn');
  await withSendingState(btn, () => sendPhoto(relayUrl, token, file, fileInput));
});

async function sendPhoto(relayUrl, token, file, fileInput) {
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
    setStatus('Photo beamed!', 'success');
    fileInput.value = '';
  } catch (err) {
    setStatus(`Failed to send photo: ${err.message}`, 'error');
  }
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
refreshPairedState();
prefillFromQrScan();

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
