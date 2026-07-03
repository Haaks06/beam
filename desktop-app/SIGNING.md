# Code signing checklist (Windows)

Today's builds (`npm run build:desktop`) are **unsigned**. That's fine for
local testing, but an unsigned `.exe` triggers Windows SmartScreen's "Windows
protected your PC" warning for every downloader until enough people click
"Run anyway" to build up reputation — which in practice means most people
never get past the warning. This is the checklist for turning signing on for
real, once there's an actual certificate/account to plug in.

**Do not self-sign.** A self-signed certificate satisfies signtool but does
**not** satisfy SmartScreen — SmartScreen reputation is tied to a real
certificate authority's identity verification, not to whether a signature is
merely present. Self-signing would add complexity for zero actual benefit.

## The two supported paths

Both are wired up in [`electron-builder.js`](./electron-builder.js) purely
through environment variables — nothing in the repo needs to change to turn
signing on, and with none of these variables set, the build behaves exactly
as it does today (confirmed: `no signing info identified, signing is
skipped`).

### 1. Azure Trusted Signing (recommended)

Microsoft's HSM-backed signing service — cheaper and faster to get than a
traditional EV certificate, and (as of the CA/Browser Forum's June 2023
baseline requirements) increasingly the only realistic option for an
individual or small org, since private keys for new code-signing certs
generally have to live on FIPS-validated hardware now rather than a portable
`.pfx` file.

1. Set up an Azure Trusted Signing account and certificate profile:
   https://learn.microsoft.com/en-us/azure/trusted-signing/quickstart
2. Set these environment variables before running `npm run build:desktop`:
   - `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` — always required.
   - One of the following credential sets (electron-builder passes these
     straight through to Azure's `EnvironmentCredential`):
     - `AZURE_CLIENT_SECRET` (service principal secret), **or**
     - `AZURE_CLIENT_CERTIFICATE_PATH` (+ optional
       `AZURE_CLIENT_CERTIFICATE_PASSWORD`), **or**
     - `AZURE_USERNAME` + `AZURE_PASSWORD`
   - `AZURE_CODE_SIGNING_ENDPOINT` — the signing endpoint URI for your trusted
     signing account's region.
   - `AZURE_CERT_PROFILE_NAME` — the certificate profile name you created.
   - `AZURE_CODE_SIGNING_ACCOUNT_NAME` — the trusted signing account name.
3. Run the normal build. electron-builder's log line will change from
   "no signing info identified" to actually invoking the Azure signing
   pipeline for `Beam.exe` and the NSIS installer.

### 2. Classic `.pfx` certificate (fallback)

If a traditional OV/EV code-signing certificate is already owned (issued
before the HSM requirement, or from a CA that still issues portable files),
electron-builder picks it up with **zero config changes** — this is built
into electron-builder itself, not something this repo adds:

- `CSC_LINK` — path to (or base64-encoded contents of) the `.pfx` file.
- `CSC_KEY_PASSWORD` — the certificate's password.

(`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` also work and take priority, if a
distinct cert is ever needed for Windows specifically vs. some other
platform target.)

## Verifying a signed build

After building with either path active:

```powershell
Get-AuthenticodeSignature "dist\Beam Setup <version>.exe"
```

`Status` should read `Valid`, and `SignerCertificate.Subject` should show the
real certificate identity (Azure Trusted Signing's or the `.pfx`'s), not
"Beam" as a self-issued name.

## What signing does *not* immediately fix

Even correctly signed, a **brand-new** certificate identity still starts
with little-to-no SmartScreen reputation — the warning may still appear for
the first stretch of downloads. Standard OV certificates build reputation
over time/volume; Azure Trusted Signing and EV certificates get much faster
(often near-immediate) reputation because of the stronger identity
verification behind them. This is expected and not a sign that signing
"didn't work."

## Where this is wired up

- [`electron-builder.js`](./electron-builder.js) — the build config
  (replaces the old static `build` block in `package.json`, since a plain
  JSON block can't conditionally add `azureSignOptions` based on whether
  the env vars above are actually set).
- `package.json`'s `build` field was removed entirely in favor of the file
  above — electron-builder treats the two as mutually exclusive, so leaving
  both in place risked one silently shadowing the other.
