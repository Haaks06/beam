// electron-builder config, split out of package.json specifically so
// Windows code signing can be wired up conditionally from environment
// variables (a static JSON "build" block can't branch on whether signing
// credentials are actually present).
//
// Two signing paths are supported, and both are fully optional — if none
// of their env vars are set, this produces exactly the same unsigned
// build as before. See SIGNING.md for the full setup checklist,
// including why a self-signed certificate is *not* one of these options
// (it never earns Windows SmartScreen reputation, so it wouldn't solve
// anything real).
//
// 1. Azure Trusted Signing (recommended) — Microsoft's low-cost,
//    HSM-backed signing service. Also the practical necessity for anyone
//    getting a cert today: as of June 2023 the CA/Browser Forum baseline
//    requirements require code-signing private keys to live on FIPS-
//    validated hardware, so a portable, self-managed .pfx generally isn't
//    issuable to a new individual/small org anymore.
//    Needs: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (or the
//    certificate/username variants electron-builder also supports),
//    AZURE_CODE_SIGNING_ENDPOINT, AZURE_CERT_PROFILE_NAME,
//    AZURE_CODE_SIGNING_ACCOUNT_NAME.
// 2. Classic .pfx signing via CSC_LINK / CSC_KEY_PASSWORD — needs no
//    config here at all, electron-builder already reads those two env
//    vars automatically. Kept as a fallback for anyone who already holds
//    a traditional certificate rather than an Azure Trusted Signing
//    account.
module.exports = async function () {
  const win = {
    target: 'nsis',
    icon: 'assets/icon.ico',
    signtoolOptions: {
      publisherName: 'Beam',
    },
  };
  // build/installer.nsh's customInstall/customUnInstall macros add and
  // remove Windows Explorer's "Beam this file" right-click entry --
  // per-user (perMachine defaults to false already) since this installer
  // runs unsigned with no admin elevation, matching the HKCU registry keys
  // that script writes to.
  const nsis = {
    include: 'build/installer.nsh',
  };

  if (process.env.AZURE_CODE_SIGNING_ENDPOINT) {
    win.azureSignOptions = {
      endpoint: process.env.AZURE_CODE_SIGNING_ENDPOINT,
      certificateProfileName: process.env.AZURE_CERT_PROFILE_NAME,
      codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT_NAME,
    };
  }

  return {
    appId: 'com.beam.desktop',
    productName: 'Beam',
    npmRebuild: false,
    win,
    nsis,
    // electron-updater's feed -- GitHub Releases works as-is only while
    // this repo stays public (its provider assumes anonymous, unauthenticated
    // access to the releases API; a shipped app can't safely embed a token
    // to read a private repo's releases, since anyone could extract it from
    // the binary). If the repo ever goes private, switch this to the
    // generic HTTP provider pointed at a self-hosted update feed instead of
    // just adding a token here.
    publish: {
      provider: 'github',
      owner: 'Haaks06',
      repo: 'beam',
    },
  };
};
