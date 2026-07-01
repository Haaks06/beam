# Threat model

One relay can be shared by many independent people: each person's devices
belong to their own **inbox** (`inboxes` table, `inbox_id` on every device,
item, and pairing code), and isolation is *between* inboxes, not within one.
There are still no accounts, passwords, or logins — creating an inbox
(`POST /inbox`) is how a new person gets started, and everything from then
on works exactly like the original single-user design, just scoped. Within
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

## What is explicitly out of scope

- **A stolen/leaked token.** Any device holding a valid token can read or
  write to that token's entire inbox (but no other inbox) — there's no
  per-device read scoping within an inbox. If your phone is lost or a token
  leaks, the mitigation is deleting that device's row from `devices` in the
  relay's SQLite database (or wiping your inbox's rows and re-pairing
  everything), not a live revoke endpoint.
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

## Why this is an acceptable tradeoff here

The alternative — full user accounts with passwords/logins, per-device
ACLs, token revocation endpoints — is real engineering effort that doesn't
serve the actual use case: each person moving links and photos to their own
computer, possibly on a relay someone else is hosting for them. Adding an
`inbox_id` boundary gets genuine multi-person isolation without any of
that: creating an inbox is just "run the app for the first time," and the
pairing-code flow for adding a second device is unchanged. This stays
simple enough to explain and reason about, which matters both for a class
project and for software you have to maintain yourself.
