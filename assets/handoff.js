/* Carrying a chosen file from one page to the editor.
 *
 * A File cannot survive a navigation. sessionStorage is the obvious reach, but
 * it only holds strings: base64 inflates a file by a third and the quota is
 * around 5 MB, so a 30 MB scan fails outright. IndexedDB stores the Blob
 * itself — no encoding, no practical limit.
 *
 * The three names below are the contract with app/core/handoff.ts on the
 * reading side. Change one and you must change the other. */
const DB = 'quire';
const STORE = 'handoff';
const KEY = 'file';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Parks a File for the editor to collect. Resolves once it is durably written. */
export async function parkFile(file) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(file, KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}
