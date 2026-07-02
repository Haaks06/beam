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
