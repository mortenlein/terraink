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
  TileJSON (`© OpenMapTiles © OpenStreetMap contributors` for our own Norway tiles), so the
  attribution is the one the data asks for; `MAP_ATTRIBUTION` overrides it, and a source
  without an attribution is refused.
- **Headless render API** (`server/`, `render.html`, `src/render/main.ts`): a Bun service
  that drives the app's own export path in headless Chromium.
- **Presets** (`presets/*.json`): map styles in the app's theme format plus a `render` block.
  Gable owns them; `paper-warm` and `ink` are the first two, from Gable's warm theme, and
  `paper-warm-3d` is `paper-warm` with extruded buildings and a tilted camera.
- **3D buildings**: a `fill-extrusion` layer on OpenMapTiles' `building` layer
  (`render_height` / `render_min_height`, 6 m when missing, `hide_3d` parts skipped), drawn
  after the roads.
- **Road and place names** (`labels` in a preset): only the road classes and place kinds the
  preset lists, named at most once or twice per image, kept clear of the pin, its label, the
  attribution and the image edges.
- **Self-hosted tiles and glyphs** (`tiles` service, `infra/build-tiles.sh`) and **geocoding
  from Kartverket's address API**, so no render or lookup touches a public map service.

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
| `marker` | optional, default `true`: a pin at the centre (a dot when flat, a standing pin with its tip on the spot when tilted) |
| `format` | `"png"` (the only format) |
| `pitch` | optional number in [0, 60], camera tilt in degrees; default the preset's `render.camera.pitch`, else 0 |
| `bearing` | optional number in [-180, 180], camera rotation in degrees; default the preset's `render.camera.bearing`, else 0 |
| `buildings3d` | optional boolean: buildings as extruded blocks; default the preset's `render.building3d.enabled`, else `false` |
| `scale` | optional number in [1, 3], default 1: device pixel ratio. The PNG is `width*scale` by `height*scale` with the same map extent, line weights, pin, label and attribution, only sharper; `width*scale` and `height*scale` must stay within 2400 |

`scale` is for images shown at `width` CSS pixels on high-density screens: a 600×400 map at
`scale: 2` is a 1200×800 PNG whose attribution is still legible at 600 px. The request's
`pitch`, `bearing` and `buildings3d` always win over the preset, including `0` and `false`.
The camera centre is the requested point at any pitch, so the pin stays on the spot.

Errors are JSON `{ "error": "..." }`: 400 for bad input or an unknown preset, 502 when the tile
source fails (any tile that fails to load fails the whole render, so a half-blank image is
never returned), 503 when more than 10 renders are waiting, 504 after 30 s.

Renders run **one at a time** in a single shared Chromium. The map is drawn at twice the output
size and scaled down (smoother lines), with SwiftShader software WebGL, so no GPU is needed.
Measured on ash in the container (2026-10-06, Mo i Rana, `X-Render-Ms`): 1200×800 flat
2.3–2.5 s, 1200×800 with 3D buildings at pitch 50 2.0–2.7 s, 600×400 at `scale: 2` 2.2–2.6 s,
and the worst case allowed (2400×1600, 3D, pitch 60) 6.5 s, against the 30 s cap. Presets with
`labels` cost about a second more (same day: 1200×800 flat 3.4–4.0 s, 3D 3.3–3.9 s, 600×400 at
`scale: 2` 3.3–3.5 s): every render opens a fresh browser context, so the glyphs are fetched each
time, and a place cap needs a second placement pass.

### Preset `render` block

| Key | Meaning |
|---|---|
| `lineWidthScale` | multiplies every road, rail and waterway width |
| `layers` | `includeLandcover`, `includeParks`, `includeAeroway`, … (the editor's layer switches) |
| `marker` | `{ fill, stroke }` of the pin |
| `label` | `{ background, text }` of the label box |
| `attribution` | `{ color, backdrop }` of the data attribution |
| `camera` | `{ pitch, bearing }`: the suggested camera, used when the request leaves them out |
| `building3d` | `{ enabled, color, shade, opacity }`: `enabled` is the default for the request's `buildings3d`; `color` is the roof, `shade` the darkest wall, `opacity` 0–1 |

Without a `building3d` block a preset still renders in 3D when asked: the roof is the flat
building colour (lifted a step toward the text colour on a dark map) and the shade is the
roof darkened toward black. MapLibre shades walls with one light, not per face, so `shade`
is turned into the light's intensity (`buildingLight` in
`src/features/map/infrastructure/maplibreStyle.ts`): the wall facing away from the light
comes out at `shade`, the others in between, and its hue follows `color`.

