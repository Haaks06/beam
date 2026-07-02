require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { version: APP_VERSION } = require('../package.json');

const inboxRoutes = require('./routes/inbox');
const pairRoutes = require('./routes/pair');
const itemRoutes = require('./routes/items');
const streamRoutes = require('./routes/stream');
const { initRouter: connectInitRoutes, connectionsRouter } = require('./routes/connections');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').split(',').filter(Boolean);

// Render (and most PaaS hosts) terminate HTTPS at their edge and forward
// plain HTTP internally, setting X-Forwarded-Proto to tell us the original
// scheme. Without this, req.protocol always reports "http" behind such a
// proxy, so the QR/pairing URL built from it (see routes/pair.js) would
// point at an insecure http:// URL — which browsers block as mixed content
// once fetched from the https:// page, surfacing as a generic network
// error ("Load failed" in Safari) with no obvious cause.
app.set('trust proxy', 1);

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
// inbox-creation abuse expensive without blocking normal setup. 5/hour
// proved too tight in practice: retrying "Start Beaming" a few times, or
// a household/office behind one shared IP, burns through it and looks
// like the app is silently broken.
const inboxLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.INBOX_LIMIT_PER_HOUR) || 30,
});
app.use('/inbox', inboxLimiter, inboxRoutes);

const pairLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20 });
app.use('/pair', pairLimiter, pairRoutes);

const itemLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120 });
app.use('/items', itemLimiter, itemRoutes);

app.use('/events', streamRoutes);

// A connection request is accept-gated (never grants access on its own —
// see routes/connections.js), but repeated requests are still spam/
// harassment surface against a specific person, so both the code-based
// entry points and the accept/reject actions share this limiter.
const connectLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.CONNECT_LIMIT_PER_MINUTE) || 20,
});
app.use('/connect', connectLimiter, connectInitRoutes);
app.use('/connections', connectLimiter, connectionsRouter);

// routes/admin.js applies its own much-stricter limiter directly to
// /admin/login (a single static credential against online brute force
// needs a tighter limit than the read-only routes on this same prefix).
app.use('/admin', adminRoutes);

// routes/auth.js applies its own signup/login limiters directly, since the
// two endpoints need different limits (mass-account-creation vs
// brute-force concerns).
app.use('/auth', authRoutes);

// Exposes the deployed version so the web client can show it and so anyone
// checking "is my deploy actually live" has a real answer instead of guessing.
app.get('/health', (req, res) => res.json({ ok: true, version: APP_VERSION }));

// Serve the built PWA from the same origin/process when available, so a
// single relay URL (and a single tunnel/cert in production) covers both
// the API and the pairing/share page the QR code points at.
const webClientDist = path.join(__dirname, '..', 'web-client', 'dist');
if (fs.existsSync(webClientDist)) {
  app.use(express.static(webClientDist));
  app.get(/^(?!\/(inbox|pair|items|events|health|connect|connections|admin|auth)).*/, (req, res) => {
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
