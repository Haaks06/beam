// Bridges background.js's "Beam this image/link" context menu handlers and
// the actual Beam web app running in this tab. A content script always has
// an implicit messaging channel to its own extension's background script
// (no extension ID needed, unlike chrome.runtime.sendMessage(id, ...) from
// an arbitrary page) -- so this exists purely to carry that message the
// rest of the way into the page via window.postMessage, which web-client's
// src/app.js listens for (see its isExtensionPopup-gated handler).
//
// Entirely inert outside the extension's own popup window: manifest.json
// only injects this into /app, and it only ever does anything when
// ?src=extension is also present (set by background.js's focusOrCreateWindow,
// never by a normal visit).
if (new URLSearchParams(location.search).get('src') === 'extension') {
  function checkPendingShare() {
    chrome.runtime.sendMessage({ type: 'beam-ready' }, (share) => {
      if (chrome.runtime.lastError || !share) return;
      window.postMessage({ source: 'beam-extension', ...share }, location.origin);
    });
  }

  checkPendingShare();
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'beam-check-pending') checkPendingShare();
  });
}
