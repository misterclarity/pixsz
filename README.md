# pixsz

A personal photo site that runs entirely on GitHub Pages. Two halves:

| | | |
|---|---|---|
| **`/`** | Public gallery | Pre-rendered, indexable, one-at-a-time downloads, Ko-fi link |
| **`/studio.html`** | Private uploader | **This is where you add photos.** Mobile-first, `noindex` |

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

## Adding photos

1. Go to **`/studio.html`** — or tap **Studio** in the gallery footer.
2. **Add photos** picks from your camera roll; the camera button shoots a new one.
3. They upload automatically once GitHub sync is configured (step 3 below).
4. Tap a photo in the studio to give it a title and caption. Those become the
   alt text on the public page, which is the part search engines read.
5. CI rebuilds the gallery on push; the photo appears at the site root.

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

**The uploader lives at `/studio.html`, not at the site root.** The root is the
public gallery and deliberately has no upload controls — a visitor should never
see them. There's a discreet **Studio** link in the gallery footer to get you
there; set `"studioLink": false` in `site.config.json` to remove it and rely on
a bookmark or the installed app instead.

Open `/studio.html` on your phone, **Add to Home Screen** (it then opens
straight into the uploader like an app), then **Settings**:

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

## Responsive images

The studio generates display variants at upload time and the build emits a
`<picture>` with WebP and JPEG `srcset`s, so a phone fetches a phone-sized file
instead of the original:

```
photos/2026/08/beach.jpg          full resolution — the gated download
photos/2026/08/beach-w640.webp    display variants, one per width per format
photos/2026/08/beach-w1080.webp
photos/2026/08/beach-w1600.jpg    …
```

Measured on this repo's own gallery, six 2048px photos:

| | Before | After |
|---|---|---|
| iPhone 13 (390px, DPR 3) | 1821 KB | **488 KB** |
| Desktop (1280px, DPR 1) | 1821 KB | **203 KB** |

Widths are set in `site.config.json` and default to `[640, 1080, 1600]`. That
ladder is tuned for this grid: 640 covers a three-column desktop at DPR 1, and
1080 is almost exactly what a DPR-2.6/3 phone needs for a full-width tile. If
you change the grid in `css/gallery.css`, change the `SIZES` constant in
`tools/build-gallery.mjs` to match, or phones will pick the wrong file.

Each photo costs one upload per width per format on top of the original — with
the defaults that's up to seven files. Drop `"formats"` to `["webp"]` to halve
it; WebP is supported everywhere current, and the JPEG set exists only for
browsers older than Safari 14.

Variants are never upscaled: a 900px-wide photo gets a 640 variant and nothing
else. Photos uploaded before this existed keep working — the build falls back to
a plain `<img>` on the full file.

The viewer has its own `<picture>` with the same srcsets at `sizes="100vw"`, so
opening a photo full-screen also fetches a screen-sized file rather than the
largest one.

## Repeat visits and offline

GitHub Pages serves assets with a ten-minute cache lifetime and there is no way
to configure that, so a visitor returning an hour later would re-download every
photo. `sw.js` fixes it with a cache-first store for display variants:

| | Transferred | Photos over the network |
|---|---|---|
| First visit | 348 KB | 4 of 6 |
| Repeat visit | **28 KB** | 0 of 6 |
| Offline | — | all 6 still render |

Photo URLs are immutable — every upload gets a fresh date-stamped filename — so
a cache hit needs no revalidation. The cache holds 120 variants and evicts
oldest-first. Full-resolution originals are deliberately *not* cached: they're
large, rarely opened, and would evict everything useful.

One service worker serves both halves of the site, because two registrations
can't share a scope. Only the gallery is precached; the studio's assets are
cached on first use, so a visitor never downloads an uploader they'll never open.

## What is stored where

| | Holds | Notes |
|---|---|---|
| **GitHub repo** | full-res original, display variants, `data/photos.json` | The durable copy. Everything else is derived. |
| **Studio: IndexedDB** | full blob, thumbnail, placeholders, metadata | ~470 KB per photo once synced |
| **Studio: localStorage** | `pixsz.settings.v1` — includes the token | |
| **Gallery: localStorage** | `pixsz.supporter` — honesty-box flag | |
| **Service worker caches** | `pixsz-v3` shell, `pixsz-photos-v1` variants | 120 variants, oldest-first eviction |

