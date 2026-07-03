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
  const win = await chrome.windows.create({
    url: RELAY_URL,
    type: 'popup',
    width: 420,
    height: 640,
  });
  beamWindowId = win.id;
}

chrome.action.onClicked.addListener(focusOrCreateWindow);

chrome.windows.onRemoved.addListener((closedId) => {
  if (closedId === beamWindowId) beamWindowId = null;
});
