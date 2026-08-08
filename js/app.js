import * as db from './db.js';
import { processImage, makeThumb, formatBytes } from './imaging.js';
import { GitHubStore, buildPath } from './github.js';
import * as settingsStore from './settings.js';
import { zip } from './zip.js';

const VERSION = '1.1.0';
const $ = id => document.getElementById(id);

const el = {
  grid: $('grid'), gridEnd: $('gridEnd'), empty: $('empty'),
  queue: $('queue'), queueTitle: $('queueTitle'), queueBar: $('queueBar'),
  queueErrors: $('queueErrors'), queueClear: $('queueClear'),
  syncPill: $('syncPill'), syncText: $('syncText'),
  filePick: $('filePick'), cameraPick: $('cameraPick'),
  dropzone: $('dropzone'), toast: $('toast'),
  sheet: $('sheet'), sheetScrim: $('sheetScrim'),
  lightbox: $('lightbox'), lbTrack: $('lbTrack'), lbIndex: $('lbIndex'), lbMeta: $('lbMeta'),
  lbTitle: $('lbTitle'), lbCaption: $('lbCaption'), lbEdit: document.querySelector('.lb-edit'),
  selbar: $('selbar'), selCount: $('selCount'),
};

/** Where the public build reads titles and captions from. */
const INDEX_PATH = 'data/photos.json';

const state = {
  settings: settingsStore.load(),
  photos: [],
  store: null,
  selecting: false,
  selected: new Set(),
  queue: [],
  working: false,
  done: 0,
  total: 0,
  errors: [],
  removedPaths: new Set(),
  lb: { open: false, index: 0 },
};

/* Object URLs are handed out per photo and revoked when the photo goes away;
   full-size remote blobs are memory-cached with a small cap so paging through a
   large gallery doesn't refetch every swipe. */
const urls = new Map();
const fullCache = new Map();
const FULL_CACHE_MAX = 12;

/* ------------------------------------------------------------------ boot */

async function boot() {
  rebuildStore();
  wireEvents();
  applySettingsToForm();

  state.photos = await db.all();
  render();
  updateSyncPill();
  updateStorageInfo();
  $('verLabel').textContent = `v${VERSION}`;

  await drainShareInbox();
  wireFileHandler();

  if (state.store && state.store.configured) {
    pullRemote({ quiet: true })
      .then(loadIndex)
      .catch(err => console.warn('Initial sync skipped:', err));
    resumePending();
  }

  registerServiceWorker();
}

function rebuildStore() {
  const gh = state.settings.gh;
  state.store = gh.token && gh.owner && gh.repo ? new GitHubStore(gh) : null;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Scope is the directory the app is served from, which makes this work
  // unchanged at user.github.io/repo/ as well as at a custom domain root.
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
}

/* ------------------------------------------------------- adding photos */

async function addFiles(fileList) {
  const files = Array.from(fileList).filter(f => f && f.type.startsWith('image/'));
  const rejected = fileList.length - files.length;
  if (rejected > 0) toast(`Skipped ${rejected} non-image file${rejected > 1 ? 's' : ''}`);
  if (!files.length) return;

  state.total += files.length;
  showQueue();

  for (const file of files) {
    try {
      const opts = {
        resize: state.settings.resize,
        maxEdge: state.settings.maxEdge,
        quality: state.settings.quality / 100,
      };
      const out = await processImage(file, opts);

      const photo = {
        id: crypto.randomUUID(),
        name: file.name || 'photo.jpg',
        createdAt: file.lastModified || Date.now(),
        addedAt: Date.now(),
        width: out.width,
        height: out.height,
        size: out.blob.size,
        type: out.type,
        blob: out.blob,
        thumb: out.thumb,
        status: state.store ? 'queued' : 'local',
        path: null,
        sha: null,
        error: null,
        remote: false,
      };

      await db.put(photo);
      state.photos.unshift(photo);
      state.photos.sort((a, b) => b.createdAt - a.createdAt);
      render();

      if (state.store) enqueue(photo.id);
    } catch (err) {
      state.errors.push(err.message || String(err));
    } finally {
      state.done++;
      updateQueue();
    }
  }

  // Give the browser a beat to paint the last thumbnail before the bar vanishes.
  updateQueue();
  updateStorageInfo();
}

/* ------------------------------------------------------- upload queue */

function enqueue(id) {
  if (!state.queue.includes(id)) state.queue.push(id);
  runQueue();
}

async function resumePending() {
  const pending = state.photos.filter(p => p.blob && p.status !== 'synced' && !p.remote);
  if (!pending.length) return;
  pending.forEach(p => enqueue(p.id));
}

