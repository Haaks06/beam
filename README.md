# Beam

Beam a link or photo from your phone (iOS/Android) or any browser and have
it land on your Windows PC in real time — over the internet, not just your
home Wi-Fi. Pairing is exactly two devices at a time, and a pairing only
lasts 2 minutes: once your phone and PC are paired, you get a 2-minute
window to send/receive, then the relay forgets everything it was holding
(items + uploaded files) and both devices need to re-pair for another go.

## How it works

- **`relay-server/`** — a small Express + SQLite server that accepts
  links/photos from one paired device and pushes them to the other in real
  time over Server-Sent Events (SSE). Every pairing ("inbox") is capped at
  two devices, and once both are present a 2-minute clock starts; when it
  runs out, `lib/sessionCleanup.js` deletes that pairing's devices, items,
  and uploaded files.
- **`desktop-app/`** — "Beam", an Electron tray app whose window simply
  loads the relay's own web page (see below) — it's the exact same UI a
  phone gets, plus a small native bridge that saves anything received to
  `Documents/Beam` / `Pictures/Beam` and shows a Windows notification.
- **`web-client/`** — an installable PWA, and the one UI both phone and PC
  use. It walks through: start a pairing (shows a QR/code) → wait for the
  other device → once paired, a countdown plus two options, **Send** and
  **Receive** → once the countdown ends, back to the start. On Android it
  also registers as a native Share Sheet target ("Beam" shows up alongside
  AirDrop-style options).
- **`ios-shortcut/`** — since iOS doesn't support PWA share targets, one
  Apple Shortcut ("Beam to PC") fills the same role. See
  [`ios-shortcut/README.md`](ios-shortcut/README.md) — note the 2-minute
  session limit affects this flow more than the others, since a shortcut's
  token stops working the moment its pairing expires.

Every device is authenticated with a long random token scoped to its
pairing. See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) for what this
does and doesn't protect against.

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

## Running locally

```bash
npm run dev:relay     # starts the relay on http://localhost:3000
npm run test:relay    # runs the relay's automated tests

npm run dev:desktop   # launches the Electron tray app (talks to localhost:3000 by default)

npm run dev:web       # starts the PWA dev server (Vite) for the manual-share page
```

## Manual end-to-end verification (do this before touching real devices)

1. `npm run dev:relay`, confirm `curl http://localhost:3000/health` returns `{"ok":true}`.
2. `curl -X POST http://localhost:3000/inbox -H 'Content-Type: application/json' -d '{"label":"test"}'` → note `token` and `inboxId` (this both starts a new pairing and mints its first device token).
3. Pair a second device: `curl -X POST http://localhost:3000/pair/init -H "Authorization: Bearer <token>"` → note `pairingCode`, then `curl -X POST http://localhost:3000/pair/claim -H 'Content-Type: application/json' -d '{"pairingCode":"<code>","label":"second device"}'` → note the second `token` and `expiresAt` — this is when the 2-minute session ends.
4. A third `/pair/init` on the same pairing should now fail with 409 — a pairing is exactly two devices.
5. In one terminal: `curl -N "http://localhost:3000/events?token=<token>"` to watch the live stream.
6. In another terminal: `curl -X POST http://localhost:3000/items/link -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'` — it should appear instantly in the SSE stream.
7. `curl -X POST http://localhost:3000/items/photo -H "Authorization: Bearer <token>" -F "file=@some.jpg"` then `curl -H "Authorization: Bearer <token>" http://localhost:3000/items/<id>/file -o out.jpg` to confirm round-trip.
8. Wait until `expiresAt` passes, then confirm the same token now 401s and the uploaded file is gone from `relay-server/data/uploads`.
9. `npm run dev:desktop` — repeat steps 5–7 and confirm the tray app's window shows the item live, shows a Windows notification, and saves it to `Documents\Beam\` / `Pictures\Beam\`.
10. Run `ngrok http 3000`, point a real Android phone's browser at the ngrok HTTPS URL, install the PWA, pair via QR, then share a real link/photo from Chrome/Photos and confirm it reaches the desktop app — including with Wi-Fi off (cellular only), to prove this isn't LAN-limited.
11. Repeat against the iOS Shortcut (see `ios-shortcut/README.md`) using the same ngrok URL.
12. Only after all of the above pass, deploy to Render (below) and re-pair everything against the production URL.

## Deployment: Render (recommended, free tier, easiest)

The fastest way to get a real, shareable HTTPS URL — no server to manage,
no port-forwarding on your home router. Full instructions, including an
important warning about Render's free-tier disk being ephemeral, are in
[`docs/HOSTING.md`](docs/HOSTING.md). Short version: push this repo to
GitHub, create a Render Blueprint pointed at it, and Render reads
[`render.yaml`](render.yaml) automatically.

## Deployment: self-hosted (persistent, more setup)

A Raspberry Pi, home server, or a cheap VPS you control, with
[Caddy](https://caddyserver.com/) in front for automatic HTTPS (required —
pairing tokens must never travel over plain HTTP).

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
   default `RELAY_URL` at your real domain.

### The installer is unsigned — what that means for people downloading it

Getting past Windows Smart App Control / SmartScreen requires a paid
code-signing identity (Azure Trusted Signing or a traditional OV/EV
certificate, both needing identity/business verification) — not something
a personal/hobby project does by default, so this installer isn't signed.
The first time someone runs `Beam Setup *.exe`, Windows will show a blue
"Windows protected your PC" screen. This is expected, not a sign anything's
wrong: click **More info**, then **Run anyway**. Since the source is public
in this repo, anyone concerned can read exactly what the installer does
before running it, rather than trusting a certificate.

## Security notes (short version)

- Pairing codes are short-lived (10 min) and single-use; tokens are 32
  random bytes, never guessable.
- A pairing is capped at exactly two devices — a third `/pair/init` or
  `/pair/claim` on the same pairing is rejected.
- Once both devices are present, the pairing has a fixed 2-minute lifetime:
  `lib/sessionCleanup.js` sweeps expired pairings every few seconds,
  deleting their devices, items, and uploaded files, so both tokens 401 on
  their very next request.
- Uploaded files are restricted by MIME type and size, and stored under
  server-generated filenames (never the client-supplied name) to avoid path
  traversal.
- The `/events` SSE endpoint takes its token as a query parameter (browsers'
  `EventSource` can't set custom headers) — documented tradeoff, mitigated
  by requiring HTTPS in deployment, and by the token becoming worthless the
  moment its pairing expires anyway.
- See `docs/THREAT_MODEL.md` for the full picture.
