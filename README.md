# pixsz

A personal photo site that runs entirely on GitHub Pages. Two halves:

| | | |
|---|---|---|
| **`/`** | Public gallery | Pre-rendered, indexable, one-at-a-time downloads, Ko-fi link |
| **`/studio.html`** | Private uploader | Mobile-first, `noindex`, upload from your phone |

No build tooling, no framework, no server. Node is used once, in CI, to render
the gallery to static HTML.

<p align="center"><img src="assets/icon-192.png" width="96" alt=""></p>

## Why it's split in two

The studio builds its grid from IndexedDB in the browser. That's right for an
uploader and completely wrong for a public page: a crawler sees an empty
document, so nothing would ever be indexed.

So `tools/build-gallery.mjs` renders the gallery ahead of time — real `<img>`
tags, real alt text, real captions in the HTML — and CI runs it whenever photos
change. The public page needs no JavaScript to work at all; the viewer is an
enhancement layered on top.

## The flow

```
phone → studio.html → GitHub Contents API → photos/2026/08/…jpg
                                          → data/photos.json   (titles, captions)
                                                  ↓
                                       GitHub Actions runs the build
                                                  ↓
                            index.html · sitemap.xml · robots.txt → Pages
```

## Setup

### 1. Deploy

Fork or copy this repo, then **Settings → Pages**. Either source works:

- **GitHub Actions** (recommended) — the included workflow builds and deploys.
- **Deploy from a branch** — also fine; the workflow commits the rendered
  `index.html` back to the branch.

Set your real URL in `site.config.json` before the first deploy — the canonical
tag, the sitemap and the structured data all derive from it.

### 2. Configure the site

Everything a visitor reads lives in `site.config.json`:

```jsonc
{
  "url": "https://misterclarity.github.io/pixsz/",  // canonical URL — set this first
  "title": "…",            // <title> and og:title
  "tagline": "…",          // the <h1>
  "description": "…",      // meta description and og:description
  "photosDir": "photos",   // must match the studio's Folder setting
  "kofi":    { "handle": "misterclarity", "label": "…", "blurb": "…" },
  "license": { "label": "…", "detail": "…", "url": "" }
}
```

Clearing `kofi.handle` removes every Ko-fi block from the page rather than
leaving a dead link.

### 3. Connect the studio

Open `/studio.html` on your phone, **Add to Home Screen**, then **Settings**:

1. Create a **fine-grained** token at
   <https://github.com/settings/personal-access-tokens/new>
2. **Repository access → Only select repositories** → this repo.
3. **Permissions → Repository permissions → Contents: Read and write.** Nothing else.
4. Paste it in, set owner / repo / branch / folder, hit **Test & save**.

> **This repo must be public**, and the studio must point at *this* repo — the
> gallery serves photos as static files from it. (An earlier version of this
> README suggested a private repo. That's right for a private stash and wrong
> here: a private repo's files aren't publicly fetchable, so the gallery would
> render broken images.)

### Read this bit about the token

The token lives in that browser's `localStorage` and is sent only to
`api.github.com`. That's the unavoidable shape of a static site with no backend.

- Any script on the page can read it. This app loads no third-party code and
  makes no external calls by design — keep it that way if you fork it.
- **Don't do this on a shared device.** Use **Forget token** when you're done.
- Scope it to one repo, Contents-only. If it leaks, revoke it at
  <https://github.com/settings/personal-access-tokens>.
- The public gallery never touches the token — it's a separate page that doesn't
  load the studio's code at all.

## Captions are the SEO

Image search reads alt text and captions, not filenames. In the studio, tap a
photo and fill in the **title** and **caption** fields under it — they're saved
to `data/photos.json` in the repo, and the build turns them into:

- the `alt` attribute on each `<img>`
- the visible caption under each photo
- `<image:caption>` in the sitemap
- `description` in the JSON-LD `ImageObject`

Without a caption, the build derives a title from the filename
(`20260808-142233-a3f1-morning-harbour.jpg` → "Morning harbour") and tells you
how many photos are still uncaptioned. That fallback is a stopgap, not a
substitute.

## What the build emits

`node tools/build-gallery.mjs` writes:

| File | Purpose |
|---|---|
| `index.html` | The gallery, with every photo as static markup |
| `sitemap.xml` | Image sitemap (`image:loc`, `image:title`, `image:caption`) |
| `robots.txt` | Allows the gallery, disallows `/studio.html`, points at the sitemap |
| `data/gallery.json` | Machine-readable index |

Plus, in the page itself: canonical URL, Open Graph and Twitter cards,
`max-image-preview:large`, JSON-LD `ImageGallery` + `ImageObject` per photo,
intrinsic `width`/`height` on every image (no layout shift), lazy loading below
the fold, and `fetchpriority="high"` on the first two.

Intrinsic dimensions are read straight from the JPEG/PNG/WebP/GIF headers, so
they're correct even for photos added outside the studio.

### After deploying

