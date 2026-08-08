/* IndexedDB wrapper. Photos live here so the app works with no network and no
   GitHub token at all; the GitHub sync layer sits on top of this, never under it.

   NOTE: sw.js opens the same database by hand (a service worker can't import an
   ES module in every browser we care about). If DB_NAME/DB_VERSION or the
   `inbox` store shape changes here, change it there too. */

export const DB_NAME = 'pixsz';
export const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('photos')) {
        const photos = db.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('createdAt', 'createdAt');
        photos.createIndex('path', 'path', { unique: false });
      }
      if (!db.objectStoreNames.contains('inbox')) {
        db.createObjectStore('inbox', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta');
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const wrap = req => ({ __req: req });

export const put = photo => tx('photos', 'readwrite', s => wrap(s.put(photo)));
export const get = id => tx('photos', 'readonly', s => wrap(s.get(id)));
export const del = id => tx('photos', 'readwrite', s => wrap(s.delete(id)));

/** Newest first — the order the grid renders in. */
export async function all() {
  const rows = await tx('photos', 'readonly', s => wrap(s.getAll()));
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function byPath(path) {
  const rows = await tx('photos', 'readonly', s => wrap(s.index('path').getAll(path)));
  return rows[0] || null;
}

export function putMany(photos) {
  return tx('photos', 'readwrite', s => { photos.forEach(p => s.put(p)); });
}

export function clearPhotos() {
  return tx('photos', 'readwrite', s => wrap(s.clear()));
}

/* --- share-target inbox: written by sw.js, drained by the page --- */

export function takeInbox() {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction('inbox', 'readwrite');
    const store = t.objectStore('inbox');
    const req = store.getAll();
    req.onsuccess = () => store.clear();
    t.oncomplete = () => resolve(req.result || []);
    t.onerror = () => reject(t.error);
  }));
}

/* --- small key/value store for settings that don't belong in localStorage --- */

export const metaGet = key => tx('meta', 'readonly', s => wrap(s.get(key)));
export const metaSet = (key, val) => tx('meta', 'readwrite', s => wrap(s.put(val, key)));
