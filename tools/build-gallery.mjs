#!/usr/bin/env node
/* Pre-renders the public gallery.
 *
 * This exists because the studio app builds its grid from IndexedDB at runtime,
 * which no crawler can see. Search engines need the photos present in the HTML
 * as real <img> elements with real alt text, so the gallery is generated here
 * and committed/deployed as static markup.
 *
 *   node tools/build-gallery.mjs
 *
 * Inputs   site.config.json, photos/**, data/photos.json (captions from studio)
 * Outputs  index.html, sitemap.xml, robots.txt, data/gallery.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE_RE = /\.(jpe?g|png|webp|avif|gif)$/i;

/* Display variants written by the studio: <stem>-w960.webp beside <stem>.jpg.
   They are not photos in their own right, so they never enter the photo list.
   Must stay in step with variantPath() in js/github.js. */
const VARIANT_RE = /-w(\d+)\.(jpe?g|webp|avif)$/i;

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readJson = (p, fallback) => {
  try { return JSON.parse(read(p)); } catch { return fallback; }
};

const config = readJson('site.config.json', null);
if (!config) {
  console.error('site.config.json is missing or invalid');
  process.exit(1);
}

const siteUrl = config.url.endsWith('/') ? config.url : `${config.url}/`;

/* ------------------------------------------------------------ image sizes */

/** Reads intrinsic dimensions straight from the file header — no dependencies,
    and it means width/height are always present so the grid can't shift. */
function dimensions(buf) {
  // PNG
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // WebP (VP8 / VP8L / VP8X)
  if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF'
      && buf.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buf.toString('latin1', 12, 16);
    if (kind === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h };
    }
  }

  // JPEG: walk the segment chain to the start-of-frame marker.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // SOF0..SOF15, skipping the DHT/JPG/DAC markers interleaved in that range.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }

  return { width: 0, height: 0 };
}

/* ---------------------------------------------------------------- photos */

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (IMAGE_RE.test(entry.name) && !VARIANT_RE.test(entry.name)) out.push(rel);
  }
  return out;
}