Submit the sitemap in [Google Search Console](https://search.google.com/search-console)
and [Bing Webmaster Tools](https://www.bing.com/webmasters). Nothing else here
makes a page rank — indexing takes days to weeks, and a handful of photos on a
`github.io` subdomain will not rank quickly. A custom domain helps; consistent
captions help more.

## Downloads

One photo at a time, by design. Every tile and the viewer carry a plain
`<a download>` that works with JavaScript off. There is no bulk download on the
public page.

The studio keeps its own **Download all** in Settings — that's your backup of
your own library, not a visitor-facing feature.

## What "protect the images" can and can't do

Read this before relying on any of it.

**The honest baseline:** this is a static site on a public CDN. Every photo is a
plain file at a guessable URL, and it *has* to be, or browsers couldn't render
the page. `curl https://…/photos/2026/08/whatever.jpg` returns the bytes. No
amount of client-side JavaScript changes that, because the protection would run
on the attacker's machine.

There is also a direct tension with what this site is for: you asked for it to
be **findable on search engines**. Googlebot is a scraper. `sitemap.xml` exists
precisely to hand every image URL to crawlers. You cannot be maximally
discoverable and maximally un-scrapeable at once — the dials point in opposite
directions.

**What's implemented, and what each thing is worth:**

| Measure | Stops | Doesn't stop |
|---|---|---|
| Right-click blocked (`contextmenu`) | "Save image as…" | Devtools, view-source, curl, disabling JS |
| Drag blocked (`dragstart`) | Drag-to-desktop | Same as above |
| `-webkit-touch-callout: none` | iOS long-press save sheet | Screenshots |
| No bulk download | One-click grab of the set | A ten-line loop over `sitemap.xml` |
| `robots.txt` AI-crawler blocks | GPTBot, ClaudeBot, CCBot, Google-Extended, PerplexityBot, Bytespider and ~15 more | Anything that doesn't send an honest user-agent |
| `noai, noimageai` meta | Some AI crawlers | The rest |

The robots.txt blocks are the only measure that meaningfully changes outcomes,
because those operators publish their user-agents and honour the directive.
Everything else is friction that a determined person steps over in seconds. It's
worth having — most casual copying *is* casual — but don't mistake it for
access control.

The right-click block is deliberately not silent: a menu that fails to open
reads as a broken page, so the gallery shows a short message pointing at the
Download button instead. Right-click still works inside form fields.

**What actually protects work, in rough order of effectiveness:**

1. **Publish web-resolution files only.** The studio already downscales to
   2048px before upload, so what's public is not your master. Keep the originals
   off the repo. Drop **Longest edge** in Settings if you want to publish
   smaller.
2. **Watermark.** Nothing here does that yet; say the word and I'll add it to
   the upload pipeline.
3. **A clear licence,** which the page already states — it's what makes
   unauthorised use actionable rather than ambiguous.
4. **Don't publish it.** The only complete protection.

Tuning knobs in `site.config.json`:

```jsonc
"seo":     { "imagePreview": "large" },   // "standard" shrinks Google's image
                                          // previews — less scrape-friendly,
                                          // worse image-search click-through
"protect": {
  "blockAiCrawlers": true,                // the robots.txt block list
  "noaiMeta": true,                       // adds noai, noimageai
  "extraBlockedAgents": []                // add your own user-agents
}
```

## Licensing

`site.config.json` ships with a deliberately conservative default —
*"Free to download for personal use. All rights reserved."* — because handing
out broader rights should be your explicit choice, not a default you inherited.
If you want something more permissive (CC BY, CC0, Unsplash-style), edit
`license.label` / `license.detail` and set `license.url`; the URL is emitted as
`license` in the structured data.

## Mobile details worth keeping

- Actions sit in a bottom bar inside the safe area, in thumb reach.
- `viewport-fit=cover` + `env(safe-area-inset-*)` for notches and home indicators.
- 16px inputs — anything smaller makes iOS Safari zoom on focus.
- 44px minimum tap targets; `touch-action: manipulation` kills the 300ms delay.
- Long-press a thumbnail for multi-select; swipe between photos; swipe down to dismiss.
- `<input accept="image/*" multiple>` for the library, a second input with
  `capture="environment"` for the camera.
- EXIF orientation applied at decode, so portrait shots don't land sideways.
- Photos are downscaled and re-encoded on the device before upload — a 9 MB
  phone photo becomes ~400 KB, which matters on a mobile uplink. Re-encoding
  also strips EXIF, so GPS coordinates don't ride along into a public repo.
- Uploads queue, survive backgrounding, and resume on `online`.
- Installs as a PWA, and registers as a Web Share Target so "Share → pixsz"
  works from the Android photo picker.

## Files

```
site.config.json          everything a visitor reads
index.html                GENERATED — edit tools/templates/index.html instead
sitemap.xml robots.txt    GENERATED
tools/build-gallery.mjs   the build
tools/templates/index.html  gallery template
tools/make-icons.py       regenerates assets/*.png

css/gallery.css  js/gallery.js     public gallery (no zip.js — single downloads only)
studio.html  css/styles.css        uploader
js/app.js                          wiring, grid, queue, lightbox, captions
js/db.js  js/imaging.js  js/github.js  js/settings.js  js/zip.js
sw.js                              offline shell + share target
```

Local preview: `node tools/build-gallery.mjs && python3 -m http.server 8080`.

## Limits worth knowing

- The studio lists a repo with one Git tree call; above ~100k entries GitHub
  truncates and the app says so.
- The Contents API isn't built for very large files. With resizing on you'll be
  around 300–800 KB per photo.
- Authenticated GitHub API traffic is capped at 5,000 requests/hour.
- Deleting removes the file from the branch, but the bytes stay in Git history.
- Browsers can't decode HEIC. If iOS hands over an original rather than a
  converted JPEG, the studio says so rather than failing silently.
- Everything published here is public and downloadable by design. Don't put
  anything in it you wouldn't hand to a stranger.

## Licence

Code: MIT — see [LICENSE](LICENSE). Photos: whatever you set in
`site.config.json`.
