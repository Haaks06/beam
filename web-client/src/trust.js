// Phase 2c: opt-in trusted-device local re-pairing. Off by default —
// nothing here runs unless the user explicitly enables "Remember this
// pairing" during an active session, and pairing without ever touching
// this feature behaves exactly as it always has. Purely client-side: no
// new server identity, no account — the relay only ever sees the same
// short-lived, single-use pairing codes it always has (see
// relay-server/routes/pair.js's optional preferredCode), with no concept
// of "trust" at all.
//
// How it works:
// 1. Enabling the toggle generates a random 32-byte secret and sends a
//    `trust-handshake` control message — { type, id, secret, label } — to
//    the other device over whatever channel is already active (the P2P
//    data channel, or the AES-GCM-encrypted relay fallback; either way
//    already secure). See app.js for how that message actually gets sent
//    and intercepted on receipt (it's disguised as a normal encrypted
//    link item for the relay path, since the relay's own /items/link
//    always stores type 'link' regardless of what the client calls it —
//    there's no other item-shaped channel available without a new relay
//    endpoint, which would defeat the "purely client-side" point of this
//    feature).
// 2. The receiving device stores { id, label, secret } locally and, if
//    this is a genuinely new id it hasn't seen before, auto-replies with
//    its own handshake carrying the same id+secret but its own label —
//    so both sides end up knowing the correct other-side label from one
//    user action instead of two.
// 3. Later, "Reconnect with [label]" derives a 6-character code via
//    HMAC-SHA256(secret, time bucket) on both devices independently, for
//    the same ~60-second window, with no new communication needed to
//    agree on it. Whichever device tries first asks POST /pair/init for
//    that exact value (its preferredCode); the other's POST /pair/claim
//    finds it already there. No QR, no typing — as long as both devices
//    attempt within roughly the same window; falls back to the normal
//    manual flow otherwise.

import { openDb, TRUSTED_DEVICES_STORE } from './idb.js';

export const TRUST_CONTROL_TYPE = 'trust-handshake';

// Matches relay-server/routes/pair.js's CODE_ALPHABET/CODE_LENGTH exactly
// — a derived code has to have the same shape a normal one does.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const TIME_BUCKET_MS = 60 * 1000;
// How long an auto-reconnect attempt keeps retrying before giving up and
// leaving the user on the normal manual pairing screen. Generous relative
// to TIME_BUCKET_MS so a couple of bucket rolls don't cost the attempt
// entirely if the two devices' clocks/launches are a little out of step.
const RECONNECT_TIMEOUT_MS = 25000;
const RECONNECT_RETRY_MS = 2000;

function bufToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function deriveCode(secretB64, timeBucket) {
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBuf(secretB64),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(timeBucket)));
  const sig = new Uint8Array(sigBuf);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[sig[i] % CODE_ALPHABET.length];
  return code;
}

function currentBucket(offset = 0) {
  return Math.floor(Date.now() / TIME_BUCKET_MS) + offset;
}

export function isControlMessage(item) {
  return !!item && item.type === TRUST_CONTROL_TYPE;
}

export function buildHandshakeMessage(id, secretB64, label) {
  return { type: TRUST_CONTROL_TYPE, id, secret: secretB64, label };
}

export function generateHandshake(myLabel) {
  const id = crypto.randomUUID();
  const secretB64 = bufToBase64(crypto.getRandomValues(new Uint8Array(32)).buffer);
  return { id, secretB64, message: buildHandshakeMessage(id, secretB64, myLabel) };
}

