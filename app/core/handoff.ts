/* Carrying a chosen file from the home page to the editor.
 *
 * A File cannot survive a navigation, and base64 in sessionStorage would blow a
 * 30 MB scan up to 40 MB of string. IndexedDB stores the Blob itself, so the
 * hand-off costs nothing and works for any size.
 *
 * The write side lives in assets/site.js because the home page is plain static
 * HTML outside this bundle. These two constants are the contract between them —
 * change one and you must change the other. */
const DB = 'quire';
const STORE = 'handoff';
const KEY = 'file';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Reads the pending file and clears it, so a reload does not reopen it. */
export async function takeHandoff(): Promise<File | null> {
  let db: IDBDatabase;
  try {
    db = await open();
  } catch {
    return null;
  }

  return new Promise(resolve => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const get = store.get(KEY);
    get.onsuccess = () => {
      const file = get.result as File | undefined;
      store.delete(KEY);
      resolve(file instanceof File ? file : null);
    };
    get.onerror = () => resolve(null);
    tx.oncomplete = () => db.close();
  });
}