async function runQueue() {
  if (state.working || !state.queue.length) return;
  if (!state.store) return;

  state.working = true;
  showQueue();

  while (state.queue.length) {
    const id = state.queue.shift();
    const photo = state.photos.find(p => p.id === id) || await db.get(id);
    if (!photo || !photo.blob) continue;

    await setStatus(photo, 'uploading');
    updateQueue();

    try {
      const path = photo.path || buildPath(state.store.dir, photo.name, new Date(photo.createdAt));
      const res = await state.store.upload(path, photo.blob, `Add photo ${path.split('/').pop()}`);
      photo.path = res.path;
      photo.sha = res.sha;
      photo.error = null;
      await setStatus(photo, 'synced');
    } catch (err) {
      photo.error = err.message || String(err);
      await setStatus(photo, 'error');
      state.errors.push(`${photo.name}: ${photo.error}`);
      // A dead token or an exhausted rate limit will fail every remaining item
      // the same way, so stop rather than hammering the API.
      if (err.status === 401 || err.status === 403) {
        state.queue.length = 0;
        toast(photo.error);
      }
    }
    updateQueue();
  }

  state.working = false;
  updateQueue();
  updateSyncPill();
  // New uploads need index entries even before they're captioned — the build
  // uses them for dimensions and dates.
  if (state.photos.some(p => p.path)) markIndexDirty();
}

async function setStatus(photo, status) {
  photo.status = status;
  await db.put(photo);
  const cell = el.grid.querySelector(`[data-id="${photo.id}"]`);
  if (cell) cell.dataset.status = status;
  updateSyncPill();
}

/* ------------------------------------------------ pulling from GitHub */

async function pullRemote({ quiet = false } = {}) {
  if (!state.store || !state.store.configured) {
    if (!quiet) ghStatus('Add a token, owner and repo first', 'err');
    return;
  }

  if (!quiet) ghStatus('Loading…');
  const { files, truncated } = await state.store.list();

  const known = new Set(state.photos.filter(p => p.path).map(p => p.path));
  const fresh = files.filter(f => !known.has(f.path));

  if (fresh.length) {
    const rows = fresh.map(f => ({
      id: crypto.randomUUID(),
      name: f.path.split('/').pop(),
      createdAt: dateFromPath(f.path),
      addedAt: Date.now(),
      width: 0, height: 0,
      size: f.size || 0,
      type: 'image/jpeg',
      blob: null,
      thumb: null,
      status: 'synced',
      path: f.path,
      sha: f.sha,
      error: null,
      remote: true,
    }));
    await db.putMany(rows);
    state.photos = state.photos.concat(rows).sort((a, b) => b.createdAt - a.createdAt);
    render();
  }

  if (!quiet) {
    ghStatus(
      fresh.length
        ? `Found ${fresh.length} new photo${fresh.length > 1 ? 's' : ''} in the repo`
        : 'Already up to date',
      'ok',
    );
  }
  if (truncated) toast('Repo has more files than one listing can return — showing the first batch');
  updateStorageInfo();
}

