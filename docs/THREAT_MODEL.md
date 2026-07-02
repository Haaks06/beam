# Threat model

One relay can be shared by many independent people: each person's devices
belong to their own **inbox** (`inboxes` table, `inbox_id` on every device,
item, and pairing code), and isolation is *between* inboxes, not within one.
Accounts (real username/password, see the "Accounts" section below) are
optional — creating an anonymous inbox (`POST /inbox`) still works exactly
like the original single-user design with no signup required, and
everything else in this document applies equally to both. Within
one inbox, the trust model is unchanged from before: any device holding a
valid token for that inbox can read/write everything in it — there is still
no per-device read scoping *within* an inbox, by design (this is what lets
a household share one inbox across a phone, a laptop, etc.). The security
goal is narrow: **prevent random internet users, and prevent people in
other inboxes, from pushing items into your inbox or reading your items**,
not to defend against a sophisticated attacker who already possesses a
valid token for your inbox specifically.

## What pairing tokens (now inbox-scoped) protect against

- Random internet users discovering the relay's URL (e.g. via port
  scanning) and posting arbitrary links/photos to anyone's inbox.
- Random internet users reading photos anyone has shared, since `/items/*`
  and `/events` require a valid token.
- **Cross-inbox access**: a valid token for inbox A cannot read inbox B's
  items, download inbox B's photos (`GET /items/:id/file` checks
  `inbox_id`, not just the item id), or mint a pairing code that joins
  inbox B (`POST /pair/init` scopes the generated code to the caller's own
  `inbox_id`).
- Brute-forcing a pairing code: codes are short-lived (10 minutes),
  single-use, drawn from a 33-character alphabet at length 6 (~33^6 ≈ 1.3
  billion combinations), and `/pair/*` is rate-limited.
- Mass inbox creation: `POST /inbox` is unauthenticated by necessity (it's
  how you get your first token), so it has its own stricter rate limit
  (default 5/hour/IP) separate from `/pair/*`, since it's the one remaining
  fully open endpoint on a shared relay.

## Friend connections (a second, parallel trust boundary)

Everything above describes pairing: joining *your own* inbox as another
full-access device. Connections (`connections`/`connect_codes` tables,
`/connect/*` and `/connections/*` routes) are different — they let two
*different* people's inboxes exchange items without merging them, and
critically, **claiming a connect code never grants access on its own**.
Claiming only creates a `pending` row; the code's owner (`target_inbox_id`)
must separately call `POST /connections/:id/accept` before either side can
send anything through it. A sent item (`POST /items/link|photo` with a `to`
= connection id) lands only in the recipient's inbox (`items.inbox_id`) —
the sender's own backlog never sees it, matching what an "accept before
anything is shared" model should feel like.

Two things enforced on every `/connections/:id/*` request, worth stating
explicitly since they're easy to regress: (1) only the row's
`target_inbox_id` may accept/reject — the requester cannot accept their own
request; (2) a caller who isn't a party to a connection gets the exact same
generic 404 as a nonexistent connection id, so connection ids can't be
enumerated to discover who's connected to whom. `GET /connections` and the
`to` parameter on sends only ever expose a connection's own `id` and a
derived `otherLabel`/`isOwnDevice` — raw numeric inbox ids never reach a
client.

**Out of scope for connections, same as pairing above:** a party's own
device/token being stolen still grants everything that device could already
do (read the connection, send through it) — there's no additional
per-connection secret beyond the underlying device token. `requester_label`/
`target_label` are self-reported free text (same trust level as
`source_label` throughout this app already) — good enough for "which of my
friends is this," not a verified identity.

## Admin auth

A single, env-var-configured credential (`ADMIN_USERNAME`/
`ADMIN_PASSWORD_HASH`/`SESSION_SECRET`) gated behind real login — not a
bypass. Fails **closed**: if any of the three env vars are unset, admin
login rejects every attempt rather than falling back to a default. Sessions
are a stateless signed token (`expiry.hmac`, no JWT library, no session
store) in an `httpOnly; Secure; SameSite=Strict` cookie; there's no
revocation list, so logout only discards the client's copy — the token
itself stays valid until its ~24h expiry. `/admin/login` has its own much
stricter rate limit (5/15min/IP) than any other route in this app, since a
single static credential is exactly the kind of thing online brute force
targets. v1 admin routes are deliberately **read-only** (list inboxes,
list connections) — no destructive actions exist yet, smallest reasonable
surface for a relay that's live on the public internet with a public repo.

