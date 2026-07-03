require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const rateLimitHandler = require('./lib/rateLimitHandler');

const { version: APP_VERSION } = require('../package.json');

const inboxRoutes = require('./routes/inbox');
const pairRoutes = require('./routes/pair');
const itemRoutes = require('./routes/items');
const streamRoutes = require('./routes/stream');
const { startSessionCleanup } = require('./lib/sessionCleanup');

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
// requires a token (see routes/pair.js). This has been raised twice
// already (5/hour, then 30/hour) and both were still too tight — every
// single "tap Send, test, start over" cycle burns one, and normal heavy
// testing/demoing kept blowing through the cap well before the window
// reset. The real problem wasn't just the cap, it was the WINDOW: with a
// 1-hour window, hitting the limit means being locked out for up to a
// full hour, which is brutal for anyone actively testing. Switched to a
// much shorter window with a proportionally generous cap, so hitting it
// is both harder to do and, if it happens anyway, recovers in minutes
// instead of up to an hour. Inbox rows are cheap and self-cleaning (see
// lib/sessionCleanup.js's 10-minute abandoned-inbox sweep) — there's
// nothing expensive being protected here that justifies the old window.
// express-rate-limit's default handler replies with plain text ("Too many
// requests, please try again later.") — every client error path here
// unconditionally calls res.json() on a non-2xx response, so a rate limit
// hit surfaced as a raw "Unexpected token 'T' ... is not valid JSON" parse
// error instead of a readable message. One shared JSON handler for all
// three limiters fixes it at the source instead of patching every caller.
const inboxLimiter = rateLimit({
  windowMs: Number(process.env.INBOX_LIMIT_WINDOW_MS) || 10 * 60 * 1000,
  limit: Number(process.env.INBOX_LIMIT_PER_WINDOW) || 200,
  handler: rateLimitHandler,
});
app.use('/inbox', inboxLimiter, inboxRoutes);

// /pair's own per-route limiters live in routes/pair.js — the polling
// GET /pair/status/:code needs a much more generous bucket than the
// mutating POST routes (see comment there for why this used to be one
// shared limiter and why that was broken).
app.use('/pair', pairRoutes);

const itemLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, handler: rateLimitHandler });
app.use('/items', itemLimiter, itemRoutes);

app.use('/events', streamRoutes);

// Exposes the deployed version so the web client can show it and so anyone
// checking "is my deploy actually live" has a real answer instead of guessing.
app.get('/health', (req, res) => res.json({ ok: true, version: APP_VERSION }));

// Serve the built PWA from the same origin/process when available, so a
// single relay URL (and a single tunnel/cert in production) covers both
// the API and the pairing/share page the QR code points at.
//
// Two HTML entry points live in web-client/dist (see web-client/vite.config.js's
// multi-page build): landing.html is beamlot.com's marketing homepage, and
// index.html is the actual pairing app, now served at /app instead of the
// bare root. { index: false } turns off express.static's own automatic
// "serve index.html for a directory request" behavior — without it, a
// request for "/" would be answered by the static middleware itself before
// ever reaching the explicit landing-page route below.
const webClientDist = path.join(__dirname, '..', 'web-client', 'dist');
if (fs.existsSync(webClientDist)) {
  app.use(express.static(webClientDist, { index: false }));
  app.get('/', (req, res) => res.sendFile(path.join(webClientDist, 'landing.html')));
  // Everything else non-API — /app itself, and pairing-code links like
  // /ABC123 (see relay-server/routes/pair.js's pairingUrl) — is the actual
  // app. web-client's own client-side routing (see parsePairingLink() in
  // src/app.js) figures out from the path which of those it is.
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
  // Not started when this module is merely require()'d (e.g. by the test
  // suite) — tests drive lib/sessionCleanup's sweep() directly instead of
  // waiting on a real timer, and every test file requiring this module
  // would otherwise leave its own interval running.
  startSessionCleanup();
}

module.exports = app;