/** Photos we uploaded carry the date in the filename; fall back to the folder. */
function dateFromPath(path) {
  const name = path.split('/').pop();
  const stamp = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (stamp) {
    const [, y, mo, d, h, mi, s] = stamp;
    return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  }
  const folder = path.match(/(\d{4})\/(\d{2})\//);
  if (folder) return new Date(+folder[1], +folder[2] - 1, 1).getTime();
  return 0;
}

/* ------------------------------------------- caption index (data/photos.json) */

let indexTimer = null;

/** Titles and captions are what the public build turns into alt text, so every
    edit has to reach the repo. Debounced: typing a caption shouldn't commit
    once per keystroke. */
function markIndexDirty() {
  if (!state.store) return;
  clearTimeout(indexTimer);
  indexTimer = setTimeout(() => {
    syncIndex().catch(err => {
      console.warn('Index sync failed', err);
      toast(`Captions not saved: ${err.message}`);
    });
  }, 1500);
}

async function syncIndex() {
  if (!state.store || !state.store.configured) return;

  const local = new Map();
  for (const photo of state.photos) {
    if (!photo.path) continue;
    local.set(photo.path, {
      path: photo.path,
      title: (photo.title || '').trim(),
      caption: (photo.caption || '').trim(),
      width: photo.width || 0,
      height: photo.height || 0,
      bytes: photo.size || 0,
      takenAt: new Date(photo.createdAt || Date.now()).toISOString(),
    });
  }

  await state.store.writeJson(INDEX_PATH, remote => {
    // Start from whatever is in the repo so captions written on another device
    // survive, then let this device's edits win for the photos it knows about.
    const merged = new Map((remote && remote.photos ? remote.photos : []).map(p => [p.path, p]));
    for (const [path, entry] of local) merged.set(path, entry);
    for (const path of state.removedPaths) merged.delete(path);

    return {
      updatedAt: new Date().toISOString(),
      photos: [...merged.values()].sort((a, b) => (b.takenAt || '').localeCompare(a.takenAt || '')),
    };
  }, 'Update photo captions');

  state.removedPaths.clear();
}

/** Pulls titles/captions down so they show on a device that didn't write them. */
async function loadIndex() {
  if (!state.store || !state.store.configured) return;
  const { data } = await state.store.readJson(INDEX_PATH);
  if (!data || !data.photos) return;

  const meta = new Map(data.photos.map(p => [p.path, p]));
  let touched = 0;
  for (const photo of state.photos) {
    const entry = photo.path && meta.get(photo.path);
    if (!entry) continue;
    if (photo.title !== entry.title || photo.caption !== entry.caption) {
      photo.title = entry.title || '';
      photo.caption = entry.caption || '';
      await db.put(photo);
      touched++;
    }
  }
  if (touched && state.lb.open) updateLightboxChrome();
}

/* ------------------------------------------------------------ deleting */

async function deletePhotos(ids) {
  const targets = ids.map(id => state.photos.find(p => p.id === id)).filter(Boolean);
  if (!targets.length) return;

  const remote = targets.filter(p => p.path && p.sha);
  const label = targets.length === 1 ? 'this photo' : `${targets.length} photos`;
  const note = remote.length && state.store
    ? `\n\n${remote.length} will also be deleted from the GitHub repo.`
    : '';
  if (!confirm(`Delete ${label}?${note}`)) return;

  let failed = 0;
  for (const photo of targets) {
    try {
      if (photo.path && photo.sha && state.store) {
        await state.store.remove(photo.path, photo.sha);
        state.removedPaths.add(photo.path);
      }
    } catch (err) {
      // Local removal still happens — leaving a ghost tile the user can't get
      // rid of is worse than a repo file they can delete on github.com.
      failed++;
      console.warn('Remote delete failed', photo.path, err);
    }
    await db.del(photo.id);
    releaseUrl(photo.id);
    fullCache.delete(photo.id);
  }

  const gone = new Set(targets.map(p => p.id));
  state.photos = state.photos.filter(p => !gone.has(p.id));
  exitSelection();
  render();
  updateStorageInfo();
  if (state.removedPaths.size) markIndexDirty();
  if (failed) toast(`Removed locally, but ${failed} could not be deleted from GitHub`);
}

/* ------------------------------------------------------------ rendering */

let observer = null;

function render() {
  const has = state.photos.length > 0;
  el.empty.hidden = has;
  el.gridEnd.hidden = !has;
  el.gridEnd.textContent = has
    ? `${state.photos.length} photo${state.photos.length > 1 ? 's' : ''}`
    : '';

  if (!observer) {
    observer = new IntersectionObserver(onVisible, { rootMargin: '400px 0px' });
  }

  const seen = new Set();
  const frag = document.createDocumentFragment();

  for (const photo of state.photos) {
    seen.add(photo.id);
    let cell = el.grid.querySelector(`[data-id="${photo.id}"]`);
    if (!cell) {
      cell = makeCell(photo);
      frag.appendChild(cell);
    } else {
      cell.dataset.status = photo.status;
    }
  }

  // Drop cells whose photo is gone, then append the new ones in order.
  for (const node of Array.from(el.grid.children)) {
    if (!seen.has(node.dataset.id)) {
      observer.unobserve(node);
      node.remove();
    }
  }
  el.grid.appendChild(frag);

  // Re-order in place when items arrive out of sequence (a repo pull, mostly).
  state.photos.forEach((photo, i) => {
    const node = el.grid.children[i];
    if (!node || node.dataset.id === photo.id) return;
    const wanted = el.grid.querySelector(`[data-id="${photo.id}"]`);
    if (wanted) el.grid.insertBefore(wanted, node);
  });

  Array.from(el.grid.children).forEach(node => observer.observe(node));
}

function makeCell(photo) {
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'cell';
  cell.dataset.id = photo.id;
  cell.dataset.status = photo.status;
  cell.setAttribute('role', 'listitem');
  cell.setAttribute('aria-selected', 'false');
  cell.innerHTML = `
    <img alt="${escapeHtml(photo.name)}" decoding="async" loading="lazy">
    <span class="badge" aria-hidden="true">
      <svg class="g-check" viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7"/></svg>
      <svg class="g-up" viewBox="0 0 24 24"><path d="M12 19V6m0 0-5 5m5-5 5 5"/></svg>
      <svg class="g-warn" viewBox="0 0 24 24"><path d="M12 6v8"/><circle cx="12" cy="18" r="1.2" fill="currentColor"/></svg>
    </span>
    <span class="check" aria-hidden="true"><span>
      <svg viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7"/></svg>
    </span></span>`;
  return cell;
}

function onVisible(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const cell = entry.target;
    if (cell.dataset.loaded) continue;
    cell.dataset.loaded = '1';
    loadThumb(cell).catch(() => { cell.dataset.loaded = ''; });
  }
}

