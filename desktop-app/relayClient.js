const EventSource = require('eventsource');
const http = require('node:http');
const https = require('node:https');

class RelayClient {
  constructor({ relayUrl, token, onItem, onStatusChange }) {
    this.relayUrl = relayUrl.replace(/\/+$/, '');
    this.token = token;
    this.onItem = onItem;
    this.onStatusChange = onStatusChange || (() => {});
    this.lastSeenId = 0;
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

    this.source.onopen = () => this.onStatusChange('connected');
    this.source.onerror = () => this.onStatusChange('disconnected');
    this.source.onmessage = (event) => {
      try {
        const item = JSON.parse(event.data);
        this.lastSeenId = Math.max(this.lastSeenId, item.id);
        this.onItem(item);
      } catch (err) {
        console.error('failed to parse SSE event', err);
      }
    };
  }

  async backfill() {
    try {
      const items = await this.request('GET', `/items?since=${this.lastSeenId}`);
      for (const item of items.items || []) {
        this.lastSeenId = Math.max(this.lastSeenId, item.id);
        this.onItem(item);
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
