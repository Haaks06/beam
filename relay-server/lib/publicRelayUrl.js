// The one source of truth for "what URL should a human-facing link (a QR
// code, a pairing link, a redirect target) use" -- see routes/pair.js's
// pairing URL and index.js's fly.dev redirect. Deliberately never derived
// from req.protocol/req.get('host'): building it from the incoming
// request used to bake whatever hostname a client happened to hit
// (including the raw fly.dev address) into the QR code. Set via
// PUBLIC_RELAY_URL in production (see fly.toml); the localhost fallback
// only exists so local dev/tests don't need it set, and is a hardcoded,
// obviously-local value, never derived from a request, so it can't leak a
// real hostname the way the old code did.
const PUBLIC_RELAY_URL = process.env.PUBLIC_RELAY_URL || 'http://localhost:3000';

module.exports = { PUBLIC_RELAY_URL };