async function loadThumb(cell) {
  const photo = state.photos.find(p => p.id === cell.dataset.id);
  const img = cell.querySelector('img');
  if (!photo || !img) return;

  let thumb = photo.thumb;

  if (!thumb && photo.path && state.store) {
    // Remote-only photo: fetch once, then keep the thumbnail locally so the
    // grid is instant (and works offline) from here on.
    const blob = await state.store.download({ path: photo.path, sha: photo.sha });
    const made = await makeThumb(blob);
    photo.thumb = made.thumb;
    photo.width = made.width;
    photo.height = made.height;
    photo.size = photo.size || blob.size;
    await db.put(photo);
    thumb = made.thumb;
  }

  if (!thumb) return;
  img.src = urlFor(photo.id, thumb);
  if (img.complete) img.classList.add('ready');
  else img.onload = () => img.classList.add('ready');
}

function urlFor(id, blob) {
  const existing = urls.get(id);
  if (existing) return existing;
  const url = URL.createObjectURL(blob);
  urls.set(id, url);
  return url;
}

function releaseUrl(id) {
  const url = urls.get(id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(id);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* --------------------------------------------------------- queue chrome */

function showQueue() {
  el.queue.hidden = false;
  updateQueue();
}

function updateQueue() {
  const uploading = state.photos.filter(p => p.status === 'uploading' || p.status === 'queued').length;
  const processing = state.total > state.done;

  if (!processing && !uploading && !state.errors.length) {
    el.queue.hidden = true;
    state.total = 0;
    state.done = 0;
    return;
  }

  el.queue.hidden = false;

  if (processing) {
    el.queueTitle.textContent = `Preparing ${state.done + 1} of ${state.total}…`;
    el.queueBar.style.width = `${Math.round((state.done / state.total) * 100)}%`;
  } else if (uploading) {
    const total = uploading + state.photos.filter(p => p.status === 'synced').length;
    el.queueTitle.textContent = `Uploading ${uploading} photo${uploading > 1 ? 's' : ''}…`;
    el.queueBar.style.width = `${Math.round(((total - uploading) / Math.max(1, total)) * 100)}%`;
  } else {
    el.queueTitle.textContent = state.errors.length
      ? `${state.errors.length} problem${state.errors.length > 1 ? 's' : ''}`
      : 'Done';
    el.queueBar.style.width = '100%';
  }

  el.queueErrors.innerHTML = '';
  state.errors.slice(-4).forEach(msg => {
    const li = document.createElement('li');
    li.textContent = msg;
    el.queueErrors.appendChild(li);
  });
}

function updateSyncPill() {
  const pill = el.syncPill;
  if (!state.store) {
    pill.dataset.state = '';
    el.syncText.textContent = 'On device';
    return;
  }
  const pending = state.photos.filter(p => p.status === 'queued' || p.status === 'uploading').length;
  const failed = state.photos.filter(p => p.status === 'error').length;

  if (pending) {
    pill.dataset.state = 'busy';
    el.syncText.textContent = `Syncing ${pending}`;
  } else if (failed) {
    pill.dataset.state = 'err';
    el.syncText.textContent = `${failed} failed`;
  } else {
    pill.dataset.state = 'ok';
    el.syncText.textContent = 'Synced';
  }
}

let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4200);
}

/* ------------------------------------------------------------ selection */

function enterSelection(id) {
  state.selecting = true;
  state.selected.clear();
  if (id) state.selected.add(id);
  document.body.classList.add('selecting');
  el.selbar.hidden = false;
  syncSelectionUI();
}

function exitSelection() {
  state.selecting = false;
  state.selected.clear();
  document.body.classList.remove('selecting');
  el.selbar.hidden = true;
  el.grid.querySelectorAll('[aria-selected="true"]')
    .forEach(n => n.setAttribute('aria-selected', 'false'));
  $('btnSelect').setAttribute('aria-pressed', 'false');
}

function toggleSelected(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  syncSelectionUI();
}

function syncSelectionUI() {
  el.selCount.textContent = `${state.selected.size} selected`;
  $('selDelete').disabled = state.selected.size === 0;
  $('btnSelect').setAttribute('aria-pressed', String(state.selecting));
  Array.from(el.grid.children).forEach(node => {
    node.setAttribute('aria-selected', String(state.selected.has(node.dataset.id)));
  });
}

/* ------------------------------------------------------------ lightbox */

