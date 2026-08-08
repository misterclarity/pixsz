/* Service worker: offline app shell + Web Share Target.

   The share target is the reason this file does IndexedDB by hand — a shared
   photo arrives as a POST that the page never sees, so the worker has to stash
   the files somewhere the page can pick them up. Keep DB_NAME/DB_VERSION and
   the `inbox` store in step with js/db.js. */

const VERSION = 'pixsz-v3';
const PHOTOS = 'pixsz-photos-v1';
const DB_NAME = 'pixsz';
const DB_VERSION = 1;

/* One worker serves both halves of the site, because two registrations cannot
   share a scope. Only the public gallery is precached: it is what visitors
   land on, and precaching the studio would make every visitor download an
   uploader they will never open. Studio assets are still cached, just on first
   use by the runtime handler below. */
const SHELL = [
  './',
  './index.html',
  './css/gallery.css',
  './js/gallery.js',
  './manifest.webmanifest',
  './assets/icon-192.png',
  './assets/apple-touch-icon.png',
];

/* Display variants only. Originals are large, rarely opened, and would evict
   everything else; the browser's own cache can handle those. */
const CACHEABLE_PHOTO = /-w\d+\.(jpe?g|webp|avif)$/i;
const PHOTO_CACHE_LIMIT = 120;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // addAll is all-or-nothing; one 404 would leave the app with no offline
    // shell at all, so tolerate individual misses.
    await Promise.all(SHELL.map(path => cache.add(path).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // The photo cache is keyed by URL and photo URLs are immutable, so it
    // survives shell version bumps rather than being re-downloaded.
    await Promise.all(keys
      .filter(k => k !== VERSION && k !== PHOTOS)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/** Oldest-first eviction. Cache.keys() preserves insertion order. */
async function trimPhotoCache() {
  const cache = await caches.open(PHOTOS);
  const keys = await cache.keys();
  if (keys.length <= PHOTO_CACHE_LIMIT) return;
  await Promise.all(keys.slice(0, keys.length - PHOTO_CACHE_LIMIT).map(k => cache.delete(k)));
}

/* Cache-first: a photo at a given URL never changes its bytes — the studio
   writes a new date-stamped filename for every upload — so there is nothing to
   revalidate and a cache hit can be served without touching the network. */
async function servePhoto(request) {
  const cache = await caches.open(PHOTOS);
  const hit = await cache.match(request);
  if (hit) return hit;

  const res = await fetch(request);
  if (res && res.ok && res.type === 'basic') {
    await cache.put(request, res.clone());
    trimPhotoCache().catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(event));
    return;
  }

  if (request.method !== 'GET') return;

  // Never touch api.github.com or raw.githubusercontent.com: credentialed,
  // and the studio's real offline store is IndexedDB.
  if (url.origin !== self.location.origin) return;

  if (CACHEABLE_PHOTO.test(url.pathname)) {
    event.respondWith(servePhoto(request).catch(() => caches.match(request)));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        // Offline: fall back to the requested page, then to the gallery.
        return (await caches.match(request, { ignoreSearch: true }))
          || (await caches.match('./studio.html', { ignoreSearch: true }))
          || (await caches.match('./index.html', { ignoreSearch: true }))
          || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    const network = fetch(request).then(res => {
      if (res && res.ok && res.type === 'basic') {
        caches.open(VERSION).then(c => c.put(request, res.clone()));
      }
      return res;
    }).catch(() => null);
    return cached || network || new Response('', { status: 504 });
  })());
});

/* --------------------------------------------------------- share target */

async function handleShare(event) {
  const redirect = new URL('./studio.html?shared=1', self.registration.scope);
  try {
    const form = await event.request.formData();
    const files = [
      ...form.getAll('photos'),
      ...form.getAll('photo'),
      ...form.getAll('file'),
    ].filter(f => f && typeof f === 'object' && f.size > 0);

    if (files.length) await stash(files);
  } catch (err) {
    // Nothing useful to show from here; the page just opens empty-handed.
    console.warn('Share import failed', err);
  }
  return Response.redirect(redirect.href, 303);
}

function stash(files) {
  return new Promise((resolve, reject) => {
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
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('inbox', 'readwrite');
      tx.objectStore('inbox').add({ files, at: Date.now() });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}
