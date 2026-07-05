// A pairing's session length is chosen by the initiating device (see
// routes/inbox.js) and applied when the second device claims (routes/pair.js).
// Bounded server-side regardless of what a client sends: an unbounded value
// would let one pairing hold relay resources (rows, uploaded files) far
// longer than the ephemeral-by-design threat model assumes.
const MIN_SESSION_DURATION_MS = 2 * 60 * 1000;
const MAX_SESSION_DURATION_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_DURATION_MS = 5 * 60 * 1000;

function clampSessionDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_SESSION_DURATION_MS;
  return Math.min(MAX_SESSION_DURATION_MS, Math.max(MIN_SESSION_DURATION_MS, ms));
}

module.exports = { MIN_SESSION_DURATION_MS, MAX_SESSION_DURATION_MS, DEFAULT_SESSION_DURATION_MS, clampSessionDuration };
