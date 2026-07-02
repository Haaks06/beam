#!/usr/bin/env node
// One-time local use: generates the ADMIN_PASSWORD_HASH value to set via
// `fly secrets set` — never commit the actual password or this output to
// git. Run: node scripts/hash-admin-password.js '<your password>'
const { hashPassword } = require('../lib/passwordHash');

const password = process.argv[2];
if (!password) {
  console.error("Usage: node scripts/hash-admin-password.js '<password>'");
  process.exit(1);
}

hashPassword(password).then((hash) => console.log(hash));
