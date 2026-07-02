# Beam for iOS (Shortcuts setup)

iOS doesn't let a website register as a native Share Sheet target the way
Android PWAs can, so on iOS, **Beam** works through a single Apple Shortcut
that appears in the Share Sheet like any other app — sharing a link or a
photo both go through the same shortcut, which branches on what you shared.
Built entirely in the **Shortcuts** app, no code required.

## Read this first: the 2-minute session limit changes how this works

Beam's pairings are now ephemeral: a phone and PC pair, get a 2-minute
window to send/receive, and then the relay forgets everything (both
devices' tokens stop working) until they pair again. That's fine for the
web client, which walks you through re-pairing every time — but a Shortcut
with a token baked into its header field will simply start failing with
401 the moment its pairing's 2 minutes are up.

In practice this means: **run the "Get Beam Token" helper shortcut below
right before you want to send something, use the main shortcut within the
next 2 minutes, and expect to repeat both steps next time.** There's no way
around this without changing the ephemeral-session design — it's the same
tradeoff the desktop app and web client accept.

## 0. Get a pairing token (do this right before each use)

1. On your PC, open Beam (click the tray icon) — it shows a QR/code once
   it's waiting for a second device to pair. If it's already mid-session
   with something else paired, click **Start over** first to get a fresh
   code.
2. On your iPhone, run the **helper shortcut** below — it pairs using that
   code and shows you the raw token so you can paste it into the main
   shortcut in step 1 below. Do this *right before* you plan to share
   something, since the resulting token stops working 2 minutes after your
   PC's code gets claimed.

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
7. Run it: get a fresh pairing code from your PC's Beam window, run this
   shortcut, enter the relay URL and code, and copy the token it shows you
   — then move straight to step 1 below before the 2 minutes run out.

## 1. "Beam to PC" (one shortcut, handles both links and photos)

1. Shortcuts app → **+** → name it `Beam to PC`.
2. Tap the shortcut's settings (ⓘ) → **Show in Share Sheet** → on. Under
   "Share Sheet Types", enable both **URLs**/**Safari web pages** and
   **Images**, so this one shortcut shows up no matter what you're sharing.
3. Add action **If** → Input: `Shortcut Input` → Condition: **Is Image**.
4. **If branch (photo)** — add action **Get Contents of URL**:
   - URL: `https://beam-wckn2w.fly.dev/items/photo`
   - Method: POST
   - Headers: `Authorization: Bearer <token-from-step-0>`
   - Request Body: **Form** → field named `file`, value = `Shortcut Input`.
5. **Otherwise branch (link)** — add action **Get Contents of URL**:
   - URL: `https://beam-wckn2w.fly.dev/items/link`
   - Method: POST
   - Headers: `Authorization: Bearer <token-from-step-0>`,
     `Content-Type: application/json`
   - Request Body: JSON → `{ "url": "Shortcut Input" }`.
6. Close the **If** block, save. Now sharing a link *or* a photo from any
   app → Share → "Beam to PC" sends it straight to your computer, as long
   as you're within that pairing's 2-minute window.

## Notes

- The token is hardcoded into the shortcut's header field, and stops
  working the moment its pairing expires (see above) — this isn't a bug to
  work around, it's the whole point of the ephemeral session model.
- Don't export/share the shortcut with a live token filled in — export a
  clean copy (delete the header value first) if you want to share the
  shortcut itself, e.g. via "Copy iCloud Link".
- If Beam is hosted on Render's free tier (see `docs/HOSTING.md`), the
  first `Get Contents of URL` call after ~15 minutes of inactivity can take
  30-60+ seconds while the relay wakes up — factor that into your 2-minute
  window, or the session may expire before the shortcut even gets a
  response.
- Test the shortcut against an `ngrok` URL before pointing it at your real
  deployed relay, per the main README's verification steps.