async function openLightbox(index) {
  state.lb = { open: true, index };
  el.lightbox.hidden = false;
  document.body.classList.add('no-scroll');
  buildSlides();
  await paintSlides();
  updateLightboxChrome();
}

function closeLightbox() {
  state.lb.open = false;
  el.lightbox.hidden = true;
  document.body.classList.remove('no-scroll');
  el.lbTrack.innerHTML = '';
}

function buildSlides() {
  el.lbTrack.innerHTML = '';
  state.photos.forEach(photo => {
    const slide = document.createElement('div');
    slide.className = 'lb-slide';
    slide.dataset.id = photo.id;
    slide.innerHTML = '<div class="spinner"></div>';
    el.lbTrack.appendChild(slide);
  });
  positionTrack(0, false);
}

function positionTrack(dragPx, animate = true) {
  el.lbTrack.style.transition = animate ? 'transform .26s cubic-bezier(.22,1,.36,1)' : 'none';
  el.lbTrack.style.transform = `translate3d(calc(${-state.lb.index * 100}% + ${dragPx}px), 0, 0)`;
}

/** Loads the current slide plus its immediate neighbours. */
async function paintSlides() {
  const { index } = state.lb;
  for (const i of [index, index + 1, index - 1]) {
    if (i < 0 || i >= state.photos.length) continue;
    const photo = state.photos[i];
    const slide = el.lbTrack.children[i];
    if (!slide || slide.dataset.loaded) continue;
    slide.dataset.loaded = '1';
    try {
      const blob = await fullBlob(photo);
      if (!blob) { slide.innerHTML = '<div class="lb-meta">Unavailable offline</div>'; continue; }
      const img = new Image();
      img.decoding = 'async';
      img.draggable = false;
      img.alt = photo.name;
      img.src = URL.createObjectURL(blob);
      img.onload = () => URL.revokeObjectURL(img.src);
      slide.innerHTML = '';
      slide.appendChild(img);
    } catch (err) {
      slide.dataset.loaded = '';
      slide.innerHTML = `<div class="lb-meta">${escapeHtml(err.message || 'Could not load')}</div>`;
    }
  }
}

async function fullBlob(photo) {
  if (photo.blob) return photo.blob;
  if (fullCache.has(photo.id)) return fullCache.get(photo.id);
  if (!photo.path || !state.store) return photo.thumb || null;

  const blob = await state.store.download({ path: photo.path, sha: photo.sha });
  fullCache.set(photo.id, blob);
  if (fullCache.size > FULL_CACHE_MAX) fullCache.delete(fullCache.keys().next().value);
  return blob;
}

function updateLightboxChrome() {
  const photo = state.photos[state.lb.index];
  if (!photo) return;
  el.lbIndex.textContent = `${state.lb.index + 1} / ${state.photos.length}`;

  // Captions only reach the public page through the repo index, so there's
  // nothing to edit until a photo has actually been uploaded.
  el.lbEdit.hidden = !photo.path;
  el.lbTitle.value = photo.title || '';
  el.lbCaption.value = photo.caption || '';

  const bits = [
    photo.createdAt ? new Date(photo.createdAt).toLocaleString() : null,
    photo.width ? `${photo.width}×${photo.height}` : null,
    photo.size ? formatBytes(photo.size) : null,
    photo.status === 'synced' ? 'in repo' : photo.status === 'error' ? 'not uploaded' : null,
  ].filter(Boolean);
  el.lbMeta.textContent = bits.join(' · ');
}

/** Commits whatever is in the caption fields to the photo currently shown. */
async function saveCaption() {
  const photo = state.photos[state.lb.index];
  if (!photo || el.lbEdit.hidden) return;

  const title = el.lbTitle.value.trim();
  const caption = el.lbCaption.value.trim();
  if ((photo.title || '') === title && (photo.caption || '') === caption) return;

  photo.title = title;
  photo.caption = caption;
  await db.put(photo);
  markIndexDirty();
}

function goTo(index) {
  const next = Math.max(0, Math.min(state.photos.length - 1, index));
  if (next === state.lb.index) { positionTrack(0); return; }

  // Save before the index moves, or the edit lands on the wrong photo.
  saveCaption().catch(err => console.warn('Caption save failed', err));
  state.lb.index = next;
  positionTrack(0);
  paintSlides();
  updateLightboxChrome();
}