### Preset `labels` block

Road and place names. A preset without `labels` gets none, and its style is exactly what it
was before labels existed (no glyphs, no symbol layers). All sizes are CSS pixels of the output
at `scale: 1`; zooms are request zooms.

```json
"labels": {
  "roads": { "classes": ["motorway", "trunk", "primary", "secondary", "tertiary"], "minZoom": 13 },
  "places": { "kinds": ["town", "suburb"], "maxCount": 2, "size": 10, "letterSpacing": 0.18, "transform": "uppercase" },
  "font": ["Noto Sans Regular"], "size": 11, "letterSpacing": 0.08, "transform": "none",
  "color": "#5c5045", "halo": { "color": "#faf6f0", "width": 1.2 }, "spacing": 700
}
```

| Key | Meaning |
|---|---|
| `roads.classes` | OpenMapTiles `transportation_name` classes to name; nothing else is named. The text is the road's `name`, else its `ref` (`E 6`) unless it carries several |
| `roads.minZoom` | no road names below this zoom (default 13) |
| `places.kinds` | OpenMapTiles `place` classes (`city`, `town`, `village`, `suburb`, …) |
| `places.maxCount` | at most this many place names, the most important (lowest `rank`) first; default 2 |
| `places.size`, `.letterSpacing`, `.transform` | place-name overrides of the shared values |
| `font` | a font stack the glyph server has (ours: `Noto Sans Regular`, `Noto Sans Italic`, `Noto Sans Bold`) |
| `size`, `letterSpacing` (em), `transform` (`none` / `uppercase`) | the road-name type |
| `color` | the ink of every name (default the preset's text colour) |
| `halo` | `{ color, width }`: the outline, and the colour of the plaque under a road name (default the land colour) |
| `spacing` | minimum distance between repeats of one name, at least 600 |

How it is drawn (`src/features/map/infrastructure/labelLayers.ts`, `src/render/main.ts`):

- Road names follow the line, beside it rather than on it, with a plaque in the halo colour
  under them. The plaque is invisible except where it hides a line crossing the name: the halo
  alone cannot do that, because MapLibre caps it near an eighth of the font size and a word gap
  has no glyph to halo.
- Collision is on with generous padding; places sit above roads, so a town's name wins.
- Transparent boxes over the pin and its label, the attribution and a band along every edge
  are placed before any name, so no name is ever under the pin or cut by the frame.
- On a tilted map names lie on the ground (`text-pitch-alignment: map`) and follow the road.
  The far ground, where a name would be drawn at less than 70 % of its height
  (MapLibre's perspective scaling times the foreshortening), is kept clear, so 3D renders
  name only the near and middle ground.
- **Glyphs** come from `GLYPHS_URL`, by default the tile service's
  `http://gable-maps-tiles:3000/font/{fontstack}/{range}` (martin cuts the PBF ranges from the
  Noto Sans TTFs `infra/build-tiles.sh` fetches, pinned by commit and sha256). A failed glyph
  request fails the render, like a tile. Another font is another TTF in `infra/tiles/fonts/`.
- **Only our own hosts.** The render page may reach this server and the tile/glyph hosts and
  nothing else: every other request is aborted and logged (`render: refused requests to …`).

### `GET /geocode?q=<address>&limit=5`, `GET /reverse?lat=<lat>&lng=<lng>`

```json
{ "query": "ole tobias olsens gate 6 8622 mo i rana", "cached": false,
  "results": [{ "lat": 66.30813, "lng": 14.13573, "displayName": "Ole Tobias Olsens gate 6, 8622 MO I RANA", "type": "Vegadresse" }],
  "attribution": "© Kartverket (CC BY 4.0)" }
```

Answers from Kartverket's open address API (`GEOCODER_URL`, default
`https://api.kartverket.no/adresser/v1`, the distribution URL in Kartverket's catalogue record
<https://kartkatalog.geonorge.no/api/getdata/44eeffdc-6069-4000-a49b-2d6bfc59ac61>, read
2026-11-08; `https://ws.geonorge.no/adresser/v1` serves the same API). `/geocode` uses `/sok`,
`/reverse` uses `/punktsok` (nearest address within 200 m).

- **Terms (read 2026-11-08):** open, no key; licence CC BY 4.0, so every answer carries
  `attribution`; not meant for extracting whole datasets; breaking changes are announced three
  months ahead on <https://geonorge.no/aktuelt/varsler/Tjenestevarsler/>. No rate limit is
  published; calls are still queued and spaced 250 ms apart (judgement).
- **Norwegian addresses only.** `sok` requires every word to match, so a trailing country word
  (`Norge`, `Norway`, `Noreg`, as Gable appends) is dropped first, and a standalone `gt.` is
  spelled `gate`. A query without any number (a bare place name) is answered with no hit
  without asking: Kartverket would return a random address in that place. A foreign address,
  a misspelt street or a joined abbreviation (`Kirkegt.`) finds nothing.
- Results are cached on disk for 30 days, keyed by provider and the normalised query (case,
  commas and whitespace folded), so the same address is asked once and an answer cached from
  the earlier Nominatim geocoder is never served.

### `GET /health`, `GET /presets`

`/health` → `{ ok, browser: "up" | "idle", queue, tileUrl }`. `/presets` lists the preset names.

`GET /` serves the interactive map editor (the upstream app, de-branded), useful for trying
styles by hand.

## Tiles

Decided by Morten 2026-11-07 (Gable `DECISIONS.md`): our own tiles and Kartverket geocoding, not
OpenFreeMap's public planet and public Nominatim.

- **Service:** `tiles` in `infra/compose.yml`, container (and label `com.gable.project`)
  `gable-maps-tiles`, image `ghcr.io/maplibre/martin:1.16.1`, published on `127.0.0.1:8216`
  for checks from the host. The renderer reaches it as `http://gable-maps-tiles:3000` on the
  compose network. The editor in a browser goes through this server's `/tiles/*` proxy.
- **Data:** `infra/build-tiles.sh` renders Geofabrik's `norway-latest.osm.pbf` with planetiler
  0.10.2's OpenMapTiles profile into `infra/tiles/norway.mbtiles` (gitignored and
  dockerignored), and fetches Noto Sans Regular, Bold and Italic (OFL 1.1) into
  `infra/tiles/fonts/`. Norway only: a render outside Norway is ocean and Natural Earth.
