/* Decode → orient → downscale → re-encode.

   Phone photos are the whole problem this module exists to solve: a modern
   handset shoots 12–48MP files of 3–10MB, which are slow to store, slow to
   render in a grid, and slow to push over a phone's uplink. We resize once on
   the device and keep a separate small thumbnail for the grid.

   Re-encoding through a canvas also drops EXIF, which means GPS coordinates
   and camera serials don't ride along into a repo. */

export const THUMB_EDGE = 512;

let canvas = null;

function scratch(w, h) {
  if (!canvas) canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/** Decode a file into something drawable, with EXIF rotation already applied. */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      // 'from-image' honours the EXIF orientation tag; without it, photos taken
      // in portrait come out sideways on some Android devices.
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (err) {
      // Safari <15 rejects the options bag rather than ignoring it.
      try {
        return await createImageBitmap(file);
      } catch { /* fall through to the <img> path */ }
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await (img.decode ? img.decode() : new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('decode failed'));
    }));
    return img;
  } finally {
    // Revoking immediately is safe: decode() has already rasterised the bitmap.
    URL.revokeObjectURL(url);
  }
}

function dimensions(src) {
  return {
    w: src.width || src.naturalWidth,
    h: src.height || src.naturalHeight,
  };
}

function encode(cv, type, quality) {
  return new Promise((resolve, reject) => {
    cv.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('Could not encode image')),
      type,
      quality,
    );
  });
}

function draw(src, w, h) {
  const cv = scratch(w, h);
  const ctx = cv.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return cv;
}

function fit(w, h, maxEdge) {
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { w, h, scaled: false };
  const k = maxEdge / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: true };
}

/**
 * @param {File|Blob} file
 * @param {{resize?: boolean, maxEdge?: number, quality?: number,
 *          widths?: number[], formats?: string[]}} opts
 * @returns {Promise<{blob: Blob, thumb: Blob, width: number, height: number,
 *                    type: string, variants: Array<object>}>}
 */
export async function processImage(file, opts = {}) {
  const {
    resize = true, maxEdge = 2048, quality = 0.82,
    widths = [], formats = ['jpeg'],
  } = opts;

  let src;
  try {
    src = await decode(file);
  } catch {
    // Chiefly HEIC/HEIF straight off an iPhone when the OS hands over the
    // original rather than a converted JPEG, and anything genuinely corrupt.
    throw new Error(`${file.name || 'This file'} isn't an image this browser can open`);
  }

  try {
    const { w, h } = dimensions(src);
    if (!w || !h) throw new Error('Image has no dimensions');

    const target = resize ? fit(w, h, maxEdge) : { w, h, scaled: false };

    // Nothing to gain from re-encoding a small JPEG at the same settings, but we
    // still do it when resizing is on so metadata stripping is consistent.
    const full = await encode(draw(src, target.w, target.h), 'image/jpeg', quality);

    const t = fit(target.w, target.h, THUMB_EDGE);
    const thumb = await encode(draw(src, t.w, t.h), 'image/jpeg', 0.72);

    // Display variants for the public gallery's srcset. Everything is drawn
    // from the one decoded bitmap, so extra widths cost an encode, not a
    // re-decode — which is the expensive half on a phone.
    const wanted = await usableFormats(formats);
    const variants = [];

    for (const width of [...new Set(widths)].sort((a, b) => a - b)) {
      const size = fitWidth(target.w, target.h, width);
      if (!size) continue;   // never upscale past what we're storing
      const canvas = draw(src, size.w, size.h);
      for (const format of wanted) {
        variants.push({
          width: size.w,
          height: size.h,
          format,
          blob: await encode(canvas, MIME[format], format === 'webp' ? quality * 0.95 : quality),
        });
      }
    }

    return {
      blob: full, thumb, width: target.w, height: target.h, type: 'image/jpeg', variants,
    };
  } finally {
    if (src.close) src.close();
  }
}

const MIME = { jpeg: 'image/jpeg', webp: 'image/webp' };

/** Scales to an exact width. srcset's `w` descriptor is a width, so variants
    have to be sized by width — `fit` constrains the longest edge, which gives
    the wrong descriptor for portrait photos. */
function fitWidth(w, h, targetW) {
  if (targetW >= w) return null;
  return { w: targetW, h: Math.max(1, Math.round((h * targetW) / w)) };
}

let webpSupport = null;

/** Safari only gained canvas WebP encoding in 14. Asking the canvas is the
    only reliable check — a browser that can *decode* WebP may not encode it. */
async function canEncodeWebp() {
  if (webpSupport !== null) return webpSupport;
  try {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const blob = await new Promise(res => probe.toBlob(res, 'image/webp', 0.5));
    webpSupport = Boolean(blob) && blob.type === 'image/webp';
  } catch {
    webpSupport = false;
  }
  return webpSupport;
}

async function usableFormats(formats) {
  const out = [];
  for (const format of formats) {
    if (!MIME[format]) continue;
    if (format === 'webp' && !(await canEncodeWebp())) continue;
    out.push(format);
  }
  // Always leave something behind, even on a browser that can only do JPEG.
  return out.length ? out : ['jpeg'];
}

/** Thumbnail-only path, used for photos pulled back down from GitHub. */
export async function makeThumb(blob) {
  const src = await decode(blob);
  try {
    const { w, h } = dimensions(src);
    const t = fit(w, h, THUMB_EDGE);
    return {
      thumb: await encode(draw(src, t.w, t.h), 'image/jpeg', 0.72),
      width: w,
      height: h,
    };
  } finally {
    if (src.close) src.close();
  }
}

export function formatBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
