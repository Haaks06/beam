// Shared IndexedDB access for app.js and trust.js. Kept as its own module
// (rather than each importing from the other) specifically to avoid a
// circular import between the two.
//
// Version 2 adds the `trustedDevices` store (Phase 2c) alongside the
// original `config` store (version 1) — idempotent against
// objectStoreNames.contains() so it's safe regardless of which version an
// existing installation is upgrading from. public/sw.js keeps its own
// independent copy of the `config`-store logic (it can't safely import a
// Vite-bundled module across the public/src boundary — see its own
// comment), but its version number is kept in sync with this file's,
// since opening the same IndexedDB database at a lower version than it's
// already been upgraded to throws.
export const DB_NAME = 'beam';
export const DB_VERSION = 2;
export const CONFIG_STORE = 'config';
export const TRUSTED_DEVICES_STORE = 'trustedDevices';

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CONFIG_STORE)) db.createObjectStore(CONFIG_STORE);
      if (!db.objectStoreNames.contains(TRUSTED_DEVICES_STORE)) {
        db.createObjectStore(TRUSTED_DEVICES_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
