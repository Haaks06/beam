# Hosting on Fly.io

This is what `www.beamlot.com` (the production instance this repo's
README links to — served from the underlying Fly app `beam-wckn2w.fly.dev`,
which now redirects here, see `PUBLIC_RELAY_URL` in `fly.toml`) actually
runs. Fly's free/hobby tier includes a small persistent volume, so
pairings and uploaded files survive restarts and redeploys instead of
being wiped — the main reason this project moved off Render's free tier,
where the disk is ephemeral.

## Setup

1. Install `flyctl` and sign in: see
   [Fly's install docs](https://fly.io/docs/flyctl/install/), then
   `flyctl auth login`.
2. First time only — create the app (this repo's [`fly.toml`](../fly.toml)
   already defines the region, env vars, health check, and mount, so
   `flyctl launch` mostly just needs to confirm them):
   ```bash
   flyctl launch
   ```
3. Create the persistent volume `fly.toml` expects (`beam_data`, mounted at
   `/data` — this is where `DB_PATH`/`UPLOAD_DIR` point):
   ```bash
   flyctl volumes create beam_data --size 1 --region ams
   ```
   Volumes are region-locked — use the same region as `primary_region` in
   `fly.toml`.
4. Build the web client and deploy:
   ```bash
   npm run build:web
   flyctl deploy
   ```
   `relay-server/index.js` already serves `web-client/dist` as static files
   when present, so one deploy covers both the API and the web client.
5. Confirm it's live: `curl https://<your-app>.fly.dev/health` should
   return `{"ok":true,"version":"..."}`.

## Why `min_machines_running = 1`

`fly.toml` sets `auto_stop_machines = false` and `min_machines_running = 1`
— the machine never scales to zero. This matters specifically because
pairings are already short-lived (5 minutes by default, 2-15 configurable)
by design; a cold start on top of that would eat into the pairing window
itself, unlike a normal always-warm web app where a slow first request is
just mildly annoying.

## Environment variables

See [`.env.example`](../.env.example) for the full list. The ones
`fly.toml` sets explicitly:

| Variable | Value | Why |
|---|---|---|
| `DB_PATH` | `/data/relay.sqlite` | Lives on the persistent volume, not the ephemeral container filesystem. |
| `UPLOAD_DIR` | `/data/uploads` | Same volume, same reason. |
| `MAX_UPLOAD_BYTES` | `15728640` (15 MB) | Per-photo upload cap. |
| `CORS_ORIGIN` | `""` (blank) | Blank is safe here because the relay serves the web client from the same origin — see below. |
| `PUBLIC_RELAY_URL` | `https://www.beamlot.com` | The URL every pairing link/QR code points at, and what a request on any other hostname (e.g. the raw `beam-wckn2w.fly.dev` address) gets redirected to — see `relay-server/lib/publicRelayUrl.js`. Set this to your own domain if self-hosting; without it, pairing links fall back to `http://localhost:3000`. |
| `INBOX_LIMIT_WINDOW_MS` / `INBOX_LIMIT_PER_WINDOW` | `600000` / `200` | Rate limit on `POST /inbox`, the one unauthenticated endpoint. See `docs/THREAT_MODEL.md`. |

`CORS_ORIGIN` can stay blank because the relay serves the web client from
the same origin (step 4 above), so the web client's own requests are
same-origin and don't need CORS at all. It only matters for genuinely
cross-origin callers — the iOS Shortcuts app isn't a browser and doesn't
enforce CORS either. The API's own token auth is what actually gates
access, not CORS.

## Error visibility

Everything the relay logs (including server-side errors from the catch-all
error middleware in `index.js`, uncaught exceptions/unhandled rejections,
and client-side errors the web client reports to `POST /client-error` —
see `routes/clientError.js`) goes to stdout/stderr, which Fly already
captures with zero extra setup:

```bash
flyctl logs --app beam-wckn2w
```

This is deliberately minimal — the goal is knowing a bug happened before
users report it, not a full observability stack. A real error-tracking
service (Sentry or similar) would be a reasonable upgrade later if volume
ever justifies it, but isn't set up here since that needs its own account/
DSN to configure.

## Alternative: Render, or any other Node host

Nothing here is Fly-specific except the volume mechanics — any host that
gives you a persistent disk (or an add-on for one) works the same way: set
`DB_PATH`/`UPLOAD_DIR` to paths on that disk, `npm run build:web` before
start, `npm run start:relay` (i.e. `node relay-server/index.js`) to run it.
Render's free tier specifically does *not* have a persistent disk by
default (its containers restart clean on every redeploy/sleep cycle),
which is why it's not the recommended option here — its paid persistent
disk add-on would work fine, mounted at the same paths.
