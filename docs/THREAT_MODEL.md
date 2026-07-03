# Threat model

A pairing ("inbox" in the code/DB — `inboxes` table, `inbox_id` on every
device, item, and pairing code) is exactly two devices and lives for a
fixed, short window: it starts with one device (`POST /inbox`), and the
moment a second device claims a pairing code (`POST /pair/claim`), a
2-minute clock starts. `lib/sessionCleanup.js` sweeps every few seconds for
pairings whose clock has run out and deletes their devices, items, and
uploaded files — after that, both devices' tokens simply 401, since the
`devices` rows backing them are gone. The security goal is narrow: **prevent
random internet users from pushing items into a pairing or reading its
items, and keep each pairing capped at the two devices that formed it**, not
to defend against a sophisticated attacker who already possesses a valid
token for that specific, currently-live pairing.

## What pairing tokens protect against

- Random internet users discovering the relay's URL (e.g. via port
  scanning) and posting arbitrary links/photos into a pairing that isn't
  theirs.
- Random internet users reading photos shared in a pairing they're not part
  of, since `/items/*` and `/events` require a valid token.
- **Cross-pairing access**: a valid token for pairing A cannot read pairing
  B's items, download pairing B's photos (`GET /items/:id/file` checks
  `inbox_id`, not just the item id), or mint a pairing code that joins
  pairing B (`POST /pair/init` scopes the generated code to the caller's
  own `inbox_id`).
- **A third device joining.** `POST /pair/init` refuses to mint a code (409)
  once a pairing already has two devices, and `POST /pair/claim` re-checks
  the same count immediately before inserting the device — closing the race
  where two claims land on the same code near-simultaneously.
- Brute-forcing a pairing code: codes are short-lived (10 minutes),
  single-use, drawn from a 33-character alphabet at length 6 (~33^6 ≈ 1.3
  billion combinations), and `/pair/*` is rate-limited.
- Mass inbox creation: `POST /inbox` is unauthenticated by necessity (it's
  how you get your first token), so it has its own rate limit (default 200
  per 10-minute window per IP) separate from `/pair/*`, since it's the one
  remaining fully open endpoint on a shared relay. `/pair/*` itself splits
  the read-only status-polling route (generous, since a normal connect
  screen polls it every 2 seconds) from the actual pairing mutations
  (tighter), so two different concerns never share one bucket.
- **A token outliving its usefulness.** Every pairing self-destructs 2
  minutes after both devices join, and any pairing nobody ever finishes
  pairing is swept after 10 minutes too (same TTL as its pairing code) — a
  captured token is only ever a short-lived liability, not a standing one.

## What is explicitly out of scope

- **A stolen/leaked token, used within its pairing's live window.** Any
  device holding a valid token can read or write everything in that
  pairing until it expires — there's no per-device read scoping within a
  pairing (this is what lets a phone and PC freely exchange items with each
  other during their session). There is no revoke endpoint; the mitigation
  is that every pairing is short-lived by design, so the exposure window is
  at most 2 minutes (plus whatever unpaired time preceded it, capped at 10
  minutes).
- **Network-level attackers without HTTPS.** Tokens travel in the
  `Authorization` header (or, for the SSE endpoint, a query parameter) — if
  the relay is ever exposed over plain HTTP, anyone on the network path can
  capture a token. HTTPS via the reverse proxy (Caddy/nginx) is a hard
  requirement in any real deployment, not optional hardening.
- **A compromised relay host.** If the box running the relay is
  compromised, all tokens and stored items are exposed for as long as they
  live — bounded by the same 2-minute/10-minute windows above, but real
  exposure while it lasts. This is the same trust boundary as any
  self-hosted personal server.
- **Malicious file content, for plain (non-encrypted) uploads.** Uploads
  are restricted to a small image MIME allowlist, never executed or
  interpreted server-side, and the actual bytes are checked against each
  allowed format's real magic number after upload (`lib/sniffImageType.js`)
  — a file whose content doesn't match any allowed image format is
  rejected and deleted regardless of what `Content-Type` it claimed. This
  still isn't full content validation (no image re-encoding, no scan for
  malformed/exploit-crafted-but-technically-valid image data) — acceptable
  for what this protects against (arbitrary non-image files masquerading
  as images), not a substitute for antivirus scanning if that threat model
  ever applies.

  **This guarantee does not apply when `encrypted: true` is set** (see
  Phase 2a's P2P-with-encrypted-relay-fallback). An AES-GCM-encrypted
  photo's bytes are ciphertext, not image data — magic-byte sniffing is
  skipped entirely for these uploads, deliberately, since ciphertext will
  never match a real image's magic number regardless of what the original
  photo actually was. The relay cannot verify an encrypted upload's
  content at all: type, size within `MAX_UPLOAD_BYTES` (still enforced),
  and nothing else. This is an accepted, intentional narrowing of the
  above protection in exchange for the relay genuinely being unable to
  read the payload — not an oversight, but a real tradeoff worth being
  explicit about if this threat model is ever revisited.