function wireLightboxGestures() {
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let horizontal = null;

  el.lbTrack.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    horizontal = null;
    startX = e.clientX;
    startY = e.clientY;
    el.lbTrack.setPointerCapture(e.pointerId);
  });

  el.lbTrack.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    // Decide once whether this gesture is a swipe or a vertical dismiss, so the
    // image doesn't jitter between the two.
    if (horizontal === null && Math.abs(dx) + Math.abs(dy) > 8) {
      horizontal = Math.abs(dx) > Math.abs(dy);
    }
    if (horizontal) positionTrack(dx, false);
  });

  const end = e => {
    if (!dragging) return;
    dragging = false;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (horizontal) {
      const threshold = Math.min(90, window.innerWidth * 0.22);
      if (dx < -threshold) goTo(state.lb.index + 1);
      else if (dx > threshold) goTo(state.lb.index - 1);
      else positionTrack(0);
    } else if (Math.abs(dy) > 110) {
      closeLightbox();
    } else if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
      // A clean tap toggles nothing destructive; treat it as "next" only on the
      // right third, matching how phone galleries behave.
      const third = window.innerWidth / 3;
      if (e.clientX > third * 2) goTo(state.lb.index + 1);
      else if (e.clientX < third) goTo(state.lb.index - 1);
    }
  };

  el.lbTrack.addEventListener('pointerup', end);
  el.lbTrack.addEventListener('pointercancel', () => { dragging = false; positionTrack(0); });
}

/* ------------------------------------------------------------- settings */

function applySettingsToForm() {
  const s = state.settings;
  $('setResize').checked = s.resize;
  $('setMaxEdge').value = s.maxEdge;
  $('setMaxEdgeLabel').textContent = `${s.maxEdge} px`;
  $('setQuality').value = s.quality;
  $('setQualityLabel').textContent = `${s.quality}%`;
  $('setMaxEdge').disabled = !s.resize;
  $('setQuality').disabled = !s.resize;

  $('ghToken').value = s.gh.token;
  $('ghOwner').value = s.gh.owner;
  $('ghRepo').value = s.gh.repo;
  $('ghBranch').value = s.gh.branch;
  $('ghDir').value = s.gh.dir;
  $('ghTag').dataset.on = state.store ? '1' : '0';
  $('ghTag').textContent = state.store ? 'on' : 'off';
}

function readGhForm() {
  return {
    token: $('ghToken').value.trim(),
    owner: $('ghOwner').value.trim().replace(/^https?:\/\/github\.com\//, ''),
    repo: $('ghRepo').value.trim(),
    branch: $('ghBranch').value.trim() || 'main',
    dir: $('ghDir').value.trim() || 'photos',
    isPrivate: state.settings.gh.isPrivate,
  };
}

function ghStatus(message, kind = '') {
  const node = $('ghStatus');
  node.textContent = message;
  node.dataset.kind = kind;
}

async function testAndSave() {
  const gh = readGhForm();
  if (!gh.token || !gh.owner || !gh.repo) {
    ghStatus('Token, owner and repo are all required', 'err');
    return;
  }

  ghStatus('Checking…');
  const probe = new GitHubStore(gh);
  try {
    const repo = await probe.verify();
    state.settings.gh = { ...gh, branch: probe.branch, isPrivate: probe.isPrivate };
    settingsStore.save(state.settings);
    rebuildStore();
    applySettingsToForm();
    updateSyncPill();
    ghStatus(`Connected to ${repo.full_name} (${repo.private ? 'private' : 'public'})`, 'ok');
    resumePending();
    loadIndex().catch(err => console.warn('Caption load failed', err));
  } catch (err) {
    ghStatus(err.message || 'Could not connect', 'err');
  }
}

function forgetToken() {
  if (!confirm('Remove the GitHub token from this browser? Photos already in the repo stay there.')) return;
  settingsStore.clearToken(state.settings);
  rebuildStore();
  applySettingsToForm();
  updateSyncPill();
  ghStatus('Token removed from this device', 'ok');
}

async function updateStorageInfo() {
  const local = state.photos.filter(p => p.blob).length;
  const remoteOnly = state.photos.length - local;
  let quota = '';
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage, quota: q } = await navigator.storage.estimate();
      if (usage != null && q) quota = ` · using ${formatBytes(usage)} of about ${formatBytes(q)}`;
    } catch { /* not available everywhere */ }
  }
  $('storageInfo').textContent =
    `${local} photo${local === 1 ? '' : 's'} stored on this device`
    + (remoteOnly ? `, ${remoteOnly} loaded from the repo` : '')
    + quota;
}

async function exportAll() {
  if (!state.photos.length) return;
  const btn = $('btnExport');
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const entries = [];
    for (const photo of state.photos) {
      const blob = await fullBlob(photo);
      if (!blob) continue;
      const stamp = new Date(photo.createdAt || Date.now());
      entries.push({ name: uniqueName(entries, photo, blob, stamp), blob, date: stamp });
    }
    const bundle = await zip(entries);
    saveBlob(bundle, `pixsz-${new Date().toISOString().slice(0, 10)}.zip`);
  } catch (err) {
    toast(err.message || 'Export failed');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download all';
  }
}

const EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/avif': 'avif',
};

/** Names a download after the bytes we actually hold, not the file that was
    picked — resizing re-encodes to JPEG, so a source .png would otherwise be
    saved with an extension that lies about its contents. */
function downloadName(photo, blob) {
  const ext = EXTENSIONS[blob && blob.type] || EXTENSIONS[photo.type] || 'jpg';
  const stem = (photo.name || 'photo')
    .replace(/[/\\]/g, '_')
    .replace(/\.[^.]+$/, '')
    .slice(0, 60) || 'photo';
  return `${stem}.${ext}`;
}

function uniqueName(entries, photo, blob, date) {
  const p = n => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;

  const base = `${stamp}-${downloadName(photo, blob)}`;
  const taken = new Set(entries.map(e => e.name));
  let name = base;
  let n = 1;
  while (taken.has(name)) name = base.replace(/(\.\w+)$/, `-${n++}$1`);
  return name;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function wipeLocal() {
  if (!confirm('Delete all photos stored on this device?\n\nAnything already uploaded stays in your GitHub repo and can be loaded again.')) return;
  await db.clearPhotos();
  state.photos.forEach(p => releaseUrl(p.id));
  state.photos = [];
  fullCache.clear();
  render();
  updateStorageInfo();
  updateSyncPill();
  toast('Local photos deleted');
}

/* ------------------------------------------------------- share target */

async function drainShareInbox() {
  let items = [];
  try {
    items = await db.takeInbox();
  } catch { return; }
  if (!items.length) return;

  const files = items.flatMap(item => item.files || []);
  if (files.length) {
    toast(`Importing ${files.length} shared photo${files.length > 1 ? 's' : ''}…`);
    await addFiles(files);
  }

  if (location.search) history.replaceState(null, '', location.pathname);
}

/** Backs the manifest's file_handlers entry: "Open with pixsz" from the OS. */
function wireFileHandler() {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async launch => {
    if (!launch || !launch.files || !launch.files.length) return;
    const files = await Promise.all(launch.files.map(handle => handle.getFile()));
    await addFiles(files);
  });
}

/* --------------------------------------------------------------- events */

function wireEvents() {
  el.filePick.addEventListener('change', async e => {
    await addFiles(e.target.files);
    e.target.value = '';
  });

  el.cameraPick.addEventListener('change', async e => {
    await addFiles(e.target.files);
    e.target.value = '';
  });

  el.syncPill.addEventListener('click', openSheet);
  $('btnSettings').addEventListener('click', openSheet);
  $('sheetClose').addEventListener('click', closeSheet);
  el.sheetScrim.addEventListener('click', closeSheet);

  $('btnSelect').addEventListener('click', () => {
    if (state.selecting) exitSelection();
    else enterSelection();
  });
  $('selCancel').addEventListener('click', exitSelection);
  $('selAll').addEventListener('click', () => {
    if (state.selected.size === state.photos.length) state.selected.clear();
    else state.photos.forEach(p => state.selected.add(p.id));
    syncSelectionUI();
  });
  $('selDelete').addEventListener('click', () => deletePhotos(Array.from(state.selected)));

  el.queueClear.addEventListener('click', () => {
    state.errors = [];
    state.total = 0;
    state.done = 0;
    updateQueue();
  });

  wireGridInput();
  wireLightboxGestures();

  el.lbTitle.addEventListener('change', saveCaption);
  el.lbCaption.addEventListener('change', saveCaption);
  el.lbTitle.addEventListener('blur', saveCaption);
  el.lbCaption.addEventListener('blur', saveCaption);
  // Keep the swipe handler out of the text fields.
  [el.lbTitle, el.lbCaption].forEach(node => {
    node.addEventListener('pointerdown', e => e.stopPropagation());
  });

  $('lbClose').addEventListener('click', async () => { await saveCaption(); closeLightbox(); });
  $('lbDelete').addEventListener('click', async () => {
    const photo = state.photos[state.lb.index];
    if (!photo) return;
    const at = state.lb.index;
    await deletePhotos([photo.id]);
    if (!state.photos.length) closeLightbox();
    else { buildSlides(); goTo(Math.min(at, state.photos.length - 1)); }
  });
  $('lbDownload').addEventListener('click', async () => {
    const photo = state.photos[state.lb.index];
    const blob = await fullBlob(photo);
    if (blob) saveBlob(blob, downloadName(photo, blob));
  });
  $('lbShare').addEventListener('click', async () => {
    const photo = state.photos[state.lb.index];
    const blob = await fullBlob(photo);
    if (!blob) return;
    const name = downloadName(photo, blob);
    const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch { /* user dismissed */ }
    } else {
      saveBlob(blob, name);
    }
  });

  document.addEventListener('keydown', e => {
    if (state.lb.open) {
      if (e.key === 'Escape') { saveCaption(); closeLightbox(); }
      if (e.key === 'ArrowRight') goTo(state.lb.index + 1);
      if (e.key === 'ArrowLeft') goTo(state.lb.index - 1);
      return;
    }
    if (e.key === 'Escape') {
      if (!el.sheet.hidden) closeSheet();
      else if (state.selecting) exitSelection();
    }
  });

  // Settings controls
  $('setResize').addEventListener('change', e => {
    state.settings.resize = e.target.checked;
    $('setMaxEdge').disabled = !e.target.checked;
    $('setQuality').disabled = !e.target.checked;
    settingsStore.save(state.settings);
  });
  $('setMaxEdge').addEventListener('input', e => {
    state.settings.maxEdge = Number(e.target.value);
    $('setMaxEdgeLabel').textContent = `${e.target.value} px`;
  });
  $('setMaxEdge').addEventListener('change', () => settingsStore.save(state.settings));
  $('setQuality').addEventListener('input', e => {
    state.settings.quality = Number(e.target.value);
    $('setQualityLabel').textContent = `${e.target.value}%`;
  });
  $('setQuality').addEventListener('change', () => settingsStore.save(state.settings));

  $('ghTest').addEventListener('click', testAndSave);
  $('ghPull').addEventListener('click', () => pullRemote()
    .then(loadIndex)
    .catch(err => ghStatus(err.message, 'err')));
  $('ghForget').addEventListener('click', forgetToken);
  $('btnExport').addEventListener('click', exportAll);
  $('btnWipe').addEventListener('click', wipeLocal);

  wireDragDrop();
  wirePasteAndOnline();
}

