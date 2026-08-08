# pixsz

A personal photo upload site that runs as a static page on GitHub Pages. No build
step, no framework, no server — just open it on your phone and add photos.

<p align="center"><img src="assets/icon-192.png" width="96" alt=""></p>

## What it does

- **Add photos from a phone** — camera roll (multi-select), or straight from the camera.
- **Shrinks them on the device** before they go anywhere. A 9 MB, 12 MP phone photo
  becomes a ~400 KB JPEG, which matters a lot on a mobile uplink.
- **Strips EXIF**, including GPS coordinates, as a side effect of re-encoding.
- **Stores them locally** in IndexedDB, so the gallery works offline and with no
  account, token, or configuration at all.
- **Optionally commits them to a GitHub repo**, so they survive clearing your
  browser and show up on your other devices.
- **Installs as a PWA** — add to home screen and it runs full-screen. On Android it
  also registers as a share target, so "Share → pixsz" from the Photos app works.

## Where do the photos actually go?

GitHub Pages serves static files; there is no server to receive an upload. So there
are exactly two honest options, and pixsz does both:

| Mode | Setup | Photos live in | Survives clearing the browser | Visible on your other devices |
|---|---|---|---|---|
| **On device** (default) | none | IndexedDB on that phone/laptop | no | no |
| **GitHub sync** (optional) | a fine-grained token | a repo you own | yes | yes |

Without sync it is a private, offline photo stash. With sync it is a real personal
photo host, backed by a Git repo.

## Deploy it

1. Fork or copy this repo.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick
   your branch and `/ (root)`.
3. Open `https://<you>.github.io/<repo>/` on your phone and **Add to Home Screen**.

Every path in the app is relative, so it works from a project subpath
(`user.github.io/pixsz/`) or a custom domain root without changes.

A workflow at `.github/workflows/pages.yml` is included if you prefer Pages'
GitHub Actions source instead — enable it with **Source: GitHub Actions**.

> Pages requires HTTPS for service workers and the camera picker, which
> `github.io` gives you for free. Over plain `http://` on a LAN address, the PWA
> and offline bits will not register.

## Turning on GitHub sync

You need a **fine-grained** personal access token, scoped as tightly as possible:

1. <https://github.com/settings/personal-access-tokens/new>
2. **Repository access → Only select repositories** → pick the one repo that will
   hold your photos.
3. **Permissions → Repository permissions → Contents: Read and write.** Nothing else.
4. Set an expiry you're comfortable with. The app tells you when the token stops working.

Then open **Settings** in the app, paste the token, fill in owner / repo / branch /
folder, and hit **Test & save**. **Load from repo** pulls down what's already there.

### About the token — read this bit

The token is held in that browser's `localStorage` and is sent only to
`api.github.com`. That is the unavoidable shape of a static site with no backend:
there is nowhere else to keep a credential. Practical consequences:

- Any script running on the page can read it. This app loads no third-party code
  and has no external network calls by design — keep it that way if you fork it.
- **Don't do this on a shared or public device.** Use **Forget token** when done.
- Scope the token to one repo, and use a **private** repo unless you want the photos
  publicly readable — a public repo means anyone with the URL can fetch them.
- If the token leaks, revoke it at
  <https://github.com/settings/personal-access-tokens>. Contents-only on one repo
  is about as small as the blast radius gets.

A private repo works fine: image bytes are then fetched through the authenticated
API instead of `raw.githubusercontent.com`.

## Mobile details that were worth getting right

- Primary actions sit in a bottom bar inside the safe area, in thumb reach — not
  in a top-right corner you have to shuffle your grip for.
- `viewport-fit=cover` plus `env(safe-area-inset-*)` so notches and home
  indicators don't overlap controls.
- 16px form inputs, because anything smaller makes iOS Safari zoom on focus.
- 44px minimum tap targets; `touch-action: manipulation` kills the 300ms
  double-tap-zoom delay on buttons.
- Long-press a thumbnail for multi-select, swipe between photos in the viewer,
  swipe down to dismiss.
- `<input accept="image/*" multiple>` for the library, a second input with
  `capture="environment"` for the camera — iOS collapses the first into its own
  Photo Library / Take Photo / Choose File sheet.
- EXIF orientation is applied at decode (`imageOrientation: 'from-image'`), so
  portrait shots don't land sideways.
- Uploads are queued and run one at a time, survive tab backgrounding, and resume
  on the `online` event.

## Layout in your repo

Photos are committed as:

```
photos/2026/08/20260808-142233-a3f1-beach.jpg
```

Date-stamped and slugged, so files sort chronologically and never collide. The
folder is configurable; the app reads the date back out of the filename when it
pulls a repo it didn't populate itself.

## Limits worth knowing

- The gallery lists a repo with one Git tree call. Above roughly 100k entries
  GitHub truncates the response and the app says so.
- The Contents API is not built for very large files. With resizing on you'll be
  around 300–800 KB per photo; turn resizing off and multi-megabyte originals go
  up as-is, which is slower and will eventually make the repo unpleasant to clone.
- Authenticated GitHub API traffic is capped at 5,000 requests/hour. One upload is
  one request, so this only bites on very large imports.
- Deleting from the app deletes from the repo's current branch, but the bytes
  remain in Git history. To purge properly, rewrite history.
- iOS may hand over HEIC originals rather than converted JPEGs in some flows. The
  app reports those clearly instead of failing silently; browsers can't decode
  HEIC natively.

## Files

```
index.html          markup and the settings sheet
css/styles.css      mobile-first styling, light + dark
js/app.js           wiring, gallery, queue, lightbox
js/db.js            IndexedDB
js/imaging.js       decode → orient → downscale → re-encode
js/github.js        Contents API client
js/settings.js      localStorage-backed prefs
js/zip.js           store-only ZIP for "Download all"
sw.js               offline shell + Web Share Target
tools/make-icons.py regenerates assets/*.png
```

Run it locally with any static server, e.g. `python3 -m http.server 8080`.

## Licence

MIT — see [LICENSE](LICENSE).
