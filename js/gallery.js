/* Public gallery behaviour.
 *
 * Strictly progressive enhancement: the page is complete without this file.
 * Every photo is already a real <img> inside a link to the full-size file, and
 * every download is a plain <a download>. This adds a viewer on top — if the
 * script fails, nothing a visitor needs is lost. */

const $ = id => document.getElementById(id);

// Marks the page as script-enabled so CSS can fade images in. Without JS the
// rule never applies and images show immediately.
document.documentElement.classList.add('js');

const shots = Array.from(document.querySelectorAll('.shot')).map(node => {
  const img = node.querySelector('img');
  const link = node.querySelector('.shot-link');
  const source = type => {
    const el = node.querySelector(`picture source[type="${type}"]`);
    return el ? el.getAttribute('srcset') : '';
  };
  return {
    // The tile's own srcsets, reused by the viewer so a phone opens a
    // phone-sized file instead of the largest variant.
    webpSet: source('image/webp'),
    jpegSet: source('image/jpeg'),
    node,
    // The web-size file: what the viewer shows and what the free download gives.
    url: link.getAttribute('href'),
    // The original. Behind the supporter prompt, not behind access control.
    full: node.dataset.full || link.getAttribute('href'),
    fullWidth: Number(node.dataset.fullWidth) || 0,
    alt: img.getAttribute('alt') || '',
    title: node.dataset.title || '',
    caption: (node.querySelector('.shot-caption') || {}).textContent || '',
  };
});

const viewer = $('viewer');
const viewerImg = $('viewerImg');
const viewerCount = $('viewerCount');
const viewerCaption = $('viewerCaption');
const viewerDownload = $('viewerDownload');
const viewerWebp = $('viewerWebp');
const viewerJpeg = $('viewerJpeg');
const prevBtn = $('viewerPrev');
const nextBtn = $('viewerNext');

function setSource(node, srcset) {
  if (!node) return;
  if (srcset) node.setAttribute('srcset', srcset);
  else node.removeAttribute('srcset');
}

let index = 0;
let open = false;
let lastFocus = null;

/* ------------------------------------------------------------ viewer */

function show(i) {
  if (!shots.length) return;
  index = Math.max(0, Math.min(shots.length - 1, i));
  const shot = shots[index];

  // srcset before src, so the browser never starts the fallback request first.
  setSource(viewerWebp, shot.webpSet);
  setSource(viewerJpeg, shot.jpegSet);
  viewerImg.src = shot.url;
  viewerImg.alt = shot.alt;
  viewerDownload.href = shot.url;
  viewerDownload.setAttribute('download', filenameOf(shot.url));
  viewerCount.textContent = `${index + 1} / ${shots.length}`;
  viewerCaption.textContent = [shot.title, shot.caption].filter(Boolean).join(' — ');
  prevBtn.disabled = index === 0;
  nextBtn.disabled = index === shots.length - 1;

  // Warm the neighbours so a swipe doesn't land on a blank frame. Uses the
  // same srcset/sizes as the viewer so it warms the file that will actually
  // be displayed rather than the fallback.
  [index - 1, index + 1].forEach(n => {
    if (n < 0 || n >= shots.length) return;
    const warm = new Image();
    warm.sizes = '100vw';
    if (shots[n].webpSet || shots[n].jpegSet) warm.srcset = shots[n].webpSet || shots[n].jpegSet;
    warm.src = shots[n].url;
  });

  // Deep links: /#p3 addresses the third photo, and the back button closes.
  history.replaceState(null, '', `#p${index + 1}`);
}

function openViewer(i) {
  lastFocus = document.activeElement;
  open = true;
  viewer.hidden = false;
  document.body.classList.add('locked');
  show(i);
  $('viewerClose').focus();
}

function closeViewer() {
  open = false;
  viewer.hidden = true;
  document.body.classList.remove('locked');
  viewerImg.removeAttribute('src');
  history.replaceState(null, '', location.pathname + location.search);
  if (lastFocus) lastFocus.focus();
}