function wireGridInput() {
  const SLOP = 10;   // px of finger drift still counted as a press, not a scroll
  let pressTimer = null;
  let startX = 0;
  let startY = 0;
  // Set when the long-press timer actually fires. The click that follows must
  // be swallowed, or it would immediately toggle off what the press selected —
  // and a movement-based test can't stand in for this, because a real finger
  // always drifts a pixel or two.
  let longPressed = false;

  const cancel = () => { clearTimeout(pressTimer); pressTimer = null; };

  el.grid.addEventListener('pointerdown', e => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    startX = e.clientX;
    startY = e.clientY;
    longPressed = false;
    cancel();

    // Long-press is the standard phone gesture for entering multi-select.
    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (state.selecting) return;
      longPressed = true;
      enterSelection(cell.dataset.id);
      if (navigator.vibrate) navigator.vibrate(12);
    }, 450);
  });

  el.grid.addEventListener('pointermove', e => {
    if (!pressTimer) return;
    if (Math.abs(e.clientX - startX) > SLOP || Math.abs(e.clientY - startY) > SLOP) cancel();
  });

  el.grid.addEventListener('pointerup', cancel);
  el.grid.addEventListener('pointercancel', cancel);
  window.addEventListener('scroll', cancel, { passive: true });

  el.grid.addEventListener('click', e => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    cancel();

    if (longPressed) {
      longPressed = false;
      return;
    }
    if (state.selecting) {
      toggleSelected(cell.dataset.id);
      return;
    }
    const index = state.photos.findIndex(p => p.id === cell.dataset.id);
    if (index >= 0) openLightbox(index);
  });
}

function wireDragDrop() {
  let depth = 0;
  const show = () => { el.dropzone.hidden = false; };
  const hide = () => { depth = 0; el.dropzone.hidden = true; };

  window.addEventListener('dragenter', e => {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
    depth++;
    show();
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('dragleave', () => { if (--depth <= 0) hide(); });
  window.addEventListener('drop', async e => {
    e.preventDefault();
    hide();
    if (e.dataTransfer.files.length) await addFiles(e.dataTransfer.files);
  });
}

function wirePasteAndOnline() {
  window.addEventListener('paste', e => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) addFiles(files);
  });

  window.addEventListener('online', () => {
    if (state.store) { resumePending(); toast('Back online — resuming uploads'); }
  });

  window.addEventListener('beforeunload', e => {
    if (state.working || state.queue.length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

function openSheet() {
  el.sheet.hidden = false;
  el.sheetScrim.hidden = false;
  document.body.classList.add('no-scroll');
  updateStorageInfo();
}

function closeSheet() {
  el.sheet.hidden = true;
  el.sheetScrim.hidden = true;
  document.body.classList.remove('no-scroll');
  ghStatus('');
}

boot().catch(err => {
  console.error(err);
  toast(`Startup failed: ${err.message}`);
});
