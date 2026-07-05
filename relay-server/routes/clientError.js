const express = require('express');
const rateLimit = require('express-rate-limit');
const rateLimitHandler = require('../lib/rateLimitHandler');

const router = express.Router();

// Generous but real -- a genuinely broken page could throw repeatedly
// (e.g. an error inside a render loop), and reporting that must never
// itself become a way to spam the server or flood its own logs unbounded.
const clientErrorLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, handler: rateLimitHandler });

// POST /client-error -- minimal client-side error visibility (R5 of the
// Fable release-readiness audit: "find out about the next B1-style bug
// before users report it"). Unauthenticated on purpose: the whole point
// is catching errors that happen before/during pairing too, not only once
// a token exists. This is a logging sink, not a real API -- never trusts
// the body beyond a few string fields, each hard-truncated, so it can't
// become a way to inject something huge or dangerous into the server's
// own logs. Logs to stdout/stderr like everything else here, which Fly
// already captures and makes available via `fly logs` with zero extra
// setup -- swapping this for a real error-tracking service (Sentry etc.)
// later is a valid upgrade, just not needed for "know when something
// broke" at this scale.
router.post('/', clientErrorLimiter, (req, res) => {
  const { message, stack, url, userAgent } = req.body || {};
  const truncate = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  console.error(
    '[client-error]',
    JSON.stringify({
      message: truncate(message, 500),
      stack: truncate(stack, 2000),
      url: truncate(url, 300),
      userAgent: truncate(userAgent, 300),
      at: new Date().toISOString(),
    })
  );
  res.status(204).end();
});

module.exports = router;
