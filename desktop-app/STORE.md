# Microsoft Store (MSIX) checklist

## Handoff: what's done, what's left for you

Everything up to the point of actually submitting is done and pushed. What's
left is account-level and can only be done by whoever owns (or will own) the
Microsoft account this gets published under — there's no way for me to do
this part.

**What's ready right now:**
- The MSIX/appx build target, tested end-to-end (tray icon, background
  listening, auto-save all confirmed working via a real sideload install
  against the live relay).
- Store-policy fixes: auto-update disabled under the Store build, "start at
  login" fails honestly instead of silently.
- Known limitation documented, not silently shipped: no Explorer right-click
  "Beam this file" entry in the MSIX build (see below for why).
- In-package tile assets (real logo, not Microsoft's placeholder art).
- Store listing copy, category, search terms, and the required 300×300 icon
  (`store-assets/`).

**What you need to do, in order:**
1. **Register the Microsoft Partner Center developer account.**
   [partner.microsoft.com/dashboard/registration](https://partner.microsoft.com/dashboard/registration)
   — free as of the May 2026 policy change for both individual ($19 fee
   removed) and company ($99 fee removed) accounts. May ask for identity
   verification (government ID + selfie for individuals).
2. **Reserve the app name** ("Beam" or a variant if taken) inside Partner
   Center. This generates the real `identityName` and `publisher` values on
   the app's **Product identity** page.
3. Give me those two values (or edit them yourself) in
   [`electron-builder.js`](./electron-builder.js) — currently
   `CHANGEME.BeamDesktopApp` and an unset publisher — then rebuild:
   `npm run build -w desktop-app -- --win appx --publish never`.
4. **Take at least one screenshot** of the app (1366×768 or larger PNG) — the
   one listing asset not already prepared; see
   `store-assets/STORE-LISTING.md` for exactly why and how.
5. **Submit** through Partner Center: upload the rebuilt `.appx`, paste in
   the content from `store-assets/STORE-LISTING.md`, upload
   `store-assets/StoreListing-AppIcon-300x300.png` and your screenshot(s),
   fill in the privacy policy URL and support contact (both marked
   `CHANGEME` in the listing doc — need real values before Partner Center
   will accept the submission), complete the age-rating questionnaire, and
   submit for certification.
6. **Once certification passes and the listing is live**, tell me the Store
   URL. The website's download page still shows only the direct `.exe` for
   now — deliberately not touched yet, since there's no real Store link to
   point it at until this step is done. Making the Store link the primary,
   recommended download (with the `.exe` demoted to a clearly-labeled
   "advanced/manual install" option) is the very next thing once you have
   that URL.

Certification itself typically takes hours to a few days; Microsoft signs
the package as part of that process, so nothing further is needed from the
signing side once it's approved.

---

Beam now builds two Windows targets from the same source (see
[`electron-builder.js`](./electron-builder.js)):

- **nsis** — the existing raw `.exe`, unsigned, triggers SmartScreen. Direct
  download, no account needed.
- **appx** — MSIX, installable through the Microsoft Store or sideloaded
  directly. Goes through Microsoft's own certification instead of
  SmartScreen/Smart App Control, which is the actual fix for the "unsafe
  download" problem — see [`SIGNING.md`](./SIGNING.md) for why a purchased
  code-signing cert is a separate, still-unsolved problem for the `.exe` path.

Build it with:

```
npm run build -w desktop-app -- --win appx --publish never
```

electron-builder downloads the Windows SDK tooling it needs (makeappx,
makepri, signtool) itself on first use — no system-wide SDK install required.
Confirmed working on this repo's dev machine (Windows 10, no SDK installed
beforehand).

## What actually happens under MSIX packaging

electron-builder packages this as a **Desktop Bridge ("Centennial")** app,
declared via `<rescap:Capability Name="runFullTrust"/>` in the manifest
(electron-builder's own template — not something configured in this repo).
That's a meaningfully different, much less restrictive model than a sandboxed
UWP AppContainer app: it runs as a normal full-trust desktop process under the
signed-in user's own account, not inside a low-privilege container. Concretely,
this is **not** the "everything needs a new capability" situation MSIX often
implies.

Verified end-to-end against the real deployed relay (www.beamlot.com), not
just reasoned about, by building, self-signing, sideloading, and actually
pairing/sending/receiving through the packaged app:

| Feature | Status | How it was verified |
|---|---|---|
| Tray icon | ✅ Works | Visually confirmed after sideload install |
| Background SSE listening (stays paired while hidden) | ✅ Works | Paired the running packaged app against the live relay via `curl`, from a separate simulated device |
| Auto-save to `Pictures\Beam` | ✅ Works | Sent a real photo item through the live relay to the paired packaged app; the exact bytes landed in `Pictures\Beam` within seconds, no capability needed beyond `runFullTrust` |
| Auto-save to `Documents\Beam Files` / `Music\Beam` | ✅ Expected to work, same code path | Not independently re-tested — `saveBinaryItem()` in `saveHandlers.js` is the identical function for photo/file/voice, just a different `destDir`; there's no per-folder-type MSIX restriction that would make one succeed and another fail under `runFullTrust` |
| Explorer "Beam this file" right-click entry | ❌ **Does not exist in the MSIX build** | Confirmed two ways: (1) `build/installer.nsh`'s registry-writing custom-install script only runs for the **nsis** target — the AppX Deployment Service never executes it; (2) checked the registry directly post-install (`HKCU:\Software\Classes\*\shell` and the package's own class registrations) — nothing is there |
| "Start Beam at login" toggle | ⚠️ **Fixed to fail honestly instead of silently** | See below |
| Auto-update via `electron-updater` | ⚠️ **Disabled under the Store build** | See below |

## Fixes made in `main.js`

Both driven off `process.windowsStore`, the boolean Electron sets
automatically when running under Desktop Bridge/MSIX (no config needed):

1. **`electron-updater` is skipped entirely** (`app.isPackaged &&
   !process.windowsStore`). Store apps must update through the Store, not a
   self-fetched installer — this isn't optional politeness, it's a
   certification-policy requirement, and separately the GitHub Releases feed
   only ever publishes the nsis `.exe`, which isn't even a valid update
   artifact for an MSIX install.

2. **"Start at login" no longer silently no-ops.** Tested directly: toggling
   it in a sideloaded build, then checking
   `HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\StartupApproved\StartupTasks`
   afterward — nothing was ever registered there. This matches Electron's own
   documented behavior for `setLoginItemSettings` under a Store package: *"this
   API will return `true` for all calls but the registry key it sets won't be
   accessible by other applications."* In other words, the toggle would have
   looked like it worked while doing nothing. `main.js` now skips the doomed
   API call under `process.windowsStore` and shows a real Windows
   notification instead ("Start at login not yet available -- coming in a
   future update"), confirmed by actually toggling it in the sideloaded build.

   A proper fix needs the WinRT `Windows.ApplicationModel.StartupTask` API,
   which Electron doesn't project natively — would need a native/WinRT
   binding dependency. Not attempted here; scoping that in is a reasonable
   follow-up, not a blocker for submission (the toggle is honest now, not
   broken-and-silent).

   Note: `electron-builder.js`'s `appx.addAutoLaunchExtension: true` still
   adds the manifest's `windows.startupTask` extension, which is a
   prerequisite for wiring the real API up later — just not sufficient by
   itself, and there's a known upstream electron-builder quirk worth knowing
   about if anyone picks this up: the extension's `TaskId` is hardcoded to
   `"SlackStartup"` in electron-builder's own template (not configurable),
   so any future StartupTask API call needs to reference that exact ID.

## Known limitation, not fixed: Explorer context-menu integration

"Beam this file" (`build/installer.nsh`) has no MSIX equivalent wired up.
Reimplementing it properly needs either:
- Windows 11 22H2+'s `windows.fileExplorerContextMenus` app extension
  (version-gated, and designed around sparse-package scenarios — would need
  real testing to confirm it covers "any file" the way the current NSIS
  registry entries do), or
- A full COM shell-extension server registered through the manifest
  (`com:ExtendedFile` desktop extensions) — meaningfully more engineering
  than the rest of this MSIX work combined.

Decided not to attempt either as part of this pass — it's a real, visible gap
for MSIX-install users (no such gap for direct-.exe-install users, who keep
the existing NSIS-installed context menu entry unchanged), not a silent one.
Users on the Store build still have drag-and-drop, the clipboard-watch
quick-send, and manually opening the app as ways to send a file.

## Placeholders that MUST be replaced before real submission

`electron-builder.js`'s `appx` block currently has:

```js
identityName: 'CHANGEME.BeamDesktopApp',
publisher: undefined, // CHANGEME
```

Both are deliberately obvious placeholders rather than guessed-at real-looking
values, so a submission attempt with stale defaults fails loudly instead of
quietly uploading under the wrong identity. Once the Partner Center account
exists and the app name is reserved:

1. Partner Center → the reserved app → **Product identity** page has both the
   exact `Package/Identity/Name` (→ `identityName`) and `Package/Identity/Publisher`
   (→ `publisher`, a string like `CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`).
2. Copy both into `electron-builder.js` exactly as shown, no reformatting.
3. Rebuild. electron-builder will now sign against Partner Center's identity
   instead of falling back to the local `CN=ms` test build.

## How local sideload testing worked (for whoever does this next)

MSIX packages must be signed to install at all, even for local testing —
unlike the unsigned nsis `.exe`. With no `publisher`/signing cert configured,
electron-builder still builds the package (falls back to identity `CN=ms`),
just leaves it unsigned. To actually install and click through it locally:

1. Generate a self-signed cert matching the package's publisher:
   ```powershell
   New-SelfSignedCertificate -Type Custom -Subject "CN=ms" -KeyUsage DigitalSignature `
     -FriendlyName "Beam MSIX Test Cert" -CertStoreLocation "Cert:\CurrentUser\My" `
     -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}") `
     -KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddYears(1)
   ```
2. Export it to a `.pfx` and sign the built `.appx` with electron-builder's
   own vendored `signtool.exe` (cached under
   `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\...\signtool.exe`).
3. Export the **public-only** certificate (no private key) and import it into
   `Cert:\LocalMachine\Root` — this requires an elevated PowerShell and does
   weaken trust-chain validation on that machine until removed, so it's worth
   doing deliberately, not scripting around unattended. Remove it again once
   done testing:
   ```powershell
   Get-ChildItem Cert:\LocalMachine\Root | Where-Object {$_.Subject -eq "CN=ms"} | Remove-Item
   ```
4. `Add-AppxPackage -Path ".\Beam 0.10.4.appx"`. Windows Developer Mode
   should be on (`AllowDevelopmentWithoutDevLicense` under
   `HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock`), though
   in practice the real blocker is the signature trust step above, not
   Developer Mode itself.
5. Launch via `explorer.exe shell:AppsFolder\<PackageFamilyName>!<AppId>` (find
   both with `Get-AppxPackage` + `Get-AppxPackageManifest`) — the installed
   `.exe` under `Program Files\WindowsApps\...` **cannot be launched
   directly** (`Access is denied`); Desktop Bridge blocks execution outside
   the proper AppX activation path, confirmed by trying.

## Submission checklist (see also the top-level handoff)

- [ ] Register the Microsoft Partner Center developer account (free as of the
      May 2026 policy change — individual accounts no longer have the $19
      registration fee, company accounts no longer have the $99 fee).
- [ ] Reserve the app name, copy the real `identityName`/`publisher` into
      `electron-builder.js`.
- [ ] Replace the in-package tile assets under `build/appx/` (see this repo's
      asset-prep work) — without them, electron-builder silently falls back to
      Microsoft's own generic sample tile art.
- [ ] Rebuild with real identity + real assets, submit through Partner
      Center's dashboard (drag-and-drop the `.appx`, no signing needed —
      Microsoft signs it as part of certification).
- [ ] Once certification passes and the listing is live, update
      `web-client`'s download page to make the Store link the primary,
      recommended path (tracked separately — needs the real Store URL, which
      doesn't exist yet).