## Accounts (real username/password, optional)

An account is not a parallel system — it's just another way to obtain a
device token, alongside `POST /inbox` (anonymous) and `/pair/claim` (join
an existing inbox via code). `POST /auth/signup` creates an inbox +
account + device token together, so every existing route keeps working
completely unchanged: they all key off `req.device.inbox_id` regardless of
how the token was obtained. `POST /auth/login` mints a *new* device token
tied to the account's existing inbox, reusing the same multi-device-per-
inbox model pairing already supports — it does not touch or return any
previously-issued token.

- **Password storage**: scrypt via `lib/passwordHash.js`, salted, async
  (not `scryptSync` — sync scrypt blocks Node's entire event loop for the
  duration of the hash, which would let login/signup traffic stall every
  other in-flight request; async offloads it to libuv's threadpool).
- **Timing-safe login**: a username lookup **miss** still runs a full
  `verifyPassword` against a fixed dummy hash before returning 401, so it
  costs the same as a **wrong password** on a real account — without this,
  the response-time difference is a trivial oracle for enumerating which
  usernames exist.
- **Race-safe signup**: the async hash means a uniqueness pre-check can't
  be the authority (two concurrent signups for the same username could
  both pass it) — the `accounts.username` `UNIQUE` constraint at insert
  time is what actually decides; a collision there is caught and mapped to
  a clean `409`, not a crash. Covered by a dedicated concurrency test
  (`test/auth.test.js`).
- **No email, no password reset, by design** (the ask was specifically
  "just a username and a password"). This means a leaked/reused password
  is otherwise a **permanent, invisible, unrevokable** backdoor to that
  inbox — which is exactly why `GET /auth/devices` + `DELETE
  /auth/devices/:id` exist as a v1 requirement, not a fast-follow: they're
  the only recovery path. A soft cap (20 devices/inbox) on login also stops
  a compromised credential from silently minting unlimited devices before
  anyone notices.
- **Display name, not raw labels, for connections**: `accounts.display_name`
  (a random "adjective noun" assigned once at signup, not user-editable in
  v1) overrides whatever self-reported label was supplied when a friend
  connection was formed — resolved at *read time* in
  `routes/connections.js`'s `serialize()`, not baked in at write time, so
  it self-heals (an account created after a connection already exists
  still shows the real name on it, no backfill needed).

## What is explicitly out of scope

- **A stolen/leaked token.** Any device holding a valid token can read or
  write to that token's entire inbox (but no other inbox) — there's no
  per-device read scoping within an inbox. For an account-linked inbox,
  `DELETE /auth/devices/:id` (see "Accounts" above) is now a real, live
  revoke path — no direct database access needed. For a still-anonymous
  inbox, the mitigation remains manual: deleting that device's row from
  `devices` directly, or wiping the inbox's rows and re-pairing everything.
- **Network-level attackers without HTTPS.** Tokens travel in the
  `Authorization` header (or, for the SSE endpoint, a query parameter) — if
  the relay is ever exposed over plain HTTP, anyone on the network path can
  capture a token. HTTPS via the reverse proxy (Caddy/nginx) is a hard
  requirement in any real deployment, not optional hardening.
- **A compromised relay host.** If the box running the relay is
  compromised, all tokens and stored items are exposed. This is the same
  trust boundary as any self-hosted personal server.
- **Malicious file content.** Uploads are restricted to a small image MIME
  allowlist and never executed or interpreted server-side, but this project
  does not deeply validate file contents beyond mimetype/extension (e.g. no
  magic-byte sniffing). Acceptable for a personal, single-user tool; would
  need hardening (e.g. the `file-type` package, image re-encoding) before
  ever accepting uploads from untrusted parties.

## Why anonymous inboxes still exist alongside accounts

Real accounts (above) exist for anyone who wants a persistent, revocable,
login-based identity. But requiring one for everyone would be real friction
that doesn't serve every use case here: someone just moving a link from
their own phone to their own PC, possibly on a relay someone else is
hosting for them, doesn't need a password to protect. `inbox_id` isolation
alone already gets genuine multi-person separation without any of that:
creating an inbox is still just "run the app for the first time," and the
pairing-code flow for adding a second device is unchanged. Both models are
first-class and coexist deliberately, rather than accounts replacing the
anonymous flow.
