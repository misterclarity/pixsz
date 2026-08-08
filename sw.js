/* Service worker: offline app shell + Web Share Target.

   The share target is the reason this file does IndexedDB by hand — a shared
   photo arrives as a POST that the page never sees, so the worker has to stash
   the files somewhere the page can pick them up. Keep DB_NAME/DB_VERSION and
   the `inbox` store in step with js/db.js. */

const VERSION = 'pixsz-v2';
const DB_NAME = 'pixsz';
const DB_VERSION = 1;

const SHELL = [
  './',
  './index.html',
  './studio.html',
  './css/gallery.css',
  './css/styles.css',
  './js/app.js',
  './js/gallery.js',
  './js/db.js',
  './js/github.js',
  './js/imaging.js',
  './js/settings.js',
  './js/zip.js',
  './manifest.webmanifest',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png',
];

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
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(event));
    return;
  }

  if (request.method !== 'GET') return;

  // Photo bytes and API calls are never cached here: they're either huge,
  // credentialed, or both. IndexedDB is the app's real offline store.
  if (url.origin !== self.location.origin) return;

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
