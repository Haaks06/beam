const EventSource = require('eventsource');
const http = require('node:http');
const https = require('node:https');

class RelayClient {
  constructor({ relayUrl, token, lastSeenId, onItem, onStatusChange, onLastSeenIdChange }) {
    this.relayUrl = relayUrl.replace(/\/+$/, '');
    this.token = token;
    this.onItem = onItem;
    this.onStatusChange = onStatusChange || (() => {});
    this.onLastSeenIdChange = onLastSeenIdChange || (() => {});
    // Starting from a persisted id (rather than always 0) is what stops
    // every relaunch from re-fetching and re-notifying about the entire
    // history of items ever sent to this inbox.
    this.lastSeenId = lastSeenId || 0;
    this.source = null;
  }

  start() {
    this.backfill().finally(() => this.connectStream());
  }

  stop() {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }

  connectStream() {
    const url = `${this.relayUrl}/events?token=${encodeURIComponent(this.token)}`;
    this.source = new EventSource(url);

    this.source.onopen = () => {
      this.onStatusChange('connected');
      // Fires on the initial connect AND every automatic reconnect after a
      // drop. SSE has no delivery guarantee across a gap, so without this,
      // anything sent while disconnected would be silently lost — you'd
      // just see "connected" again with no sign anything was missed.
      this.backfill();
    };
    this.source.onerror = () => this.onStatusChange('disconnected');
    this.source.onmessage = (event) => {
      try {
        const item = JSON.parse(event.data);
        this.advanceLastSeenId(item.id);
        // Live delivery, not a catch-up batch — this is the one case that
        // should interrupt you (clipboard copy + notification).
        this.onItem(item, { isBacklog: false });
      } catch (err) {
        console.error('failed to parse SSE event', err);
      }
    };
  }

  advanceLastSeenId(id) {
    if (id <= this.lastSeenId) return;
    this.lastSeenId = id;
    this.onLastSeenIdChange(id);
  }

  async backfill() {
    try {
      const items = await this.request('GET', `/items?since=${this.lastSeenId}`);
      for (const item of items.items || []) {
        this.advanceLastSeenId(item.id);
        // Catch-up items (on launch, on reconnect, on first joining an
        // inbox) — could be a whole batch at once, so these must NOT each
        // trigger their own clipboard overwrite + notification popup.
        this.onItem(item, { isBacklog: true });
      }
    } catch (err) {
      console.error('backfill failed', err);
    }
  }

  request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, this.relayUrl);
      const client = url.protocol === 'https:' ? https : http;
      const payload = body ? JSON.stringify(body) : null;

      const req = client.request(
        url,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

module.exports = RelayClient;
