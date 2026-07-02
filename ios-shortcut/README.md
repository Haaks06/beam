# Beam for iOS (Shortcuts setup)

iOS doesn't let a website register as a native Share Sheet target the way
Android PWAs can, so on iOS, **Beam** works through a single Apple Shortcut
that appears in the Share Sheet like any other app — sharing a link or a
photo both go through the same shortcut, which branches on what you shared.
Built entirely in the **Shortcuts** app, no code required, and only one
shortcut to set up (not two).

## 0. Get a pairing token

Before building the shortcut you need a token — a device holding a valid
token belongs to your Beam inbox, same as your desktop and any other
paired device:

1. On your PC, open Beam's tray menu → **Show pairing QR** (or, on first
   launch, the welcome window already shows this).
2. On your iPhone, run the **helper shortcut** below — it pairs using the
   code shown on your PC and shows you the raw token so you can paste it
   into the main shortcut in step 1 below.

### Helper shortcut: "Get Beam Token"

1. Open **Shortcuts** → **+** → name it `Get Beam Token`.
2. Add action **Ask for Input** → Input Type: Text → Prompt: "Relay URL",
   Default Answer: `https://beam-wckn2w.fly.dev`.
3. Add action **Ask for Input** → Input Type: Text → Prompt: "Pairing code".
4. Add action **Get Contents of URL**:
   - URL: combine `Relay URL` (step 2) + `/pair/claim`, e.g. via the
     "Combine Text" action.
   - Method: POST
   - Headers: `Content-Type: application/json`
   - Request Body: JSON →
     ```json
     { "pairingCode": "[Pairing code]", "label": "iPhone" }
     ```
5. Add action **Get Dictionary Value** → Key: `token`, from the previous
   step's output.
6. Add action **Show Result** (or **Show Alert**) to display the token.
7. Run it once: get a pairing code from your PC's Beam tray menu, run this
   shortcut, enter the relay URL and code, and copy the token it shows you.

## 1. "Beam to PC" (one shortcut, handles both links and photos)

1. Shortcuts app → **+** → name it `Beam to PC`.
2. Tap the shortcut's settings (ⓘ) → **Show in Share Sheet** → on. Under
   "Share Sheet Types", enable both **URLs**/**Safari web pages** and
   **Images**, so this one shortcut shows up no matter what you're sharing.
3. Add action **If** → Input: `Shortcut Input` → Condition: **Is Image**.
4. **If branch (photo)** — add action **Get Contents of URL**:
   - URL: `https://beam-wckn2w.fly.dev/items/photo`
   - Method: POST
   - Headers: `Authorization: Bearer <your-token-from-step-0>`
   - Request Body: **Form** → field named `file`, value = `Shortcut Input`.
5. **Otherwise branch (link)** — add action **Get Contents of URL**:
   - URL: `https://beam-wckn2w.fly.dev/items/link`
   - Method: POST
   - Headers: `Authorization: Bearer <your-token-from-step-0>`,
     `Content-Type: application/json`
   - Request Body: JSON → `{ "url": "Shortcut Input" }`.
6. Close the **If** block, save. Now sharing a link *or* a photo from any
   app → Share → "Beam to PC" sends it straight to your computer — no need
   to pick between two shortcuts.

## Notes

- The token is hardcoded into the shortcut's header field during setup.
  Don't export/share the shortcut once the token is filled in — export a
  clean copy (delete the header value first) if you want to share the
  shortcut itself, e.g. via "Copy iCloud Link".
- If you ever need to revoke access (lost phone, etc.), there's currently no
  per-device revoke endpoint — the simplest fix for a class project is to
  delete the `devices` row directly in the relay's SQLite database, or wipe
  your inbox's rows and re-pair all devices.
- If Beam is hosted on Render's free tier (see `docs/HOSTING.md`), the
  first `Get Contents of URL` call after ~15 minutes of inactivity can take
  30-60+ seconds while the relay wakes up — the shortcut isn't broken, it's
  just cold-starting.
- Test the shortcut against an `ngrok` URL before pointing it at your real
  deployed relay, per the main README's verification steps.
