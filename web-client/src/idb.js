// Shared IndexedDB access for app.js and trust.js. Kept as its own module
// (rather than each importing from the other) specifically to avoid a
// circular import between the two.
//
// Version 2 adds the `trustedDevices` store (Phase 2c) alongside the
// original `config` store (version 1). Version 3 adds `receivedItems`
// (Phase 2 regression fix — see saveReceivedItem below). All upgrades are
// idempotent against objectStoreNames.contains() so it's safe regardless
// of which version an existing installation is upgrading from.
// public/sw.js keeps its own independent copy of the `config`-store logic
// (it can't safely import a Vite-bundled module across the public/src
// boundary — see its own comment), but its version number is kept in sync
// with this file's, since opening the same IndexedDB database at a lower
// version than it's already been upgraded to throws.
export const DB_NAME = 'beam';
export const DB_VERSION = 3;
export const CONFIG_STORE = 'config';
export const TRUSTED_DEVICES_STORE = 'trustedDevices';
export const RECEIVED_ITEMS_STORE = 'receivedItems';

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CONFIG_STORE)) db.createObjectStore(CONFIG_STORE);
      if (!db.objectStoreNames.contains(TRUSTED_DEVICES_STORE)) {
        db.createObjectStore(TRUSTED_DEVICES_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(RECEIVED_ITEMS_STORE)) {
        db.createObjectStore(RECEIVED_ITEMS_STORE, { autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Phase 2 regression fix: a photo/file/voice/link sent over the live P2P
// data channel never touches the relay at all (that's the point of direct
// transfer), so it has no relay-assigned `id` and GET /items?since=... can
// never return it. Without this, reloading the receiving device's page
// mid-session silently loses every item that arrived P2P-direct, even
// though relay-delivered items in the same session survive the reload
// fine via the normal backlog fetch — a real regression, found by testing
// the reload path rather than just the send/receive happy path. Scoped by
// token so a later session's items are never shown mixed in with an
// earlier one's, and pruned wholesale on every return to the start screen
// (see enterStartState in app.js) so this can't grow without bound across
// many past sessions.
// Returns the autoIncrement key the record was saved under, so callers can
// dedupe repeated restores (e.g. across multiple SSE reconnects within the
// same session) without needing a relay-assigned id, which these items
// never have.
export async function saveReceivedItem(token, item) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECEIVED_ITEMS_STORE, 'readwrite');
    const req = tx.objectStore(RECEIVED_ITEMS_STORE).add({ token, item });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listReceivedItems(token) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECEIVED_ITEMS_STORE, 'readonly');
    const req = tx.objectStore(RECEIVED_ITEMS_STORE).getAllKeys();
    req.onsuccess = () => {
      const keys = req.result || [];
      const valuesReq = tx.objectStore(RECEIVED_ITEMS_STORE).getAll();
      valuesReq.onsuccess = () => {
        const values = valuesReq.result || [];
        const entries = keys
          .map((key, i) => ({ key, ...values[i] }))
          .filter((entry) => entry.token === token);
        resolve(entries);
      };
      valuesReq.onerror = () => reject(valuesReq.error);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearReceivedItems() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RECEIVED_ITEMS_STORE, 'readwrite');
    tx.objectStore(RECEIVED_ITEMS_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
