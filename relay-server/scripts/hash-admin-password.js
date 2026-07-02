#!/usr/bin/env node
// One-time local use: generates the ADMIN_PASSWORD_HASH value to set via
// `fly secrets set` — never commit the actual password or this output to
// git. Run: node scripts/hash-admin-password.js '<your password>'
const crypto = require('node:crypto');

const password = process.argv[2];
if (!password) {
  console.error("Usage: node scripts/hash-admin-password.js '<password>'");
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 64);
console.log(`${salt.toString('hex')}:${hash.toString('hex')}`);