function filenameOf(url) {
  try {
    return decodeURIComponent(url.split('/').pop().split('?')[0]) || 'photo.jpg';
  } catch {
    return 'photo.jpg';
  }
}

shots.forEach((shot, i) => {
  shot.node.querySelector('.shot-link').addEventListener('click', e => {
    // Let modified clicks (new tab, save as) behave normally.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    openViewer(i);
  });
});

$('viewerClose').addEventListener('click', closeViewer);
prevBtn.addEventListener('click', () => show(index - 1));
nextBtn.addEventListener('click', () => show(index + 1));

function gateOpen() {
  return Boolean(gate) && !gate.hidden;
}

document.addEventListener('keydown', e => {
  if (!open) return;
  // The supporter prompt sits on top of the viewer. Without this guard a single
  // Escape dismisses both, dumping the visitor back to the grid when they only
  // meant to close the prompt.
  if (gateOpen()) return;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowRight') show(index + 1);
  else if (e.key === 'ArrowLeft') show(index - 1);
});

/* Swipe: horizontal pages, a decisive vertical drag dismisses. */
(function swipe() {
  let startX = 0;
  let startY = 0;
  let tracking = false;
  let axis = null;

  viewer.addEventListener('pointerdown', e => {
    if (e.target.closest('button, a') || gateOpen()) return;
    tracking = true;
    axis = null;
    startX = e.clientX;
    startY = e.clientY;
  });

  viewer.addEventListener('pointermove', e => {
    if (!tracking || axis !== null) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 10) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
  });

  const finish = e => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (axis === 'x' && Math.abs(dx) > Math.min(80, innerWidth * 0.2)) {
      show(index + (dx < 0 ? 1 : -1));
    } else if (axis === 'y' && Math.abs(dy) > 110) {
      closeViewer();
    }
  };

  viewer.addEventListener('pointerup', finish);
  viewer.addEventListener('pointercancel', () => { tracking = false; });
}());

/* Deep links. /#p4 is a shareable address for a single photo, so it has to work
   on a cold load *and* when the hash changes underneath us — someone pasting a
   link while already on the page, or using back/forward, is a fragment
   navigation that never re-runs this module. */
