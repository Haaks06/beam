const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// Async, not scryptSync — sync scrypt blocks Node's ENTIRE event loop
// (~26ms measured), which is fine for a single rarely-used admin login but
// not once real accounts mean login/signup happen constantly: a modest
// distributed credential-stuffing attempt could stall every other request
// (SSE streams, item posts) well before per-IP rate limiting engages.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof password !== 'string') return false;
  const [saltHex, hashHex] = storedHash.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length === 0) return false;
  const candidate = await scrypt(password, salt, expected.length);
  return crypto.timingSafeEqual(candidate, expected);
}

// Fixed, precomputed (not generated at runtime) — used by login handlers so
// a username-lookup MISS costs the same as a wrong-password HIT. Without
// this, "no such user" returns almost instantly while "wrong password"
// takes a full scrypt verify, a clear timing oracle for enumerating valid
// usernames. The actual password behind this hash is never used for
// anything real; only its cost matters.
const DUMMY_HASH =
  '0d8aa8cdf984712425b2019783d8bcdc:54dfe7bf18779b10ff6679dbad98440aea898aa84df54b728264bf34251ae557f61f0cda7171c5c15c384035d33cab7273224b4020afdf59007abf32c28a3e73';

module.exports = { hashPassword, verifyPassword, DUMMY_HASH };
