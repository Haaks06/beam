# Beam

Beam a link or photo from your phone (iOS/Android) or any browser and have
it land automatically on your Windows PC — over the internet, not just your
home Wi-Fi.

## How it works

- **`relay-server/`** — a small Express + SQLite server that accepts
  links/photos from paired devices and pushes them to your PC in real time
  over Server-Sent Events (SSE).
- **`desktop-app/`** — "Beam", an Electron tray app that stays connected
  to the relay, saves incoming links/photos to local folders, and shows a
  notification. On first launch it opens a welcome window that explains
  what's happening and gets your phone paired immediately, rather than
  silently disappearing into the tray.
- **`web-client/`** — an installable PWA. On Android it registers as a
  native Share Sheet target ("Beam" shows up alongside AirDrop-style
  options). It also has a plain page for pairing and manually
  pasting/uploading from any browser (covers desktop-to-desktop sharing).
- **`ios-shortcut/`** — since iOS doesn't support PWA share targets, one
  Apple Shortcut ("Beam to PC", branching on link vs. photo) fills the
  same role. See [`ios-shortcut/README.md`](ios-shortcut/README.md).

One relay can be shared by many independent people: each person's devices
belong to their own private **inbox**, created automatically the first time
their desktop app runs (`POST /inbox`). Adding a second device to your own
inbox (e.g. your phone) works by scanning a QR / entering a short-lived
6-character pairing code shown by the desktop app. Every device is
authenticated with a long random token scoped to its inbox — still no
accounts or passwords. See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)
for what this does and doesn't protect against.

## Requirements

- [Node.js](https://nodejs.org) 20+ (this machine doesn't have it installed
  yet — install it before running anything below).
- For the desktop app: Windows (tested target), though Electron itself is
  cross-platform.
- For local internet-facing testing before real deployment:
  [ngrok](https://ngrok.com) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

## Setup

```bash
npm install          # installs all three workspaces
cp .env.example relay-server/.env   # then edit relay-server/.env if needed
```

### Upgrading from before multi-tenancy

If you have a local `relay-server/data/relay.sqlite` from before the
`inboxes` table was added, delete it — the schema change isn't
migration-safe (`CREATE TABLE IF NOT EXISTS` silently no-ops against the
old schema and every query will fail at runtime). A fresh empty database
will be recreated automatically on next start.

## Running locally

```bash
npm run dev:relay     # starts the relay on http://localhost:3000
npm run test:relay    # runs the relay's automated tests

npm run dev:desktop   # launches the Electron tray app (talks to localhost:3000 by default)

npm run dev:web       # starts the PWA dev server (Vite) for the manual-share page
```

## Manual end-to-end verification (do this before touching real devices)

1. `npm run dev:relay`, confirm `curl http://localhost:3000/health` returns `{"ok":true}`.
2. `curl -X POST http://localhost:3000/inbox -H 'Content-Type: application/json' -d '{"label":"test"}'` → note `token` (this both creates a new inbox and mints its first device token in one call).
3. Optional — add a second device to the same inbox: `curl -X POST http://localhost:3000/pair/init -H "Authorization: Bearer <token>"` → note `pairingCode`, then `curl -X POST http://localhost:3000/pair/claim -H 'Content-Type: application/json' -d '{"pairingCode":"<code>","label":"second device"}'` → note the second `token`.
4. In one terminal: `curl -N "http://localhost:3000/events?token=<token>"` to watch the live stream.
5. In another terminal: `curl -X POST http://localhost:3000/items/link -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'` — it should appear instantly in the SSE stream.
6. `curl -X POST http://localhost:3000/items/photo -H "Authorization: Bearer <token>" -F "file=@some.jpg"` then `curl -H "Authorization: Bearer <token>" http://localhost:3000/items/<id>/file -o out.jpg` to confirm round-trip.
7. `npm run dev:desktop` — repeat steps 5–6 and confirm the tray app shows a Windows notification and saves the item to `Documents\ShareToPC\links.jsonl` / `Pictures\ShareToPC\`.
8. Run `ngrok http 3000`, update the desktop app's stored `relayUrl` (delete its config file to force re-pairing against the new URL, or edit it directly — see `desktop-app/store.js` for the config path), and from a real Android phone install the PWA over the ngrok HTTPS URL, pair via the manual page, then share a real link/photo from Chrome/Photos and confirm it reaches the desktop app — including with Wi-Fi off (cellular only), to prove this isn't LAN-limited.
9. Repeat against the iOS Shortcuts (see `ios-shortcut/README.md`) using the same ngrok URL.
10. Only after all of the above pass, deploy to Render (below) and re-pair everything against the production URL.

## Deployment: Render (recommended, free tier, easiest)

The fastest way to get a real, shareable HTTPS URL — no server to manage,
no port-forwarding on your home router. Full instructions, including an
important warning about Render's free-tier disk being ephemeral, are in
[`docs/HOSTING.md`](docs/HOSTING.md). Short version: push this repo to
GitHub, create a Render Blueprint pointed at it, and Render reads
[`render.yaml`](render.yaml) automatically.

## Deployment: self-hosted (persistent, more setup)

If you need your paired devices and item history to durably survive
restarts/redeploys (Render's free tier doesn't guarantee that — see
`docs/HOSTING.md`), self-host instead: a Raspberry Pi, home server, or a
cheap VPS you control, with [Caddy](https://caddyserver.com/) in front for
automatic HTTPS (required — pairing tokens must never travel over plain
HTTP).

1. Copy `relay-server/` to the box, `npm install --omit=dev`, set up
   `relay-server/.env` (`PORT`, `DB_PATH`, `UPLOAD_DIR`, `CORS_ORIGIN` set to
   your web client's real origin).
2. Run it under `systemd` so it survives reboots:
   ```ini
   # /etc/systemd/system/share-to-pc.service
   [Unit]
   Description=Share to PC relay
   After=network.target

   [Service]
   WorkingDirectory=/opt/share-to-pc/relay-server
   ExecStart=/usr/bin/node index.js
   Restart=on-failure
   EnvironmentFile=/opt/share-to-pc/relay-server/.env

   [Install]
   WantedBy=multi-user.target
   ```
   Then `systemctl enable --now share-to-pc`.
3. Point Caddy at it for HTTPS termination:
   ```
   your-domain.example.com {
     reverse_proxy localhost:3000
   }
   ```
4. Build the web client to keep one deployable + one cert:
   ```bash
   npm run build:web
   ```
   `relay-server/index.js` already serves `web-client/dist` as static files
   when present, so no further wiring is needed — just make sure the build
   step above runs before `systemctl start`.
5. Package the desktop app for distribution with `electron-builder`
   (`npm run build -w desktop-app`) once you're happy with it; point its
   default `relayUrl` at your real domain.

## Security notes (short version)

- Pairing codes are short-lived (10 min) and single-use; tokens are 32
  random bytes, never guessable.
- Uploaded files are restricted by MIME type and size, and stored under
  server-generated filenames (never the client-supplied name) to avoid path
  traversal.
- The `/events` SSE endpoint takes its token as a query parameter (browsers'
  `EventSource` can't set custom headers) — documented tradeoff, mitigated
  by requiring HTTPS in deployment.
- One relay can serve many people: every device, item, and pairing code
  belongs to a specific inbox (`POST /inbox` creates one), and isolation is
  enforced between inboxes. Within one inbox, the trust model is unchanged
  from the original single-user design: any valid token for that inbox can
  read any item in it. See `docs/THREAT_MODEL.md` for the full picture.