function applyHash() {
  const match = location.hash.match(/^#p(\d+)$/);
  const n = match ? Number(match[1]) - 1 : -1;

  // Anything that isn't a live photo index — no hash, or a link to a photo
  // that has since been removed — means "not viewing". Returning early here
  // instead would strand an open viewer over the page.
  if (n < 0 || n >= shots.length) {
    if (open) closeViewer();
    return;
  }

  if (open) show(n);
  else openViewer(n);
}

window.addEventListener('hashchange', applyHash);
applyHash();

/* ------------------------------------------------ placeholder fade-in */

/* Each tile carries a blurred 16px version of its own photo as a CSS
   background. Fading the real image in over it means a slow connection shows
   the picture's colours immediately instead of a grey rectangle. */
function lightUp(img) {
  if (img.complete && img.naturalWidth > 0) img.classList.add('lit');
  else img.addEventListener('load', () => img.classList.add('lit'), { once: true });
  // A broken image must not stay invisible behind the placeholder.
  img.addEventListener('error', () => img.classList.add('lit'), { once: true });
}

document.querySelectorAll('.shot img').forEach(lightUp);

/* ---------------------------------------------------- service worker */

/* GitHub Pages serves assets with a ten-minute cache lifetime and there is no
   way to configure that, so a visitor coming back an hour later re-downloads
   every photo. A cache-first worker for the display variants is the only lever
   available, and it makes repeat visits instant and offline-capable. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Caching is an optimisation; the gallery is complete without it.
    });
  });
}

/* --------------------------------------------- full-resolution prompt */

/* An honesty box, not a paywall. A static site cannot verify a payment and
   cannot hide a file that the CDN serves publicly, so this does not pretend to:
   the full-size URL sits in the markup as data-full, the bypass is a normal
   button the same size as the support one, and the copy says the download works
   either way. Anything else would be a dark pattern that buys nothing — the
   file is one devtools panel away regardless. */

const GATE_KEY = 'pixsz.supporter';
const gate = $('gate');
const gateScrim = $('gateScrim');
const gateEnabled = gate && gate.dataset.enabled === '1';
let gateReturnFocus = null;

function alreadySupported() {
  try {
    return localStorage.getItem(GATE_KEY) === '1';
  } catch {
    return false;   // private-mode Safari; just show the prompt again
  }
}

function rememberSupporter() {
  try {
    localStorage.setItem(GATE_KEY, '1');
  } catch { /* nothing to do — the prompt simply shows next time */ }
}

function startDownload(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function closeGate() {
  if (!gate) return;
  gate.hidden = true;
  gateScrim.hidden = true;
  document.body.classList.remove('locked');
  if (gateReturnFocus) gateReturnFocus.focus();
}

/** Offers the full-resolution file, asking for support first when configured. */
function requestFull(shot) {
  const name = filenameOf(shot.full);

  // Nothing to ask for, or they've already been through it once: hand it over.
  if (!gateEnabled || alreadySupported()) {
    startDownload(shot.full, name);
    return;
  }

  gateReturnFocus = document.activeElement;
  $('gateFile').textContent = shot.fullWidth
    ? `${shot.title || name} — ${shot.fullWidth}px wide`
    : (shot.title || name);

  const bypass = $('gateBypass');
  bypass.href = shot.full;
  bypass.setAttribute('download', name);

  gate.hidden = false;
  gateScrim.hidden = false;
  document.body.classList.add('locked');
  bypass.focus();
}

if (gate) {
  // Taking the download closes the prompt; the browser handles the <a download>
  // itself, so nothing here has to cancel or delay it.
  $('gateBypass').addEventListener('click', () => {
    closeGate();
    toast('Thanks for taking it — a coffee is always welcome if it earns its keep.');
  });

  // We cannot know whether a payment happened. Treating "went to Ko-fi" as
  // supported is the honest approximation, and it stops the prompt nagging
  // someone who has already given.
  $('gateSupport').addEventListener('click', () => {
    rememberSupporter();
    setTimeout(closeGate, 150);
  });

  $('gateClose').addEventListener('click', closeGate);
  gateScrim.addEventListener('click', closeGate);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !gate.hidden) closeGate();
  });
}

const fullBtn = $('viewerFull');
if (fullBtn) {
  fullBtn.addEventListener('click', () => {
    const shot = shots[index];
    if (shot) requestFull(shot);
  });
}

/* ------------------------------------------------- casual-copy friction */

/* What this does and doesn't do, so nobody is misled by it later:
   it stops a right-click "Save image as…", a drag-to-desktop, and a long-press
   save sheet on mobile. It does not stop anyone who opens devtools, reads the
   page source, or runs curl against the image URL — those are all still one
   step away, because the files are public static assets on a CDN and have to be
   for the page to render at all. Treat this as a "please don't", not a lock. */

let toastTimer = null;
function toast(message, ms = 3500) {
  const node = $('toast');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, ms);
}

document.addEventListener('contextmenu', e => {
  // Never swallow the menu inside text a visitor might legitimately copy, or
  // inside a form field.
  if (e.target.closest('input, textarea, [contenteditable]')) return;
  e.preventDefault();

  // A menu that silently fails to open reads as a broken page. Say what
  // happened and point at the button that does work.
  if (e.target.closest('img')) {
    toast('Right-click is off here — use the Download button under each photo.');
  }
});

document.addEventListener('dragstart', e => {
  if (e.target.closest('img')) e.preventDefault();
});
