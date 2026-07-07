// Phase 2a: peer-to-peer transfer with an encrypted-relay fallback.
//
// On pairing completion, both devices exchange ephemeral ECDH public keys
// (over POST /signal — see relay-server/routes/signal.js) and derive a
// shared AES-GCM key neither side ever transmits. In parallel, both
// attempt a WebRTC connection using Google's public STUN server as the
// only ICE server, exchanging offer/answer/ICE candidates over the same
// /signal channel. If a data channel opens within SIGNAL_TIMEOUT_MS, every
// subsequent sendItem() goes straight over it — already protected by
// WebRTC's own mandatory DTLS encryption, no additional app-level
// encryption needed for that path. If it doesn't (expect this ~20-30% of
// the time, more on cellular/restrictive NATs), sendItem() falls back to
// POST /items/* exactly as before Phase 2a existed, except the payload is
// now AES-GCM encrypted with the derived shared secret and marked
// encrypted: true — the relay forwards ciphertext it can't read.
//
// This module knows nothing about the UI — app.js wires its callbacks
// (onModeChange, onItem) into the existing status pill / renderItem().

const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
// "A few seconds" per the spec — long enough for a real connection
// attempt (STUN round-trip + ICE checks), short enough that the relay
// fallback doesn't feel like the connection hung.
const CONNECT_TIMEOUT_MS = 6000;

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

async function generateEcdhKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
}

async function exportPubKey(keyPair) {
  const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return bufToBase64(raw);
}

async function deriveSharedKey(myKeyPair, peerPubKeyB64) {
  const peerPublicKey = await crypto.subtle.importKey(
    'raw',
    base64ToBuf(peerPubKeyB64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPublicKey },
    myKeyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// AES-GCM needs a fresh random IV per message — prefixed onto the
// ciphertext (a standard, safe way to carry it alongside the encrypted
// bytes) rather than transmitted separately, so the relay-fallback item
// payload is just one opaque blob either way (text content or a file body).
async function encryptForRelay(sharedKey, plainBuf) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, plainBuf);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return combined.buffer;
}

async function decryptFromRelay(sharedKey, combinedBuf) {
  const combined = new Uint8Array(combinedBuf);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sharedKey, ciphertext);
}

