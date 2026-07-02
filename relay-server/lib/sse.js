// One-directional relay -> desktop pub/sub, keyed by inbox_id. Every device
// belonging to an inbox receives every item posted to that inbox (same as
// the old single-inbox behavior); devices in other inboxes never see it.
const subscribers = new Map(); // inbox_id -> Set<ServerResponse>

function subscribe(inboxId, res) {
  if (!subscribers.has(inboxId)) {
    subscribers.set(inboxId, new Set());
  }
  subscribers.get(inboxId).add(res);

  res.on('close', () => {
    const set = subscribers.get(inboxId);
    if (set) {
      set.delete(res);
      if (set.size === 0) subscribers.delete(inboxId);
    }
  });
}

function broadcast(inboxId, event) {
  const set = subscribers.get(inboxId);
  if (!set) return;
  const payload = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
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
  for (const res of set) {
    res.write('event: session-expired\ndata: {}\n\n');
    res.end();
  }
  subscribers.delete(inboxId);
}

module.exports = { subscribe, broadcast, expireInbox };
