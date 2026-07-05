// This extension has exactly one job: open the real, live Beam web app
// (the same page a phone gets — see relay-server/index.js serving
// web-client/dist) in a clean, tab-less window. There's no bundled copy of
// the UI to keep in sync — it's always whatever's actually deployed.
const RELAY_URL = 'https://www.beamlot.com';

let beamWindowId = null;

async function focusOrCreateWindow() {
  if (beamWindowId !== null) {
    try {
      await chrome.windows.update(beamWindowId, { focused: true });
      return;
    } catch {
      // Window was closed by some other means (Alt+F4, taskbar) without
      // firing onRemoved in time — fall through and open a fresh one.
      beamWindowId = null;
    }
  }
  // Sized to fit the invite screen (the tallest one, on account of the QR
  // code) without scrolling at web-client's compacted spacing — see
  // web-client/src/styles.css. Was 420x640, which left a lot of empty popup
  // below the actual content.
  // /app specifically, not the bare root — root now serves beamlot.com's
  // marketing landing page; the actual pairing app lives at /app (see
  // relay-server/index.js's routing). ?src=extension lets web-client
  // (src/app.js) tell this context apart from a phone/desktop browser — a
  // laptop webcam scanning a phone's QR isn't a real flow, so that button
  // hides here specifically.
  const win = await chrome.windows.create({
    url: `${RELAY_URL}/app?src=extension`,
    type: 'popup',
    width: 400,
    height: 600,
  });
  beamWindowId = win.id;
}

chrome.action.onClicked.addListener(focusOrCreateWindow);

chrome.windows.onRemoved.addListener((closedId) => {
  if (closedId === beamWindowId) beamWindowId = null;
});

// -- Phase 3b: right-click "Beam this image/link" -------------------------
// The popup window above is just the same live Beam web app any other
// device gets — it doesn't know about a context-menu click until told.
// Rather than have this background script POST to the relay directly
// (which would mean duplicating web-client's whole P2P-vs-relay-fallback
// send logic here, a second copy of the exact same thing to keep in
// sync), the actual send happens in the page itself: this just fetches
// the image bytes (needs a real extension context to bypass CORS for
// arbitrary third-party image URLs — see host_permissions) or notes the
// link, stashes it as `pendingShare`, and hands it off to
// content-bridge.js the moment that tab asks for it.
let pendingShare = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'beam-image', title: 'Beam this image', contexts: ['image'] });
  chrome.contextMenus.create({ id: 'beam-link', title: 'Beam this link', contexts: ['link'] });
});

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Single entry point for "a share was requested" -- used by the real
// context-menu handler below, and called the exact same way from tests
// (via the service worker's own evaluate), so there's no separate test-only
// copy of this logic that could quietly drift from what a real click does.
async function deliverShare(share) {
  pendingShare = share;
  const alreadyOpen = beamWindowId !== null;
  await focusOrCreateWindow();
  if (alreadyOpen) {
    // A brand-new window's content script runs checkPendingShare() on its
    // own once the page loads (see content-bridge.js) -- this covers the
    // other case, an already-open popup that's just being refocused, which
    // has no fresh "page just loaded" moment to hang that check off of.
    const tabs = await chrome.tabs.query({ windowId: beamWindowId });
    if (tabs[0]) await chrome.tabs.sendMessage(tabs[0].id, { type: 'beam-check-pending' }).catch(() => {});
  }
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'beam-link') {
    await deliverShare({ kind: 'link', url: info.linkUrl });
  } else if (info.menuItemId === 'beam-image') {
    try {
      const res = await fetch(info.srcUrl);
      if (!res.ok) throw new Error(`couldn't fetch that image (${res.status})`);
      const blob = await res.blob();
      await deliverShare({ kind: 'image', dataBase64: await blobToBase64(blob), mimeType: blob.type || 'image/jpeg' });
    } catch (err) {
      await deliverShare({ kind: 'error', message: `Couldn't fetch that image: ${err.message}` });
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'beam-ready') return false;
  sendResponse(pendingShare);
  pendingShare = null;
  return true;
});