// Wraps fetch(`${relayUrl}/signal`) — every message this module sends
// (pubkey, offer, answer, ice-candidate) goes through this one function so
// callers never have to touch the endpoint's shape directly. Returns
// whether it was actually delivered (relay-server/routes/signal.js 202s
// only if the other device has a live SSE connection right now).
async function postSignalOnce(relayUrl, token, type, payload) {
  try {
    const res = await fetch(`${relayUrl}/signal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, payload }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// pubkey and the offer are retried until delivered (or the deadline
// passes) rather than sent once and forgotten. The answering device can
// take up to ~2s to even learn its pairing completed — see enterInviteState
// /pollInvite()'s 2-second poll interval in app.js — so a 404 ("nobody
// listening yet") on the very first attempt is the *common* case here,
// not a rare failure: this device may well finish generating its own
// keypair and offer before the other side has even entered its active
// state and started listening for `signal` events at all. Without a
// retry, that single dropped message means the whole handshake silently
// never happens, every time, defeating P2P far more often than any real
// network condition would.
async function postSignalRetrying(relayUrl, token, type, payload, deadline) {
  while (Date.now() < deadline) {
    if (await postSignalOnce(relayUrl, token, type, payload)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

// ICE candidates, by contrast, stay best-effort/non-retried: there are
// several over the life of one connection attempt (trickle ICE), and by
// the time they're being exchanged the retrying pubkey/offer above has
// already confirmed someone is listening.
async function postSignal(relayUrl, token, type, payload) {
  await postSignalOnce(relayUrl, token, type, payload);
}

export function initP2P({ relayUrl, token, isOfferer, onModeChange, onItem }) {
  let mode = 'connecting';
  let keyPair = null;
  let sharedKey = null;
  let pc = null;
  let channel = null;
  let settleTimer = null;
  let pendingCandidates = []; // queued until setRemoteDescription completes
  let remoteDescriptionSet = false;
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  // The pubkey exchange (retried up to the same deadline as the ICE
  // connection attempt, since it's a separate round trip over /signal) can
  // still be in flight at the exact moment ICE fails fast and settles mode
  // to 'relayed' -- without this, encryptForRelay() below would throw on
  // that race instead of the send just waiting the extra beat it needs.
  let resolveSharedKeyReady;
  const sharedKeyReady = new Promise((resolve) => {
    resolveSharedKeyReady = resolve;
  });

  // Shared by encryptForRelay/decryptFromRelay below: waitUntilReady() only
  // waits for the connection-mode decision (direct vs relayed), which can
  // settle before the independent pubkey round trip finishes -- give it a
  // bounded extra beat rather than failing an encrypt/decrypt that would
  // have worked a moment later.
  async function ensureSharedKey() {
    if (sharedKey) return;
    await Promise.race([sharedKeyReady, new Promise((resolve) => setTimeout(resolve, CONNECT_TIMEOUT_MS))]);
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    onModeChange?.(next);
  }

  async function flushPendingCandidates() {
    const queued = pendingCandidates;
    pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // A stale/invalid candidate here isn't fatal -- WebRTC tolerates a
        // few failed candidates fine as long as at least one pair works.
      }
    }
  }

  function setupDataChannel(ch) {
    channel = ch;
    channel.onopen = () => {
      clearTimeout(settleTimer);
      setMode('direct');
      resolveReady();
    };
    channel.onclose = () => {
      // A channel that closes mid-session (network change, peer navigating
      // away) drops back to the relay fallback for anything sent after --
      // sendItem() below only ever checks "is the channel open right now."
      if (mode === 'direct') setMode('relayed');
    };
    channel.onmessage = (event) => {
      try {
        const item = JSON.parse(event.data);
        onItem?.(item);
      } catch {
        // Malformed frame from a peer -- ignore rather than crash the page.
      }
    };
  }

  function createPeerConnection() {
    pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    pc.onicecandidate = (event) => {
      if (event.candidate) postSignal(relayUrl, token, 'ice-candidate', event.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      if ((pc.connectionState === 'failed' || pc.connectionState === 'closed') && mode !== 'relayed') {
        setMode('relayed');
        resolveReady();
      }
    };
    if (isOfferer) {
      setupDataChannel(pc.createDataChannel('beam'));
    } else {
      pc.ondatachannel = (event) => setupDataChannel(event.channel);
    }
  }

  async function startOffer(deadline) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await postSignalRetrying(relayUrl, token, 'offer', { sdp: offer.sdp, type: offer.type }, deadline);
  }

  // Tracks the exact pubkey string already derived from, distinct from
  // just "do we have a sharedKey at all" -- a mid-session reload on either
  // device generates a brand-new ECDH keypair and immediately (re-)sends
  // its pubkey (see start() below), but the old "if (sharedKey) return"
  // guard here ignored that entirely once a key had ever been derived
  // once. The peer that didn't reload kept encrypting/decrypting with the
  // now-stale key, silently breaking relay-fallback for the rest of the
  // session ("no shared key established yet" / failed decrypts were the
  // visible symptom, not the actual cause). Re-deriving on any genuinely
  // new incoming key fixes it either direction; only an exact repeat of
  // the same key (postSignalRetrying resends every 400ms until delivered)
  // is skipped, to avoid pointless re-derivation of what's already current.
  let lastProcessedPubKeyB64 = null;
  async function handlePubkey(payload) {
    if (payload.key === lastProcessedPubKeyB64) return;
    const isFirstKeyThisInstance = lastProcessedPubKeyB64 === null;
    lastProcessedPubKeyB64 = payload.key;
    sharedKey = await deriveSharedKey(keyPair, payload.key);
    resolveSharedKeyReady();
    // Re-sending here (not just once from start()) is what actually closes
    // the reload gap: start() only ever sends this device's own pubkey
    // once, retried for a few seconds after *this* instance was created.
    // The device that DIDN'T reload has long since stopped retrying its
    // original send by the time the other one comes back with a fresh
    // keypair -- without echoing a pubkey back here, the reloaded device
    // would derive a key from the peer's pubkey just fine, but the peer
    // would never receive the reloaded device's *new* key at all, since
    // nothing would ever prompt it to send one again. Skipped on this
    // instance's own first-ever key (isFirstKeyThisInstance) purely so a
    // completely normal, never-reloaded pairing doesn't do a redundant
    // extra round trip on top of start()'s own initial send -- the guard
    // above (skip an exact repeat) is what stops this from ping-ponging
    // forever once both sides have caught up.
    if (!isFirstKeyThisInstance) {
      const pubKeyB64 = await exportPubKey(keyPair);
      postSignalRetrying(relayUrl, token, 'pubkey', { key: pubKeyB64 }, Date.now() + CONNECT_TIMEOUT_MS);
    }
  }

  async function handleOffer(payload) {
    if (!pc) return;
    await pc.setRemoteDescription({ type: payload.type, sdp: payload.sdp });
    remoteDescriptionSet = true;
    await flushPendingCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await postSignal(relayUrl, token, 'answer', { sdp: answer.sdp, type: answer.type });
  }

  async function handleAnswer(payload) {
    if (!pc) return;
    await pc.setRemoteDescription({ type: payload.type, sdp: payload.sdp });
    remoteDescriptionSet = true;
    await flushPendingCandidates();
  }

  async function handleIceCandidate(payload) {
    if (!pc) return;
    if (!remoteDescriptionSet) {
      // Candidates can arrive before the offer/answer that establishes the
      // remote description, especially for the answerer (who hasn't set
      // one at all until handleOffer runs) -- queue rather than drop them.
      pendingCandidates.push(payload);
      return;
    }
    try {
      await pc.addIceCandidate(payload);
    } catch {
      // Same tolerance as flushPendingCandidates above.
    }
  }

  // Public: called by app.js for every incoming `signal` SSE event.
  async function handleSignal({ type, payload }) {
    if (type === 'pubkey') return handlePubkey(payload);
    if (type === 'offer') return handleOffer(payload);
    if (type === 'answer') return handleAnswer(payload);
    if (type === 'ice-candidate') return handleIceCandidate(payload);
  }

  async function start() {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;

    keyPair = await generateEcdhKeyPair();
    const pubKeyB64 = await exportPubKey(keyPair);
    postSignalRetrying(relayUrl, token, 'pubkey', { key: pubKeyB64 }, deadline);

    createPeerConnection();
    settleTimer = setTimeout(() => {
      if (mode === 'connecting') {
        setMode('relayed');
        resolveReady();
      }
    }, CONNECT_TIMEOUT_MS);

    if (isOfferer) await startOffer(deadline);
  }

  function teardown() {
    clearTimeout(settleTimer);
    if (channel) {
      try {
        channel.close();
      } catch {
        // already closed
      }
    }
    if (pc) {
      try {
        pc.close();
      } catch {
        // already closed
      }
    }
    pc = null;
    channel = null;
    sharedKey = null;
    keyPair = null;
    mode = 'connecting';
  }

  start();

  return {
    // Called by app.js for every incoming `signal` SSE event.
    handleSignal,
    teardown,
    getMode: () => mode,
    // Resolves once a mode has been settled on -- either 'direct' (the
    // data channel just opened) or 'relayed' (it failed or the connect
    // timeout ran out). Callers should await this before their first send
    // attempt so they're not racing a decision that hasn't been made yet.
    waitUntilReady: () => ready,
    // Sends directly over the data channel if it's open, returning true;
    // returns false if the caller needs to fall back to its own POST
    // /items/* call (using encryptForRelay below to prepare the payload
    // first). Keeping the actual HTTP/error-handling/UI-status logic in
    // app.js, where it already lives, rather than duplicating it here.
    //
    // channel.send() itself can throw -- confirmed in practice for a
    // photo/file/voice memo large enough to exceed the data channel's
    // negotiated max-message-size (base64-encoding a multi-MB file for the
    // JSON envelope inflates it further). Uncaught, that exception used to
    // abort the whole send instead of falling back to the relay path this
    // function already exists to trigger -- "failing to send at all" for
    // anything over the limit, even though the relay fallback would have
    // handled it fine.
    trySendDirect(itemPayload) {
      if (channel && channel.readyState === 'open') {
        try {
          channel.send(JSON.stringify(itemPayload));
          return true;
        } catch {
          return false;
        }
      }
      return false;
    },
    // Callers (see app.js's sendLinkText/sendSelectedPhoto/etc.) interpolate
    // this message directly into a user-facing "Failed to send: ..."
    // status line -- worded as plain language on purpose, not as an
    // internal/debug string, for the rare case this bounded wait genuinely
    // times out (e.g. the other device's browser lacks WebRTC/WebCrypto
    // entirely) rather than just being a beat too early.
    async encryptForRelay(plainBuf) {
      await ensureSharedKey();
      if (!sharedKey) throw new Error("couldn't set up encryption with the other device");
      return encryptForRelay(sharedKey, plainBuf);
    },
    // Same bounded wait as encryptForRelay, for the same reason -- an
    // incoming item can arrive (over SSE) before this device's own pubkey
    // round trip has finished, especially right after a fresh pairing.
    // Previously this threw immediately in that window, which is a
    // meaningful chunk of "arriving but failing to decrypt" reports: it's
    // not that the item is undecryptable, just that decryption was
    // attempted a beat too early.
    async decryptFromRelay(combinedBuf) {
      await ensureSharedKey();
      if (!sharedKey) throw new Error("couldn't set up encryption with the other device");
      return decryptFromRelay(sharedKey, combinedBuf);
    },
  };
}

export { bufToBase64, base64ToBuf };