export async function listTrustedDevices() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRUSTED_DEVICES_STORE, 'readonly');
    const req = tx.objectStore(TRUSTED_DEVICES_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function getTrustedDevice(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRUSTED_DEVICES_STORE, 'readonly');
    const req = tx.objectStore(TRUSTED_DEVICES_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveTrustedDevice({ id, label, secret }) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRUSTED_DEVICES_STORE, 'readwrite');
    tx.objectStore(TRUSTED_DEVICES_STORE).put({ id, label, secret, createdAt: Date.now() });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeTrustedDevice(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRUSTED_DEVICES_STORE, 'readwrite');
    tx.objectStore(TRUSTED_DEVICES_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Called on receiving a trust-handshake (from app.js, wherever a control
// message is intercepted). Stores it locally, and reports whether this
// device should auto-reply (true only the first time this id is seen —
// the reply itself, arriving back at the original sender, must not
// trigger yet another reply).
export async function handleIncomingHandshake({ id, secret, label }) {
  const existing = await getTrustedDevice(id);
  await saveTrustedDevice({ id, label, secret });
  return { shouldReply: !existing };
}

// The actual auto-reconnect attempt for "Reconnect with [label]". Tries
// both roles (claim first, in case the other device already minted the
// code; mint-and-wait otherwise) and keeps retrying as the time bucket
// rolls over, up to RECONNECT_TIMEOUT_MS. Resolves to
// { token, expiresAt, relayUrl } on success, or null if it never
// connected within the timeout (caller falls back to manual pairing).
export async function attemptAutoReconnect(device, relayUrl, { deviceLabel, parseErrorMessage }) {
  const deadline = Date.now() + RECONNECT_TIMEOUT_MS;

  const inboxRes = await fetch(`${relayUrl}/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: deviceLabel() }),
  });
  if (!inboxRes.ok) return null;
  const { token: myToken } = await inboxRes.json();

  let mintedCode = null; // the exact value minted, once init succeeds -- never re-derived afterward

  while (Date.now() < deadline) {
    // Try the current bucket and the one just before it -- covers the
    // case where this device's clock ticked over to a new bucket a
    // moment before the other device's, without needing them perfectly
    // synchronized.
    for (const offset of [0, -1]) {
      const code = await deriveCode(device.secret, currentBucket(offset));
      // Never attempt to claim a code this exact device already minted
      // itself -- found the hard way in testing: both devices derive and
      // race to mint the SAME code, one wins and the other falls back to
      // a random one, but without this guard the winner's own next loop
      // iteration would go on to "claim" its own just-minted code as if a
      // second device were joining, quietly self-pairing (two device rows
      // in its own inbox, neither of which is actually the other real
      // device) and reporting false success instead of waiting for the
      // other device to show up.
      if (code === mintedCode) continue;
      try {
        const claimRes = await fetch(`${relayUrl}/pair/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pairingCode: code, label: deviceLabel() }),
        });
        if (claimRes.ok) {
          const { token, expiresAt } = await claimRes.json();
          return { token, expiresAt, relayUrl };
        }
      } catch {
        // Network hiccup -- keep retrying within the deadline.
      }
    }

    if (!mintedCode) {
      const code = await deriveCode(device.secret, currentBucket());
      try {
        const initRes = await fetch(`${relayUrl}/pair/init`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${myToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ preferredCode: code }),
        });
        if (initRes.ok) {
          const initData = await initRes.json();
          // The relay may have fallen back to a random code if this exact
          // value somehow collided with an already-pending one -- always
          // poll whatever it actually minted, not what was requested.
          mintedCode = initData.pairingCode;
        }
      } catch {
        // Try again next tick.
      }
    } else {
      // Already minted a code and are waiting on the other device to
      // claim it -- check the SAME code every time, not a freshly
      // re-derived one (the time bucket may have rolled over since).
      try {
        const statusRes = await fetch(`${relayUrl}/pair/status/${mintedCode}`);
        if (statusRes.ok) {
          const data = await statusRes.json();
          if (data.status === 'claimed' && data.expiresAt) {
            return { token: myToken, expiresAt: data.expiresAt, relayUrl };
          }
        }
      } catch {
        // Try again next tick.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, RECONNECT_RETRY_MS));
  }

  return null;
}
