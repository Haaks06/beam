# Hosting on Render (free tier)

> **⚠️ Render's free tier disk is EPHEMERAL.** Every device pairing, every
> stored link, and every uploaded photo can be silently wiped whenever
> Render redeploys the service or recycles the underlying instance. This is
> a deliberate tradeoff for a free/personal-scale deployment, **not a
> bug** — see [`docs/THREAT_MODEL.md`](THREAT_MODEL.md) for how the app
> tolerates this without crashing (it just quietly starts a fresh, empty
> database). If this becomes a real problem for you or the people you've
> shared this with:
> - Upgrade to Render's paid persistent disk add-on, mounted at the same
>   `DB_PATH`/`UPLOAD_DIR` paths already configured below — no code changes
>   needed, since both are already just filesystem paths read from
>   environment variables.
> - Or migrate to [Fly.io](https://fly.io), which offers a small persistent
>   volume even on its free/hobby tier. Same story: no app code changes,
>   just different infra pointing at the same env vars.

## Setup (using the `render.yaml` blueprint)

1. Push this repo to GitHub (Render deploys from a git repo).
2. In the [Render dashboard](https://dashboard.render.com), click **New +**
   → **Blueprint**, and point it at your repo. Render reads
   [`render.yaml`](../render.yaml) from the repo root automatically and
   configures the service for you — build command, start command, health
   check, and environment variables are all already defined there.
3. Click **Apply** / **Create**. Render will run:
   - Build: `npm install && npm run build:web` — installs all three
     workspaces and builds the PWA into `web-client/dist`.
   - Start: `npm run start:relay` — runs `node index.js`, which already
     detects and serves `web-client/dist` if present (see the
     static-serving block in `relay-server/index.js`), so one Render
     service serves both the API and the web client from one URL.
4. Once deployed, you'll get a URL like `https://share-to-pc-relay.onrender.com`.
   Confirm it's live: `curl https://share-to-pc-relay.onrender.com/health`
   should return `{"ok":true}` (the first request after a cold start may
   take 30-60+ seconds — see below).

## Cold starts

Render's free tier spins the service down after ~15 minutes of no
requests. The next request wakes it back up, which can take 30-60+
seconds. This is expected — if a friend shares a link and "nothing
happens" for a minute, the relay is just waking up; the item still arrives
once it's up (and the desktop app's backlog endpoint, `GET /items?since=`,
catches up anything it might have missed while reconnecting).

## Environment variables (if not using the blueprint)

If you'd rather configure the service by hand in Render's dashboard
(Environment tab) instead of via `render.yaml`, set these — see
[`.env.example`](../.env.example) for the authoritative list and meanings:

| Variable | Value |
|---|---|
| `DB_PATH` | `./data/relay.sqlite` |
| `UPLOAD_DIR` | `./data/uploads` |
| `MAX_UPLOAD_BYTES` | `15728640` |
| `CORS_ORIGIN` | leave blank (see below) |
| `INBOX_LIMIT_PER_HOUR` | `5` |

Don't set `PORT` — Render injects its own, and `relay-server/index.js`
already falls back to it correctly.

`CORS_ORIGIN` can stay blank because the relay serves the web client from
the same origin (step 3 above), so the web client's own requests are
same-origin and don't need CORS at all. It only matters for genuinely
cross-origin callers — the iOS Shortcuts app isn't a browser and doesn't
enforce CORS either. The API's own token auth is what actually gates
access, not CORS.
