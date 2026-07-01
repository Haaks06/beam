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

module.exports = { subscribe, broadcast };
