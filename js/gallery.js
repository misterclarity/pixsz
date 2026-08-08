/* Public gallery behaviour.
 *
 * Strictly progressive enhancement: the page is complete without this file.
 * Every photo is already a real <img> inside a link to the full-size file, and
 * every download is a plain <a download>. This adds a viewer and a bulk
 * download on top — if the script fails, nothing a visitor needs is lost. */

import { zip } from './zip.js';

const $ = id => document.getElementById(id);

const shots = Array.from(document.querySelectorAll('.shot')).map(node => {
  const img = node.querySelector('img');
  const link = node.querySelector('.shot-link');
  return {
    node,
    url: link.getAttribute('href'),
    alt: img.getAttribute('alt') || '',
    title: (node.querySelector('.shot-title') || {}).textContent || '',
    caption: (node.querySelector('.shot-caption') || {}).textContent || '',
  };
});

const viewer = $('viewer');
const viewerImg = $('viewerImg');
const viewerCount = $('viewerCount');
const viewerCaption = $('viewerCaption');
const viewerDownload = $('viewerDownload');
const prevBtn = $('viewerPrev');
const nextBtn = $('viewerNext');

let index = 0;
let open = false;
let lastFocus = null;

/* ------------------------------------------------------------ viewer */

function show(i) {
  if (!shots.length) return;
  index = Math.max(0, Math.min(shots.length - 1, i));
  const shot = shots[index];

  viewerImg.src = shot.url;
  viewerImg.alt = shot.alt;
  viewerDownload.href = shot.url;
  viewerDownload.setAttribute('download', filenameOf(shot.url));
  viewerCount.textContent = `${index + 1} / ${shots.length}`;
  viewerCaption.textContent = [shot.title, shot.caption].filter(Boolean).join(' — ');
  prevBtn.disabled = index === 0;
  nextBtn.disabled = index === shots.length - 1;

  // Warm the neighbours so a swipe doesn't land on a blank frame.
  [index - 1, index + 1].forEach(n => {
    if (n >= 0 && n < shots.length) new Image().src = shots[n].url;
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

document.addEventListener('keydown', e => {
  if (!open) return;
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
    if (e.target.closest('button, a')) return;
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
  if (!match) {
    if (open) closeViewer();
    return;
  }
  const n = Number(match[1]) - 1;
  if (n < 0 || n >= shots.length) return;
  if (open) show(n);
  else openViewer(n);
}

window.addEventListener('hashchange', applyHash);
applyHash();

/* -------------------------------------------------------- download all */

let toastTimer = null;
function toast(message, ms = 4000) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, ms);
}

const allBtn = $('downloadAll');

if (!shots.length) {
  allBtn.disabled = true;
} else {
  allBtn.addEventListener('click', async () => {
    const label = allBtn.querySelector('span');
    const original = label.textContent;
    allBtn.disabled = true;

    try {
      const entries = [];
      let bytes = 0;

      for (let i = 0; i < shots.length; i++) {
        label.textContent = `Fetching ${i + 1} of ${shots.length}…`;
        const res = await fetch(shots[i].url);
        if (!res.ok) throw new Error(`Could not fetch ${filenameOf(shots[i].url)}`);
        const blob = await res.blob();
        bytes += blob.size;

        // Everything is held in memory to build the archive, so stop before a
        // phone browser gets killed rather than after.
        if (bytes > 600 * 1024 * 1024) {
          throw new Error('This gallery is too large to zip in the browser — download photos individually instead');
        }
        entries.push({ name: uniqueName(entries, filenameOf(shots[i].url)), blob });
      }

      label.textContent = 'Packing…';
      const bundle = await zip(entries);
      const url = URL.createObjectURL(bundle);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${document.title.split(' ')[0] || 'photos'}-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      toast(`Downloaded ${entries.length} photos`);
    } catch (err) {
      toast(err.message || 'Download failed', 6000);
    } finally {
      label.textContent = original;
      allBtn.disabled = false;
    }
  });
}

function uniqueName(entries, name) {
  const taken = new Set(entries.map(e => e.name));
  if (!taken.has(name)) return name;
  let n = 1;
  let candidate;
  do { candidate = name.replace(/(\.\w+)$/, `-${n++}$1`); } while (taken.has(candidate));
  return candidate;
}
