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
const signalRoutes = require('./routes/signal');
const clientErrorRoutes = require('./routes/clientError');
const { startSessionCleanup } = require('./lib/sessionCleanup');
const { PUBLIC_RELAY_URL } = require('./lib/publicRelayUrl');

// Minimal server-side error visibility (R5): an uncaught exception or
// unhandled rejection previously just printed Node's default (sometimes
// truncated) trace and, for an exception, left the process running in an
// undefined state. Logging explicitly first, then exiting deliberately for
// an actual exception, means Fly's process supervisor restarts a clean
// process instead of one that silently kept serving requests in a broken
// state. A rejection alone isn't fatal the same way, so it's logged but
// doesn't exit.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').split(',').filter(Boolean);

// Fly (and most PaaS hosts) terminate HTTPS at their edge and forward
// plain HTTP internally, setting X-Forwarded-Proto/X-Forwarded-Host to
// tell us the original scheme/host. Needed for the redirect below to see
// the actual hostname the client used, not the proxy's own. (req.ip used
// to also depend on this for a "same network" pairing hint, but that was
// removed -- Fly's own proxy chain meant req.ip resolved to Fly's internal
// address, not the real client, making the hint unreliable regardless of
// this setting.)
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: CORS_ORIGIN.length ? CORS_ORIGIN : true,
  })
);

// Anyone still landing directly on a non-canonical hostname -- the raw
// fly.dev address, an old bookmark, an old installed PWA's start_url, a
// stale doc link -- gets bounced to PUBLIC_RELAY_URL instead of staying
// there or breaking. Only installed when PUBLIC_RELAY_URL is actually
// configured (production); local dev/tests never set it, so this never
// runs there. Scoped to page navigations only, matching the same API path
// prefixes the catch-all further down excludes -- an already-loaded
// page's own fetch()/EventSource calls must never be redirected, since a
// 301 on a POST silently drops its body and would break pairing/sending
// for anyone still pointed at the old host, and /health must always
// answer directly or Fly's own health check would see it as down.
if (process.env.PUBLIC_RELAY_URL) {
  const canonicalHost = new URL(PUBLIC_RELAY_URL).hostname;
  app.use((req, res, next) => {
    if (req.hostname !== canonicalHost && !/^\/(inbox|pair|items|events|health|signal|client-error)/.test(req.path)) {
      return res.redirect(301, `${PUBLIC_RELAY_URL}${req.originalUrl}`);
    }
    next();
  });
}
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

// /signal's own rate limiter lives in routes/signal.js — sized for how
// bursty ICE candidate exchange actually is, not shared with /items.
app.use('/signal', signalRoutes);

// Minimal client-side error visibility (R5) -- its own rate limiter lives
// in routes/clientError.js.
app.use('/client-error', clientErrorRoutes);

// Exposes the deployed version so the web client can show it and so anyone
// checking "is my deploy actually live" has a real answer instead of guessing.
app.get('/health', (req, res) => res.json({ ok: true, version: APP_VERSION }));

// Installer downloads and the desktop app's update feed are both served
// from beamlot.com so the binary host is an implementation detail rather
// than something baked into the marketing site and every installed client.
// RELEASE_ORIGIN points at wherever the artifacts actually sit; changing
// hosts is then a fly secret, not a rebuild of every client that already
// has the old URL compiled in.
//
// These must be registered before the static/catch-all block below, which
// would otherwise answer /download with the SPA's index.html.
const RELEASE_ORIGIN =
  process.env.RELEASE_ORIGIN || 'https://github.com/Haaks06/beam/releases/latest/download';

app.get('/download/windows', (req, res) => {
  res.redirect(302, `${RELEASE_ORIGIN}/Beam-Setup-Windows.exe`);
});

// electron-updater's generic provider fetches latest.yml here, then the
// .exe/.blockmap named inside it, so every artifact it asks for has to
// resolve under this same prefix.
app.get('/updates/:asset', (req, res, next) => {
  if (!/^[A-Za-z0-9._-]+$/.test(req.params.asset)) return next();
  res.redirect(302, `${RELEASE_ORIGIN}/${req.params.asset}`);
});

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
  // The iPhone Shortcuts setup guide. Needs naming explicitly for the same
  // reason as '/' — the catch-all below would otherwise answer it with the
  // pairing app.
  app.get('/ios', (req, res) => res.sendFile(path.join(webClientDist, 'ios.html')));
  // Everything else non-API — /app itself, and pairing-code links like
  // /ABC123 (see relay-server/routes/pair.js's pairingUrl) — is the actual
  // app. web-client's own client-side routing (see parsePairingLink() in
  // src/app.js) figures out from the path which of those it is.
  app.get(/^(?!\/(inbox|pair|items|events|health|signal|client-error)).*/, (req, res) => {
    res.sendFile(path.join(webClientDist, 'index.html'));
  });
}

// Multer/body-parser errors land here (bad file type, payload too large, etc).
// Previously never logged at all -- any error on this path was completely
// silent server-side, indistinguishable in the logs from normal traffic
// regardless of whether it was routine input validation or an actual bug.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || 400;
  console.error(`[error] ${req.method} ${req.path} -> ${status}:`, err.message);
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
