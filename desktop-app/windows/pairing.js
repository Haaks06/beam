const params = new URLSearchParams(window.location.search);
const relayUrl = params.get('relayUrl');
const token = params.get('token');
const isFirstRun = params.get('firstRun') === '1';

const qrImg = document.getElementById('qr');
const codeEl = document.getElementById('code');
const statusEl = document.getElementById('status');
const frameEl = document.getElementById('frame');

let pollTimer = null;

function setStatus(message, variant) {
  statusEl.textContent = message;
  statusEl.classList.remove('success', 'error');
  if (variant) statusEl.classList.add(variant);
}

async function init() {
  // /pair/init now requires auth: the code it mints is scoped to this
  // device's own inbox, so whoever claims it joins that same inbox.
  const res = await fetch(`${relayUrl}/pair/init`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    // Most likely cause: the relay's database was reset (e.g. a Render
    // free-tier disk wipe) and this app's token no longer exists there.
    // Restarting mints a fresh one — see main.js's isTokenValid check.
    throw new Error(data.error === 'invalid token' ? `${data.error} — try quitting and reopening the app` : data.error || `relay returned ${res.status}`);
  }
  qrImg.src = data.qrDataUrl;
  qrImg.onload = () => qrImg.classList.add('loaded');
  codeEl.textContent = data.pairingCode;
  frameEl?.classList.add('active');
  setStatus('Waiting for a device to scan or enter this code…');
  poll(data.pairingCode);
}

function poll(code) {
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${relayUrl}/pair/status/${code}`);
      const data = await res.json();
      if (data.status === 'claimed') {
        clearInterval(pollTimer);
        // Lock the viewfinder onto the beam-bright color before the window
        // closes — a beat of "landed" feedback rather than an abrupt cut.
        frameEl?.classList.add('locked');
        if (isFirstRun) {
          setStatus("You're all set! Beam will keep running quietly — look for its icon near your clock.", 'success');
          setTimeout(() => window.close(), 4000);
        } else {
          setStatus('Device paired! Closing…', 'success');
          setTimeout(() => window.close(), 1500);
        }
      }
    } catch (err) {
      setStatus('Lost connection to relay, retrying…', 'error');
    }
  }, 2000);
}

init().catch((err) => {
  setStatus(`Failed to reach relay: ${err.message}`, 'error');
});

// "Join with a code" — lets this PC become a *member* of an inbox someone
// else already owns (typed in, no camera/QR needed), instead of only ever
// being the one that generates a code for others to join.
const claimBtn = document.getElementById('claim-btn');
const claimInput = document.getElementById('claim-code-input');
if (claimBtn && claimInput && window.beamPair) {
  claimBtn.addEventListener('click', async () => {
    const code = claimInput.value.trim();
    if (!code) return setStatus('Enter a code.', 'error');
    claimBtn.disabled = true;
    setStatus('Joining…');
    const result = await window.beamPair.claimCode(code);
    if (result.ok) {
      clearInterval(pollTimer);
      setStatus('Joined! Closing…', 'success');
      setTimeout(() => window.close(), 1200);
    } else {
      claimBtn.disabled = false;
      setStatus(`Couldn't join: ${result.error}`, 'error');
    }
  });
}

// Username/password account signup+login — only present in welcome.html
// (first-run), not the "invite another device" pairing.html this same
// script is shared with.
const toggleAccountBtn = document.getElementById('toggle-account-btn');
const accountSection = document.getElementById('account-section');
const accountUsernameInput = document.getElementById('account-username');
const accountPasswordInput = document.getElementById('account-password');
const togglePasswordBtn = document.getElementById('toggle-password-btn');
const modeSignupBtn = document.getElementById('mode-signup-btn');
const modeLoginBtn = document.getElementById('mode-login-btn');
const accountSubmitBtn = document.getElementById('account-submit-btn');

if (toggleAccountBtn && accountSection) {
  toggleAccountBtn.addEventListener('click', () => {
    const showing = accountSection.style.display === 'block';
    accountSection.style.display = showing ? 'none' : 'block';
    toggleAccountBtn.textContent = showing ? 'Use a username & password instead' : 'Hide';
    if (!showing) accountUsernameInput.focus();
  });
}

if (togglePasswordBtn && accountPasswordInput) {
  togglePasswordBtn.addEventListener('click', () => {
    const revealed = accountPasswordInput.type === 'text';
    accountPasswordInput.type = revealed ? 'password' : 'text';
    togglePasswordBtn.textContent = revealed ? 'Show' : 'Hide';
  });
}

// One field set, one primary button — the mode toggle changes which action
// that button takes instead of showing two competing buttons for the same
// two fields, which read as "which one do I want?" rather than a single
// clear next step.
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

if (accountSubmitBtn && window.beamPair) {
  accountSubmitBtn.addEventListener('click', async () => {
    const username = accountUsernameInput.value.trim();
    const password = accountPasswordInput.value;
    if (!username || !password) return setStatus('Enter a username and password.', 'error');
    accountSubmitBtn.disabled = true;
    setStatus(accountMode === 'signup' ? 'Creating account…' : 'Logging in…');
    const ipcCall = accountMode === 'signup' ? window.beamPair.signupAccount : window.beamPair.loginAccount;
    const result = await ipcCall(username, password);
    if (result.ok) {
      clearInterval(pollTimer);
      setStatus(`You're "${result.displayName}"! Closing…`, 'success');
      setTimeout(() => window.close(), 1500);
    } else {
      accountSubmitBtn.disabled = false;
      setStatus(result.error, 'error');
    }
  });
}
