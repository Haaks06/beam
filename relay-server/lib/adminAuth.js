const crypto = require('node:crypto');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || ''; // "saltHex:hashHex"
const SESSION_SECRET = process.env.SESSION_SECRET || '';
// No refresh/sliding expiry, no revocation list — re-login required once
// this expires. Simple beats stateful for a single admin credential.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'beam_admin_session';

// crypto.timingSafeEqual throws RangeError on length mismatch, which is the
// COMMON case for a wrong guess — comparing raw variable-length input
// directly would mean ordinary wrong-password attempts throw uncaught
// exceptions. Hash both sides to a fixed-length digest first.
function fixedLengthEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db_ = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db_);
}

// Fails CLOSED (rejects all logins) if not configured, rather than silently
// falling back to some default credential — this relay is live on the
// public internet.
function verifyCredentials(username, password) {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD_HASH || !SESSION_SECRET) return false;
  if (typeof username !== 'string' || typeof password !== 'string') return false;
  if (!fixedLengthEqual(username, ADMIN_USERNAME)) return false;

  const [saltHex, hashHex] = ADMIN_PASSWORD_HASH.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const candidate = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(candidate, expected);
}

// Stateless session: no JSON, no jsonwebtoken dependency — just
// "expiry.signature", verified by recomputing the HMAC.
function issueSessionToken() {
  const expiry = Date.now() + SESSION_TTL_MS;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(String(expiry)).digest('hex');
  return `${expiry}.${sig}`;
}

function verifySessionToken(token) {
  if (!SESSION_SECRET || typeof token !== 'string') return false;
  const [expiryStr, sig] = token.split('.');
  if (!expiryStr || !sig) return false;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;

  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(expiryStr).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseCookie(header, name) {
  if (!header) return null;
  const match = header
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function requireAdmin(req, res, next) {
  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  if (!verifySessionToken(token)) {
    return res.status(401).json({ error: 'admin login required' });
  }
  next();
}

module.exports = { verifyCredentials, issueSessionToken, verifySessionToken, requireAdmin, parseCookie, COOKIE_NAME };
