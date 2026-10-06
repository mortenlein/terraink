# Map renderer (Gable's fork of Terraink)

This repository is a **fork** of [yousifamanuel/terraink](https://github.com/yousifamanuel/terraink),
used as the map renderer behind [Gable](https://gable.no): it turns an address or a
coordinate into a styled map **image** that Gable places on a customer's website at
publish time. It runs as its own service on our host and is talked to over HTTP only.

Based on Terraink source code. **"Terraink" is a trademark of Yousuf Amanuel, and the
Terraink logo, visual identity and branding assets are copyright © 2026 Yousuf Amanuel,
all rights reserved** (see [TRADEMARK.md](./TRADEMARK.md)). This fork is not affiliated with
or endorsed by the original project. It does not use the Terraink name or logo in its
interface or output, and it ships none of the upstream branding assets.

## Licence

As upstream states: as of **April 3rd 2026**, changes are licensed under
[AGPL-3.0](./LICENSE); code released before that date remains under the
[MIT License](./LICENSE-OLD). Both files are kept unchanged, including the additional
terms in `LICENSE` ("All copies, modifications, or derivative works must retain the
original copyright notice and license text"). Our changes in this fork are AGPL-3.0 as well.

Copyright © 2026 Yousuf Amanuel (AGPL-3.0 part); Copyright © 2026 Ankur Gupta and
Yousuf Amanuel (MIT part); changes in this fork copyright © 2026 Morten Lein.

The corresponding source of the running service is this repository (AGPL-3.0 section 13);
the app's footer links to it.

## What changed from upstream

- **Branding removed.** Upstream's name, logo, favicons, banner, social links, About and
  "support" modals, install prompt, the `terraink.app` credit line drawn on exports, and the
  terraink.app SEO/hosting files are gone. The interface says "Map renderer". Internal storage
  keys and event names inherited from upstream are unchanged (they are not shown to anyone).
- **No watermark.** Exports carry no credit line unless `VITE_APP_CREDIT_URL` is set (it is not).
- **Map data attribution stays on every image**, bottom-right, shrunk to fit and never
  covered by the pin or label. The headless renderer reads the text from the tile source's own
  TileJSON (`OpenFreeMap © OpenMapTiles Data from OpenStreetMap` for OpenFreeMap), so the
  attribution is the one the provider asks for; `MAP_ATTRIBUTION` overrides it, and a source
  without an attribution is refused.
- **Headless render API** (`server/`, `render.html`, `src/render/main.ts`): a Bun service
  that drives the app's own export path in headless Chromium.
- **Presets** (`presets/*.json`): map styles in the app's theme format plus a `render` block.
  Gable owns them; `paper-warm` and `ink` are the first two, from Gable's warm theme.
- **Geocoding endpoint** that honours the Nominatim usage policy.

## Render API

The service listens on port 3000 in the container; on our host it is published on
`127.0.0.1:8215` only. There is no authentication, so it must never be exposed publicly.

### `POST /render`

```json
{ "lat": 66.3128, "lng": 14.1428, "zoom": 14, "width": 1200, "height": 800,
  "preset": "paper-warm", "label": "Fjellbakeriet", "marker": true, "format": "png" }
```

Returns `image/png` bytes and an `X-Render-Ms` header.

| Field | Rule |
|---|---|
| `lat`, `lng` | numbers; lat in [-85, 85], lng in [-180, 180] |
| `zoom` | number in [0, 20], MapLibre zoom (512 px tiles) at the output's pixel size |
| `width`, `height` | integers in [64, 2400] |
| `preset` | a file name in `presets/` without `.json` |
| `label` | optional, at most 80 characters: drawn in a box above the pin |
| `marker` | optional, default `true`: a pin at the centre |
| `format` | `"png"` (the only format) |

Errors are JSON `{ "error": "..." }`: 400 for bad input or an unknown preset, 502 when the tile
source fails (any tile that fails to load fails the whole render, so a half-blank image is
never returned), 503 when more than 10 renders are waiting, 504 after 30 s.

Renders run **one at a time** in a single shared Chromium. The map is drawn at twice the output
size and scaled down (smoother lines), with SwiftShader software WebGL, so no GPU is needed.

### `GET /geocode?q=<address>&limit=5`

```json
{ "query": "storgata 1 mo i rana", "cached": false,
  "results": [{ "lat": 66.31, "lng": 14.14, "displayName": "...", "type": "house" }] }
```

Proxies [Nominatim](https://nominatim.openstreetmap.org/) under its usage policy,
<https://operations.osmfoundation.org/policies/nominatim/>:

- every request identifies the application in the `User-Agent` with a contact e-mail from
  `NOMINATIM_CONTACT`; **without that variable the endpoint answers 503 and never calls Nominatim**;
- at most one request per second across all callers (calls are queued and spaced);
- results are cached on disk for 30 days, keyed by the normalised query (case, commas and
  whitespace folded), so the same address is asked once.

### `GET /health`, `GET /presets`

`/health` → `{ ok, browser: "up" | "idle", queue, tileUrl }`. `/presets` lists the preset names.

`GET /` serves the interactive map editor (the upstream app, de-branded), useful for trying
styles by hand.

## Provisional choices

- **Tile source.** `TILE_URL` defaults to OpenFreeMap's public planet
  (`https://tiles.openfreemap.org/planet`, OpenMapTiles schema). Whether customer sites may rely
  on it, or we self-host OpenMapTiles, is an open decision on the Gable side.
- **Geocoding.** The public Nominatim instance is for low volume. Kartverket's address data is
  the alternative for Norwegian addresses; also open on the Gable side.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `TILE_URL` | OpenFreeMap planet | TileJSON URL of an OpenMapTiles-schema vector source |
| `MAP_ATTRIBUTION` | (from TileJSON) | attribution text drawn on images |
| `NOMINATIM_CONTACT` | (none) | contact e-mail for Nominatim; geocoding is off without it |
| `NOMINATIM_URL` | `https://nominatim.openstreetmap.org` | another Nominatim instance |
| `GEOCODE_CACHE_DIR` | `/data/geocode` in the image | cache directory (a named volume in compose) |

## Develop

```bash
bun install && (cd server && bun install)
bun run build                 # dist/: the editor and render.html
PORT=9057 bun server/index.ts # needs a Playwright Chromium (npx playwright install chromium)
(cd server && bun test)       # input validation, query normalisation, attribution parsing
bun run dev                   # the editor alone, with Vite
```

## Docker

```bash
cp infra/.env.example infra/.env && chmod 600 infra/.env   # set NOMINATIM_CONTACT
docker compose -f infra/compose.yml up -d --build
curl -s http://127.0.0.1:8215/health
curl -s -X POST http://127.0.0.1:8215/render -H 'Content-Type: application/json' \
  -d '{"lat":66.3128,"lng":14.1428,"zoom":14,"width":1200,"height":800,"preset":"paper-warm","format":"png"}' \
  -o mo.png
docker compose -f infra/compose.yml down    # stop (the geocode cache volume stays)
```

The image is multi-stage (app build, server dependencies, runtime with Chromium headless
shell only) and runs as the non-root `bun` user. Compose project `gable-maps`, container
`gable-maps`, subnet pinned to `10.82.13.0/24`, `restart: unless-stopped`, healthcheck on `/health`.

## Attribution

- **Map data**: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), [ODbL](https://opendatacommons.org/licenses/odbl/)
- **Tile schema**: © [OpenMapTiles](https://openmaptiles.org/)
- **Tile hosting**: [OpenFreeMap](https://openfreemap.org/)
- **Geocoding**: [Nominatim](https://nominatim.openstreetmap.org/) / OpenStreetMap data
- **Map rendering**: [MapLibre GL JS](https://maplibre.org/), BSD-3-Clause
- **Fonts**: SIL Open Font License, see [public/licenses/fonts.txt](./public/licenses/fonts.txt)

## Upstream's acknowledgment

Terraink was inspired by [MapToPoster](https://github.com/originalankur/maptoposter) by
[Ankur Gupta](https://github.com/originalankur), originally released under the MIT license.
