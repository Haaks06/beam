// One-directional relay -> desktop pub/sub, keyed by inbox_id. Every device
// belonging to an inbox receives every item posted to that inbox (same as
// the old single-inbox behavior); devices in other inboxes never see it.
// Each subscriber entry also tracks its own device id, so a broadcast can
// skip echoing an item straight back to whichever device just sent it.
const subscribers = new Map(); // inbox_id -> Set<{ res, deviceId }>

function subscribe(inboxId, deviceId, res) {
  if (!subscribers.has(inboxId)) {
    subscribers.set(inboxId, new Set());
  }
  const entry = { res, deviceId };
  subscribers.get(inboxId).add(entry);

  res.on('close', () => {
    const set = subscribers.get(inboxId);
    if (set) {
      set.delete(entry);
      if (set.size === 0) subscribers.delete(inboxId);
    }
  });
}

function broadcast(inboxId, event, excludeDeviceId) {
  const set = subscribers.get(inboxId);
  if (!set) return;
  const payload = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const { res, deviceId } of set) {
    if (excludeDeviceId != null && deviceId === excludeDeviceId) continue;
    res.write(payload);
  }
}

// Called by lib/sessionCleanup.js right before it deletes an expired
// inbox's rows — tells any live SSE clients the session is over (rather
// than letting their connection just go quiet), then closes the response
// so the browser's EventSource stops retrying against a now-gone inbox.
function expireInbox(inboxId) {
  const set = subscribers.get(inboxId);
  if (!set) return;
  for (const { res } of set) {
    res.write('event: session-expired\ndata: {}\n\n');
    res.end();
  }
  subscribers.delete(inboxId);
}

// Targeted delivery to "the other device" for WebRTC/E2E signaling (see
// routes/signal.js) — distinct from broadcast() above in two ways: it's a
// named `signal` SSE event rather than the generic unnamed item event (so
// the client can tell them apart via its own addEventListener('signal',
// ...)), and it reports back whether there was actually anyone to deliver
// to, since signaling has no persistence/replay — the caller uses that to
// answer 404 when the other device isn't currently connected.
function sendSignal(inboxId, fromDeviceId, data) {
  const set = subscribers.get(inboxId);
  if (!set) return false;
  const payload = `event: signal\ndata: ${JSON.stringify(data)}\n\n`;
  let delivered = false;
  for (const { res, deviceId } of set) {
    if (deviceId === fromDeviceId) continue;
    res.write(payload);
    delivered = true;
  }
  return delivered;
}

module.exports = { subscribe, broadcast, expireInbox, sendSignal };