Measured on a 2.0 MB, 4032×3024 phone photo: **1193 KB pushed to the repo**
across 8 files, **470 KB kept on the device**.

Variant blobs are dropped as soon as each one lands in the repo — nothing local
reads them again, and keeping them was 62% of the studio's footprint. A variant
whose upload fails keeps its blob and retries on the next run.

The studio asks for `navigator.storage.persist()` at boot and again after the
first photo is added. Without it IndexedDB is best-effort and a phone under
storage pressure can evict the whole origin — which is survivable for synced
photos but would silently lose anything added offline and not yet uploaded.
Browsers grant persistence on engagement rather than on request, so it may be
refused; **Settings → This device** reports which mode is actually in effect.

### Ceilings

- **GitHub Pages:** 1 GB published site, 100 GB/month soft bandwidth limit —
  roughly 800 photos at ~1.2 MB each.
- **The phone:** browser quota is typically a percentage of free disk; ~844 MB
  was granted in testing, which is ~1,800 photos at 470 KB.
- **Git history keeps every version forever.** Deleting a photo frees space on
  the branch, not in the repo.

## Placeholders

Each tile carries a blurred 16px version of its own photo, inlined as a data URI
and scaled up by CSS, so a slow connection shows the picture's colours instead
of a grey box. The real image fades in over it.

That costs roughly **1 KB of HTML per photo** — JPEG's quantization and Huffman
tables dominate at that size, so it doesn't get much smaller. Past a couple of
hundred photos, switch to the average colour instead:

```jsonc
"images": { "placeholder": "blur" }   // "color" = one hex value per photo
                                      // "none"  = no placeholder
```

Placeholders are computed by the studio and travel in `data/photos.json`. The
build has no image decoder, so photos added by hand simply don't get one.

### Two things deliberately not done

- **`content-visibility: auto` on tiles.** Measured at 66 photos on a
  4×-throttled phone profile: 2403 ms of scroll work with it, 2407 ms without,
  zero long tasks either way. `loading="lazy"` already defers the expensive
  part, and its size estimates made the scroll height wrong for tiles never
  rendered. Past a few hundred photos the answer is pagination, not this.
- **A Web Worker for the studio's image processing.** Six 2048px photos at 4×
  CPU throttle produced 242 ms of total blocking, worst task 72 ms. Not worth
  the complexity.

## Downloads

One photo at a time, by design. Every tile and the viewer carry a plain
`<a download>` that works with JavaScript off. There is no bulk download on the
public page.

- **Tile and viewer download** → the largest display variant. Free, instant, no
  prompt.
- **Full resolution** (the expand icon in the viewer) → the original, behind the
  supporter prompt below.

The studio keeps its own **Download all** in Settings — that's your backup of
your own library, not a visitor-facing feature.

## The supporter prompt

Asking for a Ko-fi before handing over the full-resolution file, in a way that
is honest about what it is.

**It is not a paywall, and it does not pretend to be one.** A static site cannot
verify a payment and cannot hide a file the CDN serves publicly. So:

- The bypass is a normal button, the same size and weight as the support one.
- The copy says the download works either way.
- The full-resolution URL is in the markup as `data-full`. It has to be.
- No countdown, no confirm-shaming, no disguised link. Those would buy nothing
  here — the file is one devtools panel away regardless — and would cost you the
  goodwill that makes someone tip in the first place.

Going to Ko-fi sets a flag in `localStorage` and the prompt stops appearing.
Nothing is checked; that's the honest approximation, and it means someone who
has already given isn't nagged.

Configure or disable it in `site.config.json`:

```jsonc
"supporterGate": {
  "enabled": true,        // false → full-resolution downloads go straight through
  "title": "Full resolution",
  "body": "…",            // the ask
  "note": "…",            // the honesty-box disclaimer
  "supportLabel": "Buy me a coffee",
  "bypassLabel": "Download full resolution"
}
```

Clearing `kofi.handle` also disables it — there is nothing to ask for.

One useful side effect: because the gallery displays variants, the original is
only reachable through this prompt, and it stays out of `sitemap.xml` and the
structured data. Crawlers index the web-size images.

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
| Originals not displayed | Casual grabbing of full-res | The supporter prompt's own bypass |
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

1. **Publish web-resolution files only.** The gallery now displays variants
   (640–1600px), and the studio downscales to 2048px before upload, so nothing
   public is your master. Keep the originals off the repo entirely. Drop
   **Longest edge** in Settings to publish smaller still.
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