- **Refresh:** run `infra/build-tiles.sh` again, then
  `docker compose -f infra/compose.yml restart tiles`. The new file replaces the old only after
  a whole build succeeded. No cadence is set (judgement: monthly is plenty for streets).
- **Water polygons:** fetched from osmdata.openstreetmap.de. That host was unreachable from
  saman on 2026-11-08 ("No route to host"), so `WATER_POLYGONS_URL` names another copy, or
  `WATER_POLYGONS_FILE` one already on disk (moved in); the zip is checked member by member.
  The 2026-11-08 build used the Wayback Machine's 2026-01-07 copy
  (`https://web.archive.org/web/20260107000623id_/https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip`,
  907 893 588 bytes; it serves ~200 KB/s, so it was fetched in 16 parallel byte ranges).
- **Disk:** at most 10 GB in all (the hosting go), the old tiles included. The build watches
  all of `infra/tiles/` and stops planetiler above 9.5 GB; the scratch is removed on any exit.
  Measured 2026-11-08: 2.1 GB of tiles and fonts at rest, a 7.2 GB peak during a rebuild
  (with `--storage=ram --compress_temp`, 10 GB Java heap; planetiler's defaults peaked at
  9.1 GiB of scratch alone). The build takes about 15 minutes on saman.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `TILE_URL` | `http://gable-maps-tiles:3000/norway` | TileJSON URL of an OpenMapTiles-schema vector source |
| `MAP_ATTRIBUTION` | (from TileJSON) | attribution text drawn on images |
| `GLYPHS_URL` | the tile service's `/font/{fontstack}/{range}` | glyph PBF template for map names |
| `GEOCODER_URL` | `https://api.kartverket.no/adresser/v1` | Kartverket's address API |
| `TILES_DIR` | `infra/tiles` | compose: where `build-tiles.sh` wrote the tile data |
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
cp infra/.env.example infra/.env && chmod 600 infra/.env   # every value may stay empty
infra/build-tiles.sh                                       # the tile data, once
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
- **Tiles**: self-hosted, built with [planetiler](https://github.com/onthegomap/planetiler) and served by [martin](https://martin.maplibre.org/)
- **Glyphs**: [Noto Sans](https://notofonts.github.io/), SIL Open Font License 1.1
- **Geocoding**: © [Kartverket](https://www.kartverket.no/), address data under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- **Map rendering**: [MapLibre GL JS](https://maplibre.org/), BSD-3-Clause
- **Fonts**: SIL Open Font License, see [public/licenses/fonts.txt](./public/licenses/fonts.txt)

## Upstream's acknowledgment

Terraink was inspired by [MapToPoster](https://github.com/originalankur/maptoposter) by
[Ankur Gupta](https://github.com/originalankur), originally released under the MIT license.
