# Parley landing page

A static one-page site for `https://kalmbik61.github.io/Parley/`. HTML, CSS and ES modules, no framework, no build step: the `site/` folder is published as is. The spec is `docs/specs/2026-10-28-landing-page-design.md`.

The page follows its own rules: no cookies, no analytics, no third-party fonts or CDN, no requests to other sites.

## Preview locally

From the repository root:

```bash
python3 -m http.server 8137 --directory site
```

Open `http://localhost:8137/`. To check the dark theme without changing the system setting, run `document.documentElement.dataset.theme = 'dark'` in the console.

## Release snapshot

Release cards read `site/releases.json`. The publish workflow writes it from the GitHub API before the site is uploaded; the file is not committed (`.gitignore`). For a local preview, copy the fixture:

```bash
cp scripts/site/fixtures/releases.json site/releases.json
```

Without the file the page shows its default state: a card that sends the reader to the releases on GitHub.

## Vendor logos

The flying figures in the hero and the provider pills show vendor logos. They are copies of the app's own provider icons (`packages/desktop/src/renderer/assets/providers`), slimmed down and kept in `site/media/vendors/`. `site/media/vendors/NOTICE.txt` carries the matching sections of the root `NOTICE`, because only `site/` is published. The logos belong to their owners and say nothing about endorsement; the footer says so too.

## Rebuild the media

Sources live in git, except the cover for the social image: `docs/promo/media/00-cover.png` exists only in the main checkout. Run these from the repository root. They need `python3` with `fonttools` and `brotli`, `cwebp`, `ffmpeg` and `sips`.

```bash
mkdir -p site/fonts site/media
# Fonts: woff2 from the same files the window uses, with their OFL licenses
python3 -m fontTools.ttLib.woff2 compress -o site/fonts/Figtree-Variable.woff2 packages/desktop/src/renderer/assets/fonts/Figtree-Variable.ttf
python3 -m fontTools.ttLib.woff2 compress -o site/fonts/Caprasimo.woff2 packages/desktop/src/renderer/assets/fonts/Caprasimo.ttf
cp packages/desktop/src/renderer/assets/fonts/{Figtree,Caprasimo}-OFL.txt site/fonts/
# Room screenshots
cwebp -q 82 -resize 1400 0 docs/media/room-decision-light.png -o site/media/room-decision-light.webp
cwebp -q 82 -resize 1400 0 docs/media/room-decision-dark.png -o site/media/room-decision-dark.webp
# Demo: 720p, H.264, moov at the start of the file
ffmpeg -y -i docs/media/parley-demo.mp4 -vf scale=1280:-2 -c:v libx264 -preset slow -crf 27 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 96k site/media/parley-demo.mp4
# Poster: the frame at 10 s (the room with the decision card), not the old cover
ffmpeg -y -ss 10 -i docs/media/parley-demo.mp4 -frames:v 1 /tmp/parley-demo-poster.png
cwebp -q 80 -resize 1280 0 /tmp/parley-demo-poster.png -o site/media/parley-demo-poster.webp
# Social image: the cover without the "v0.12 …" line at the bottom
ffmpeg -y -i /Users/kalmbik61/Desktop/MY/my_harnas/docs/promo/media/00-cover.png -vf "crop=1386:726:267:100,scale=1200:630" -q:v 3 site/media/og-image.jpg
# Icons
cp docs/media/brand/parley-icon.svg site/favicon.svg
sips -z 180 180 packages/desktop/build/icon.png --out site/apple-touch-icon.png
sips -z 32 32 packages/desktop/build/icon.png --out site/favicon-32.png
```

Size budgets: both woff2 together up to 90 KB, each webp up to 200 KB, `og-image.jpg` up to 150 KB, the video up to 4.5 MB, `index.html` up to 70 KB, `styles.css` up to 45 KB, all JS up to 35 KB (uncompressed).

Vendor logos (run from the repository root; `kimi.svg` is the light variant):

```bash
mkdir -p site/media/vendors
for p in claude:claude codex:codex deepseek:deepseek qwen:qwen minimax:minimax kimi:kimi-light openrouter:openrouter; do
  python3 - "${p%%:*}" "${p##*:}" <<'PY'
import re, sys
slug, src = sys.argv[1:]
t = open(f'packages/desktop/src/renderer/assets/providers/{src}.svg').read()
t = re.sub(r'<metadata>.*?</metadata>', '', t, flags=re.S)
t = t.replace('height="1em"', '').replace('width="1em"', '').replace(' style="flex:none;line-height:1"', '')
open(f'site/media/vendors/{slug}.svg', 'w').write(re.sub(r'\s+', ' ', t).strip())
PY
done
```

## Publishing

The site is published by `.github/workflows/pages.yml` as the `site/` folder, as is.

- **Pull request** that touches `site/`, `scripts/site/` or the workflow: only the test job runs (`node --test scripts/site/releases.test.mjs`). Nothing is deployed.
- **Push to master** with such changes, **a finished Release workflow** and **Run workflow** by hand: test, then deploy.

Where the release list comes from: the deploy job writes `site/releases.json` with the repository token right before it uploads the site (`gh api repos/<repo>/releases?per_page=8`, drafts and prereleases cut out by the `jq` filter, so the notes of an unpublished release never reach the public page). The file is not in git. The page reads it from its own address, so visitors never call the GitHub API. The Release workflow publishes with the repository token, and a release published that way does not start other workflows; that is why Pages also listens for the end of Release (`workflow_run`), and every new release gets onto the site by itself.

One-time setup, by a person with admin rights on the repository:

1. Merge the branch into master (a pull request).
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Run Actions → Pages → Run workflow, or wait for the next push that touches `site/`. The site is `https://kalmbik61.github.io/Parley/`.
4. Optionally put the address into the Website field of the repository and link it from the README.

Updating an action in `pages.yml`: find the commit of the version you want (`git ls-remote --tags <repository> <tag>`) and change the line and the list in `packages/desktop/src/release-workflows.test.ts` together.