/** "20260808-142233-a3f1-morning-harbour.jpg" -> "Morning harbour" */
function titleFromPath(rel) {
  const stem = path.basename(rel).replace(/\.[^.]+$/, '');
  const words = stem
    .replace(/^\d{8}-\d{6}-[0-9a-f]{4}-?/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!words) return 'Untitled';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Dates are encoded in the upload path; fall back to the file's mtime. */
function takenAt(rel, stat) {
  const stamp = path.basename(rel).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (stamp) {
    const [, y, mo, d, h, mi, s] = stamp.map(Number);
    return new Date(y, mo - 1, d, h, mi, s).toISOString();
  }
  const folder = rel.match(/(\d{4})\/(\d{2})\//);
  if (folder) return new Date(Number(folder[1]), Number(folder[2]) - 1, 1).toISOString();
  return stat.mtime.toISOString();
}

const sidecar = readJson('data/photos.json', { photos: [] });
const byPath = new Map((sidecar.photos || []).map(p => [p.path, p]));

/** Finds <stem>-w<width>.<ext> siblings of a photo. Disk is the authority here
    rather than the index, so variants are picked up even for photos added
    outside the studio. */
function findVariants(rel, fullWidth, fullHeight) {
  const dir = path.posix.dirname(rel);
  const stem = path.basename(rel).replace(/\.[^.]+$/, '');
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];

  return fs.readdirSync(abs)
    .map(name => {
      if (!name.startsWith(`${stem}-w`)) return null;
      const m = name.match(VARIANT_RE);
      if (!m) return null;
      const width = Number(m[1]);
      const ext = m[2].toLowerCase();
      return {
        path: path.posix.join(dir, name),
        width,
        // Derived rather than re-read: the variant keeps the full image's
        // aspect ratio by construction, and this avoids a read per file.
        height: fullHeight && fullWidth
          ? Math.max(1, Math.round((fullHeight * width) / fullWidth))
          : 0,
        format: ext === 'webp' ? 'webp' : ext === 'avif' ? 'avif' : 'jpeg',
        bytes: fs.statSync(path.join(abs, name)).size,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.width - b.width);
}

const photos = walk(config.photosDir)
  .map(rel => {
    const stat = fs.statSync(path.join(ROOT, rel));
    const meta = byPath.get(rel) || {};
    const dims = meta.width && meta.height
      ? { width: meta.width, height: meta.height }
      : dimensions(fs.readFileSync(path.join(ROOT, rel)));

    const title = (meta.title || '').trim() || titleFromPath(rel);
    const caption = (meta.caption || '').trim();

    const variants = findVariants(rel, dims.width, dims.height);
    const display = variants.filter(v => v.format !== 'webp' && v.format !== 'avif');

    return {
      path: rel,
      title,
      caption,
      // Alt text is what search engines and screen readers actually consume, so
      // prefer the human caption and only fall back to the derived title.
      alt: (meta.alt || '').trim() || caption || title,
      width: dims.width,
      height: dims.height,
      bytes: stat.size,
      takenAt: meta.takenAt || takenAt(rel, stat),
      variants,
      // What an <img src> should point at: the largest raster fallback, or the
      // full file when this photo has no variants yet.
      display: (display.length ? display[display.length - 1] : null),
    };
  })
  .sort((a, b) => b.takenAt.localeCompare(a.takenAt));

/* ---------------------------------------------------------------- render */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const encodePath = p => p.split('/').map(encodeURIComponent).join('/');

/* Matches the .gallery grid in css/gallery.css: one column, then two at 620px,
   three at 1000px, inside a 1180px wrap with 18px gutters and 26px gaps. If
   that grid changes, this has to change with it or phones fetch the wrong size. */
const SIZES = '(min-width: 1180px) 364px, (min-width: 1000px) 31vw, (min-width: 620px) 46vw, 92vw';

function srcset(list) {
  return list.map(v => `${encodePath(v.path)} ${v.width}w`).join(', ');
}

/** <picture> with a WebP source and a JPEG fallback. Falls back to a bare <img>
    on the full-size file for photos uploaded before variants existed. */
function picture(p, i) {
  const eager = i < 3;
  const attrs = `alt="${esc(p.alt)}"`
    + (p.width ? ` width="${p.width}" height="${p.height}"` : '')
    + ` loading="${eager ? 'eager' : 'lazy'}" decoding="async"`
    + (i < 2 ? ' fetchpriority="high"' : '');

  const webp = p.variants.filter(v => v.format === 'webp');
  const jpeg = p.variants.filter(v => v.format === 'jpeg');
  const fallbackSrc = encodePath((p.display || p).path);

  if (!webp.length && !jpeg.length) {
    return `<img src="${fallbackSrc}" ${attrs}>`;
  }

  const sources = [];
  if (webp.length) {
    sources.push(`<source type="image/webp" srcset="${srcset(webp)}" sizes="${SIZES}">`);
  }
  if (jpeg.length) {
    sources.push(`<source type="image/jpeg" srcset="${srcset(jpeg)}" sizes="${SIZES}">`);
  }

  return `<picture>
            ${sources.join('\n            ')}
            <img src="${fallbackSrc}" ${attrs}>
          </picture>`;
}

function figures() {
  if (!photos.length) {
    return '<p class="gallery-empty">No photos published yet — check back soon.</p>';
  }
  return photos.map((p, i) => {
    const full = encodePath(p.path);
    const web = encodePath((p.display || p).path);
    const webWidth = (p.display || p).width;
    const ratio = p.width && p.height ? ` style="aspect-ratio:${p.width}/${p.height}"` : '';

    // data-full carries the full-resolution URL for the supporter prompt. It is
    // a plain URL in the markup, not a secret — the gate is a request, not
    // access control, and pretending otherwise would be dishonest.
    return `      <figure class="shot" id="p${i + 1}" data-index="${i}"${ratio}
              data-full="${full}" data-full-width="${p.width}" data-title="${esc(p.title)}">
        <a class="shot-link" href="${web}" aria-label="View ${esc(p.title)} larger">
          ${picture(p, i)}
        </a>
        <figcaption>
          <span class="shot-title">${esc(p.title)}</span>
          ${p.caption ? `<span class="shot-caption">${esc(p.caption)}</span>` : ''}
          <a class="shot-dl" href="${web}" download aria-label="Download ${esc(p.title)} at ${webWidth}px">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-3.5-3.5M12 15l3.5-3.5"/><path d="M5 17v1.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V17"/></svg>
            <span>Download</span>
          </a>
        </figcaption>
      </figure>`;
  }).join('\n');
}

/* Structured data. ImageGallery + ImageObject is what gets a page eligible for
   image-rich results; without it the photos are just decoration to a crawler. */
function jsonLd() {
  const graph = {
    '@context': 'https://schema.org',
    '@type': 'ImageGallery',
    name: config.title,
    description: config.description,
    url: siteUrl,
    inLanguage: config.locale || 'en',
    author: { '@type': 'Person', name: config.author, url: config.authorUrl || undefined },
    ...(photos.length ? {
      associatedMedia: photos.map(p => ({
        '@type': 'ImageObject',
        // The display variant, not the full-size file: this should describe
        // what the page shows, and it keeps the original out of the graph.
        contentUrl: siteUrl + encodePath((p.display || p).path),
        name: p.title,
        description: p.alt,
        ...((p.display || p).width
          ? { width: (p.display || p).width, height: (p.display || p).height || p.height }
          : {}),
        uploadDate: p.takenAt,
        creator: { '@type': 'Person', name: config.author },
        ...(config.license.url ? { license: config.license.url } : {}),
        acquireLicensePage: siteUrl,
      })),
    } : {}),
  };
  return JSON.stringify(graph, null, 2);
}

function sitemap() {
  const now = new Date().toISOString();
  const images = photos.map(p => `    <image:image>
      <image:loc>${esc(siteUrl + encodePath((p.display || p).path))}</image:loc>
      <image:title>${esc(p.title)}</image:title>
      <image:caption>${esc(p.alt)}</image:caption>
    </image:image>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>${esc(siteUrl)}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
${images}
  </url>
</urlset>
`;
}

/* Crawlers that identify themselves and honour robots.txt: AI training
   scrapers, dataset builders and content harvesters. Blocking them here is the
   one anti-scraping measure on this site that actually does something, because
   these operators publish their user-agents and respect the directive.
   Nothing stops an anonymous script — see the README. */
const AI_CRAWLERS = [
  'GPTBot', 'ChatGPT-User', 'OAI-SearchBot',          // OpenAI
  'ClaudeBot', 'Claude-Web', 'anthropic-ai',          // Anthropic
  'Google-Extended',                                  // Google AI training (not Search)
  'Applebot-Extended',                                // Apple AI training (not Search)
  'meta-externalagent', 'FacebookBot',                // Meta
  'Amazonbot', 'Bytespider', 'PerplexityBot',
  'CCBot',                                            // Common Crawl
  'Diffbot', 'ImagesiftBot', 'Omgilibot', 'Timpibot',
  'cohere-ai', 'YouBot', 'Scrapy', 'img2dataset',
];

function robots() {
  const blocked = [
    ...(config.protect.blockAiCrawlers ? AI_CRAWLERS : []),
    ...(config.protect.extraBlockedAgents || []),
  ];

  const blocks = blocked.map(agent => `User-agent: ${agent}\nDisallow: /`).join('\n\n');

  return `# Search engines are welcome: this site exists to be found.
User-agent: *
Allow: /

# The studio is the private uploader — nothing there is useful to a crawler.
Disallow: /studio.html

${blocked.length ? `# Declined: AI training and bulk-harvesting crawlers.\n# Only effective for bots that identify themselves and obey this file.\n${blocks}\n` : ''}
Sitemap: ${siteUrl}sitemap.xml
`;
}

const kofiUrl = config.kofi.handle ? `https://ko-fi.com/${config.kofi.handle}` : '';

/* The supporter prompt. Deliberately not a paywall: the full-size URL is in the
   markup, the bypass is a normal button of equal weight, and the copy says so.
   Without a Ko-fi handle there is nothing to ask for, so the gate turns itself
   off and full-resolution downloads go straight through. */
const gate = {
  enabled: config.supporterGate?.enabled !== false,
  title: config.supporterGate?.title || 'Full resolution',
  body: config.supporterGate?.body
    || 'The web-size version is free and downloads straight away. If the full-size '
      + 'file is worth something to you, a coffee helps keep this going.',
  note: config.supporterGate?.note
    || 'Honesty box — nothing is checked, and the download works either way.',
  supportLabel: config.supporterGate?.supportLabel || 'Buy me a coffee',
  bypassLabel: config.supporterGate?.bypassLabel || 'Download full resolution',
};

const ogImage = photos.length
  ? siteUrl + encodePath((photos[0].display || photos[0]).path)
  : `${siteUrl}assets/icon-512.png`;

const robotsMeta = [
  'index',
  'follow',
  `max-image-preview:${config.seo.imagePreview || 'large'}`,
  'max-snippet:-1',
  // A declaration, not a control: honoured by some AI crawlers, ignored by the
  // rest. It costs nothing and it states intent on the record.
  ...(config.protect.noaiMeta ? ['noai', 'noimageai'] : []),
].join(', ');

const replacements = {
  ROBOTS_META: robotsMeta,
  LANG: config.locale || 'en',
  TITLE: config.title,
  SITE_NAME: config.siteName,
  TAGLINE: config.tagline,
  DESCRIPTION: config.description,
  KEYWORDS: (config.seo.keywords || []).join(', '),
  AUTHOR: config.author,
  CANONICAL: siteUrl,
  OG_IMAGE: ogImage,
  TWITTER: config.seo.twitter || '',
  PHOTO_COUNT: String(photos.length),
  PHOTO_COUNT_LABEL: `${photos.length} photo${photos.length === 1 ? '' : 's'}`,
  FIGURES: figures(),
  JSON_LD: jsonLd(),
  KOFI_URL: kofiUrl,
  KOFI_LABEL: config.kofi.label,
  KOFI_BLURB: config.kofi.blurb,
  GATE_TITLE: gate.title,
  GATE_BODY: gate.body,
  GATE_NOTE: gate.note,
  GATE_SUPPORT: gate.supportLabel,
  GATE_BYPASS: gate.bypassLabel,
  GATE_ENABLED: gate.enabled && kofiUrl ? '1' : '0',
  LICENSE_LABEL: config.license.label,
  LICENSE_DETAIL: config.license.detail,
  YEAR: String(new Date().getFullYear()),
  BUILT_AT: new Date().toISOString(),
};

let html = read('tools/templates/index.html');
for (const [key, value] of Object.entries(replacements)) {
  html = html.replaceAll(`{{${key}}}`, value);
}

// The Ko-fi blocks disappear entirely rather than rendering a dead link.
if (!kofiUrl) html = html.replace(/<!--KOFI-->[\s\S]*?<!--\/KOFI-->/g, '');

const leftover = html.match(/\{\{([A-Z_]+)\}\}/);
if (leftover) {
  console.error(`Template placeholder ${leftover[0]} was never filled in`);
  process.exit(1);
}

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'index.html'), html);
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap());
fs.writeFileSync(path.join(ROOT, 'robots.txt'), robots());
fs.writeFileSync(
  path.join(ROOT, 'data/gallery.json'),
  `${JSON.stringify({ builtAt: replacements.BUILT_AT, site: siteUrl, photos }, null, 2)}\n`,
);

const missing = photos.filter(p => !p.caption).length;
console.log(`index.html      ${photos.length} photo${photos.length === 1 ? '' : 's'}`);
console.log(`sitemap.xml     ${photos.length} image entr${photos.length === 1 ? 'y' : 'ies'}`);
console.log('robots.txt      ok');
console.log('data/gallery.json ok');
if (missing) {
  console.log(`\nNote: ${missing} photo${missing === 1 ? ' has' : 's have'} no caption. `
    + 'Captions become alt text and are the main thing image search reads — '
    + 'add them in the studio.');
}
