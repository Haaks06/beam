# Chrome Web Store listing checklist

Everything needed to actually submit this extension, gathered in one place.
Nothing here has been submitted yet — this is prep, not a completed listing.

## Manifest V3 compliance (reviewed)

- `manifest_version: 3` — yes.
- No remotely hosted code: `background.js` and `content-bridge.js` are both
  local files bundled in the extension package. The popup window it opens
  (`chrome.windows.create` pointed at the live relay's `/app`) is a normal
  browser window navigating to a website, not remote code running *inside*
  the extension's own privileged context — this is the same pattern as any
  extension whose job is "open this website in a clean window," and doesn't
  trip the "no remote code" rule (that rule is about script executed with
  the extension's own permissions, not about opening a webpage).
- Icons present at all four required sizes (16/32/48/128) — yes, under
  `icons/`.
- No `unsafe-eval`, no bundled minified third-party code needing separate
  disclosure — the extension has no dependencies at all.

## Permission justifications (required in the CWS listing form)

Chrome Web Store review specifically asks for a plain-language justification
for every permission, especially broad ones. Use these:

- **`contextMenus`** — adds the "Beam this image" / "Beam this link"
  right-click menu items, the extension's core feature beyond the toolbar
  button.
- **`host_permissions: ["<all_urls>"]`** — needed specifically so
  `background.js` can fetch an image's actual bytes when "Beam this image"
  is clicked, for *any* site the user right-clicks on. A normal page fetch
  of a cross-origin image is subject to CORS and would fail (or return an
  opaque, unreadable response) on the large majority of sites that don't
  send permissive CORS headers on their images; extension service workers
  are exempt from that restriction only for origins covered by
  `host_permissions`. There's no narrower permission that would still let
  the feature work on arbitrary websites — this is the single purpose it's
  used for (grep `background.js` for the only `fetch()` call outside the
  relay's own known origin).
- **`content_scripts` matching the relay's own origin(s) only**
  (`beam-wckn2w.fly.dev` / `localhost:3000` for dev) — not a broad
  permission, scoped to the extension's own popup page, used only to relay
  a pending share into that page (see `content-bridge.js`'s comment). Update
  this list if the relay's production domain ever changes (e.g. to
  beamlot.com) — it must match wherever `background.js`'s `RELAY_URL`
  actually points, or the context-menu bridge silently stops working.

## Single purpose description (required field)

> Beam lets you pair your phone and computer for a few minutes at a time to
> send a photo, link, file, or voice memo between them — no accounts, no
> persistent connection, nothing kept afterward. This extension adds quick
> access from the browser: a toolbar button that opens Beam, and right-click
> menu items to send an image or link straight from any page.

## Privacy policy

Chrome Web Store requires a privacy policy URL for any extension requesting
host permissions or handling user content (this one does both). Use the
existing privacy section on the marketing site:
`https://beamlot.com/#privacy` — confirm it's live and accurately describes
what the extension does (fetches image bytes for the share feature,
forwards link URLs/image bytes to the paired session) before submitting,
since it needs to match actual behavior, not just the web app's.

## Still needed before submitting (not done here)

- [ ] At least one 1280×800 (or 640×400) promotional screenshot showing the
      popup and/or the right-click menu in action — needs a real screen
      capture, not something generatable from source.
- [ ] A 440×280 small promo tile image (optional but recommended).
- [ ] A Chrome Web Store developer account ($5 one-time registration fee)
      if one doesn't already exist.
- [ ] Decide the listing's visibility (public vs. unlisted) and pricing
      (free).
- [ ] Confirm `RELAY_URL` in `background.js` is pointed at whatever's
      actually the production relay at submission time — it's currently
      hardcoded to `https://beam-wckn2w.fly.dev`; if the custom domain
      (beamlot.com) becomes the canonical relay endpoint instead, update
      both `background.js` and this file's content-script justification
      above together.
- [ ] After the first real submission, note the Web Store-assigned
      extension ID somewhere durable — if a future feature ever needs
      page-initiated messaging (`externally_connectable`, the alternative
      to this extension's content-script bridge design), that ID has to be
      stable across reinstalls, which only happens once actually published
      (or by pinning a `"key"` in the manifest ahead of time).
