// This extension has exactly one job: open the real, live Beam web app
// (the same page a phone gets — see relay-server/index.js serving
// web-client/dist) in a clean, tab-less window. There's no bundled copy of
// the UI to keep in sync — it's always whatever's actually deployed.
const RELAY_URL = 'https://beam-wckn2w.fly.dev';

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
