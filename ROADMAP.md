# Roadmap

## Next, ordered (2026-11-08)

Gable's fork. Hours are Claude-hours counted from the parts to build (named in each line), not
padded; what needs Morten or ashguard is said. The upstream sections below this one (SEO,
directories, social) are terraink.app's and not ours.

1. **Schedule the monthly tile refresh** (0.5 h): a cron line on saman for `infra/refresh-tiles.sh`
   with its log, plus the `refresh-tiles: OK|FAIL` line in the lane-daemon catalog; the script and
   its tests exist (2026-11-08).
2. **Fix the three pre-existing type errors** (0.5 h): `pngExporter.ts:96` (Uint8Array as BlobPart),
   `StartupLocationModal.tsx:130` (`reason` not on `GeolocationRequestResult`), `typography.ts:50`
   (`map` not on the theme type); one line each, then `bun run typecheck` clean.
3. **A memory guard in the refresh** (0.5 h): refuse when MemAvailable is under the build's 10 GB
   heap plus a margin (saman's swap was full on 2026-11-08); one check and one red test beside
   the disk and load guards.
4. **Show Kartverket's credit where a pin came from it** (1 h, in Gable): the geocode answer
   carries `attribution` (`© Kartverket (CC BY 4.0)`) and Gable's editor drops it; one text in the
   message catalog (all languages), one line under the address field, a staging screenshot
   (Gable rule 8). CC BY 4.0 asks for it (`docs/kartverket-terms.md`).
5. **Joined abbreviations in addresses** (1.5 h): «Kirkegt. 3» and the like («-gt.», «-vn.», «-v.»,
   «-pl.») spelled out in `kartverketQuery` as «gt.» already is; a suffix table, fixtures and
   tests for each.
6. **Misspelled streets** (3 h): retry a zero-hit `sok` once with Kartverket's `fuzzy=true`
   (openapi.json, 2026-11-08), and loosen `hitMatchesQuery` for that retry only (street within a
   small edit distance, the number exact), so a near miss still never becomes a wrong pin;
   fixtures from real misses, tests both ways.
7. **Rollback for the renderer image** (3 h): today `compose up --build` overwrites
   `gable-maps:latest` with no way back. Tag each build with its commit, keep current + previous,
   and a deploy script that starts the new image on a scratch port, proves one render, then
   swaps 8215 and can switch back to the previous tag in one command.
8. **Watch Kartverket's notice register** (2 h): poll
   `https://register.geonorge.no/api/register/varsler` for alerts on the address API's record
   (`44eeffdc-…`) and raise an alert, so the 3-month notice reaches us (`docs/kartverket-terms.md`).
9. **Tiles beyond Norway's border** (4 h, needs a disk decision): a render near Svinesund or in
   Finnmark shows only ocean and Natural Earth across the border. Merge Geofabrik's Sweden and
   Finland (osmium extract to a buffer around Norway) into the build input, measure the peak,
   and only ship it if it stays under the 10 GB budget or ashguard raises it.
10. **Self-hosted address lookup** (8 h, only if Kartverket's API changes or limits us): load
    «Matrikkelen - Adresse» (CSV, CC BY 4.0) into a local table on a schedule and answer `sok` and
    `punktsok` from it; a loader, a table, a search, a refresh job and the same tests as now.

## SEO & Discoverability

- [ ] **Google Search Console** — Submit sitemap, monitor indexing, and track keyword performance (see setup steps below)
- [ ] **Blog / content pages** — Add server-rendered pages (e.g. "How to create a free map poster") to drive organic traffic; an SPA alone is limited since Google mostly sees a single URL
- [ ] **Submit to directories** — List Terraink on Product Hunt, AlternativeTo, Futurepedia, and similar design-tool directories
- [ ] **OpenStreetMap community** — Showcase Terraink in OSM forums, wiki tool pages, and community channels
- [ ] **Backlink outreach** — Reach out to map/design blogs for reviews or mentions
- [ ] **Social media presence** — Regular posts showcasing poster examples on Instagram, Reddit (r/MapPorn, r/Design), and X/Twitter to build domain authority

## Code Quality

- [ ] **TypeScript strict mode** — Migrate to `strict: true` and remove `allowJs`; currently gradual (`strict: false`, `allowJs: true`)
- [ ] **Fix pre-existing type errors** — `pngExporter.ts`, `StartupLocationModal.tsx`, `typography.ts` have unresolved TS errors

## Features

- [ ] **Expand export formats** — Additional export options or quality settings beyond current PNG, PDF, SVG
- [ ] **Markers improvements** — Enhance the `markers` feature (custom icons, bulk import, etc.)
- [ ] **Theme gallery** — Browsable theme previews to make discovery easier
- [ ] **Accessibility audit** — Ensure full keyboard navigation and screen reader support across all features

## Google Search Console Setup

1. Go to https://search.google.com/search-console
2. Click **Add Property** and choose **URL prefix** method
3. Enter `https://terraink.app`
4. Verify ownership using one of these methods:
   - **HTML meta tag** (easiest): Add the verification `<meta>` tag Google gives you to `index.html` `<head>`
   - **DNS TXT record**: Add a TXT record to your domain's DNS settings
   - **HTML file**: Upload a verification HTML file to `public/`
5. Once verified:
   - Go to **Sitemaps** in the left sidebar
   - Submit `https://terraink.app/sitemap.xml`
   - Go to **URL Inspection** and request indexing for `https://terraink.app`
6. Monitor the **Performance** tab for keyword impressions, clicks, and average position
