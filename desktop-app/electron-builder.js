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
    // Two targets: nsis (the existing raw-.exe direct download, unsigned,
    // triggers SmartScreen) and appx (Microsoft Store / MSIX, see the appx
    // block below) -- both built from the same source, side by side, so
    // the direct-download path keeps working exactly as before while the
    // Store path becomes an additional, safer install option.
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'appx', arch: ['x64'] },
    ],
    icon: 'assets/icon.ico',
    signtoolOptions: {
      publisherName: 'Beam',
    },
  };
  // build/installer.nsh's customInstall/customUnInstall macros add and
  // remove Windows Explorer's "Beam this file" right-click entry --
  // per-user (perMachine defaults to false already) since this installer
  // runs unsigned with no admin elevation, matching the HKCU registry keys
  // that script writes to. NSIS-only: the appx/MSIX target installs
  // through the Windows AppX Deployment Service instead, which never runs
  // this script -- see main.js's process.windowsStore handling for how the
  // packaged build accounts for that gap.
  const nsis = {
    include: 'build/installer.nsh',
  };

  // Microsoft Store / MSIX packaging. electron-builder packages this as a
  // Desktop Bridge ("Centennial") app -- the manifest's <rescap:Capability
  // Name="runFullTrust"/> (electron-builder's own template, not something
  // configured here) means it runs as a normal full-trust desktop process,
  // NOT inside a sandboxed AppContainer. Concretely: no special capability
  // is needed for the existing Documents\Beam / Pictures\Beam / Music\Beam
  // auto-save (see saveHandlers.js) or the tray icon/background SSE
  // listening (main.js) -- those already work under full trust exactly as
  // unpackaged. What *does* need separate handling, verified by actually
  // sideloading and testing this build (see desktop-app/STORE.md):
  //   - The Explorer right-click "Beam this file" entry (installer.nsh)
  //     has no MSIX equivalent wired up yet -- confirmed absent in the
  //     packaged build, not silently assumed. Documented as a known gap
  //     in STORE.md rather than shipped unmentioned.
  //   - Auto-launch-at-login needs the windows.startupTask extension
  //     below (addAutoLaunchExtension) instead of the plain registry Run
  //     key main.js normally writes -- see main.js's process.windowsStore
  //     branch in setAutoLaunch().
  //   - electron-updater's GitHub-releases self-update is Store-policy-
  //     incompatible (Store apps must update through the Store) and is
  //     disabled under process.windowsStore -- see main.js.
  const appx = {
    // Real values, from Partner Center's Product identity page. Three
    // distinct things, easy to conflate (an earlier version of this file
    // did): identityName is the internal package identity (alphanumeric +
    // dot/dash only, which is exactly why it can't just be the product's
    // real name below -- em dashes and spaces aren't valid there), and
    // publisherDisplayName is the *publisher's* name ("by Beamlot"), not
    // the app's. Neither is what Package/Properties/DisplayName needs to
    // match.
    identityName: 'Beamlot.Beamlot',
    publisher: 'CN=A0E9C038-077F-4423-82A7-D51710D8E4BF',
    publisherDisplayName: 'Beamlot',
    // The actual reserved product name (Partner Center's Product identity
    // page title itself reads "Beam — Send Anywhere | Product identity") --
    // this is what Package/Properties/DisplayName must match, confirmed
    // after an earlier fix here ("Beamlot") turned out to be a
    // misdiagnosis: it happened to clear the same generic Store validation
    // error without actually being the reserved product name. Character-
    // for-character match required, including the em dash (—, U+2014, not
    // a hyphen).
    displayName: 'Beam — Send Anywhere',
    backgroundColor: '#630000', // matches the site's maroon signal accent
    // Adds the windows.startupTask manifest extension so "start at login"
    // has an MSIX-native mechanism to hook into -- see main.js's
    // setAutoLaunch() for the process.windowsStore-specific wiring this
    // pairs with, and STORE.md for what was actually verified vs. still
    // needs a real-device check post-submission.
    addAutoLaunchExtension: true,
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
    appx,
    // electron-updater's feed -- GitHub Releases works as-is only while
    // this repo stays public (its provider assumes anonymous, unauthenticated
    // access to the releases API; a shipped app can't safely embed a token
    // to read a private repo's releases, since anyone could extract it from
    // the binary). If the repo ever goes private, switch this to the
    // generic HTTP provider pointed at a self-hosted update feed instead of
    // just adding a token here. Only relevant to the nsis target -- the
    // appx target never uses this (Store apps update through the Store).
    publish: {
      provider: 'github',
      owner: 'Haaks06',
      repo: 'beam',
    },
  };
};
