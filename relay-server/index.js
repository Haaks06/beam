require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const inboxRoutes = require('./routes/inbox');
const pairRoutes = require('./routes/pair');
const itemRoutes = require('./routes/items');
const streamRoutes = require('./routes/stream');

const app = express();
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').split(',').filter(Boolean);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: CORS_ORIGIN.length ? CORS_ORIGIN : true,
  })
);
app.use(express.json());

// POST /inbox is the unauthenticated front door now that /pair/init
// requires a token (see routes/pair.js) — legitimate use is "once per new
// person setting up the app," so a stricter, hourly cap keeps mass
// inbox-creation abuse expensive without blocking normal setup.
const inboxLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.INBOX_LIMIT_PER_HOUR) || 5,
});
app.use('/inbox', inboxLimiter, inboxRoutes);

const pairLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20 });
app.use('/pair', pairLimiter, pairRoutes);

const itemLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120 });
app.use('/items', itemLimiter, itemRoutes);

app.use('/events', streamRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

// Serve the built PWA from the same origin/process when available, so a
// single relay URL (and a single tunnel/cert in production) covers both
// the API and the pairing/share page the QR code points at.
const webClientDist = path.join(__dirname, '..', 'web-client', 'dist');
if (fs.existsSync(webClientDist)) {
  app.use(express.static(webClientDist));
  app.get(/^(?!\/(inbox|pair|items|events|health)).*/, (req, res) => {
    res.sendFile(path.join(webClientDist, 'index.html'));
  });
}

// Multer/body-parser errors land here (bad file type, payload too large, etc).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || 400;
  res.status(status).json({ error: err.message || 'bad request' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`relay-server listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
