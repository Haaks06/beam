# Microsoft Store listing content

Ready to paste into Partner Center's Store listing page once the app is
submitted. See [`../STORE.md`](../STORE.md) for the packaging/submission
checklist this depends on.

## Screenshots — still needed, not included here

Partner Center requires at least one PNG screenshot, 1366×768 or larger (up
to 4K). Not generated as part of this pass — attempts to capture the app
window programmatically on this machine twice caught unrelated content
instead (another running window, not Beam), so this was deliberately left
as a real manual step rather than shipped wrong. To capture it yourself:
open Beam, use `Win+Shift+S` (Snipping Tool) to select just the app window,
save as PNG. 4–5 screenshots showing pairing, sending, and receiving would
tell the fuller story, but even one is enough to submit.

## App name

Beam

## Short description / subtitle (for search results, ~100 char limit)

Instantly send links and photos from your phone to your PC. No accounts, no history.

## Description (full listing body)

Beam moves a link, photo, file, or voice memo from your phone to your PC —
or between any two devices — in seconds, over the real internet, not just
your home Wi-Fi.

**How it works:** open Beam on both devices, scan a QR code or type a short
pairing code, and you're connected. You get a short timed window (5 minutes
by default, adjustable from 2–15 minutes in Settings) to send whatever you
need. When the window closes, everything is wiped automatically on both
devices and on the relay server in between — no accounts, no login, and
nothing is kept around afterward.

**Why it's different from just emailing yourself a link:**
- No account to create, no sign-in, nothing to remember.
- Pairing is exactly two devices at a time — nobody else can join.
- Transfers go directly device-to-device when possible; when a direct
  connection isn't available, content is still encrypted before it passes
  through the relay server, so the relay itself can't read what you send.
- Nothing persists after the session ends. Beam isn't a place to store or
  browse a history of things you've sent — it's a one-time handoff.

**What you can send:** links and plain text, photos, small files (PDF, Word
docs, ZIP), and voice memos.

**Also available:** a free web app at beamlot.com (works on any phone or
browser, no install needed) and an Android Share Sheet integration. This
Windows app adds a system tray icon, background listening so you don't have
to keep a browser tab open, Windows notifications when something arrives,
and a clipboard quick-send.

## Release notes (this version)

Initial Microsoft Store release.

## Category

Productivity

## Search terms / keywords

file transfer, send to pc, airdrop for windows, phone to pc, quick share, clipboard sync, cross device transfer

## Privacy policy URL

https://www.beamlot.com/privacy (CHANGEME — confirm this page exists and is
current before submission; Partner Center requires a working privacy policy
URL for every submission, even for an app that stores nothing persistently).

## Support contact

CHANGEME — Partner Center requires a support email or website URL.

## Age rating

Should qualify for the lowest/broadest rating tier (no objectionable
content, no user-generated content shared publicly, no ads, no in-app
purchases) — confirm by completing Partner Center's age rating
questionnaire directly, don't assume.

## Notes on claims made above

Deliberately worded to match this repo's own precision about encryption
(see `docs/THREAT_MODEL.md`): "encrypted before it passes through the relay"
is accurate and defensible without saying "end-to-end encrypted" outright,
since the ECDH key exchange itself still passes through the relay
unauthenticated (protects against a passive relay, not a fully trustless
scheme). Do not strengthen this wording during submission without re-reading
that doc first.
