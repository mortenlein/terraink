# Kartverket's address API: terms for server-side lookups

What the renderer's geocoder (`server/geocode.ts`, `GET /geocode` and `GET /reverse`) depends on,
read from the primary sources on 2026-11-08. Every claim names its source; **judgement** marks
our own reading.

## What the sources say

| Claim | Source (read 2026-11-08) |
|---|---|
| The service is «Adresse REST-API», owned by Kartverket, protocol W3C:REST, distribution URL `https://api.kartverket.no/adresser/v1/` (operations `sok` and `punktsok`). | Catalogue record, https://kartkatalog.geonorge.no/api/getdata/44eeffdc-6069-4000-a49b-2d6bfc59ac61 |
| Licence CC BY 4.0 (`OtherConstraintsLink` https://creativecommons.org/licenses/by/4.0/), access «Åpne data», no limitation on public access (INSPIRE `noLimitations`). | Same record, `Constraints` |
| Declared service level: availability at least 98 % of the year, capacity at least 10 simultaneous requests within the declared performance, response time 4 seconds («Tilgjengelighet: 98%», «Kapasitet: 10 samtidige forespørsler», «Responstid: 4 sekunder»). These are estimates in metadata, not a contract. | Same record, `QualitySpecifications` / `QuantitativeResult` |
| The data is a distribution copy of the matrikkel, «normalt oppdateres daglig». | Same record, `Abstract` |
| «Det er ikke nødvendig med innlogging/autorisasjon for å bruke API-et.» (no key, no login) | OpenAPI, https://ws.geonorge.no/adresser/v1/openapi.json, `info.description` (version 1.2.0) |
| «Større funksjonalitetsødeleggende endringer i API-et vil bli annonsert minst 3 måneder i forveien på https://geonorge.no/aktuelt/varsler/Tjenestevarsler/» | Same, `info.description` |
| «API-et returnerer kun de første 10 000 resultatene. Hvis man ønsker å hente ned større datasett så anbefales det å laste ned filene som er tilgjengelige fra https://geonorge.no.» `treffPerSide` is at most 1000. | Same, `info.description` and parameters |
| «API-et egner seg ikke for å hente ut komplette datasett.» | Catalogue record (as above) |
| No rate limit is published, neither in the API's description nor in the catalogue record. | Both of the above: searched, none found |
| The general terms: Kartverket's free products are CC BY 4.0; the credit is «© Kartverket», with a link to their site where possible; some APIs/services «har tekniske avgrensingar»; the products are distributed «slik dei er», and Kartverket «tar ikkje noko ansvar for bruk og vidarebruk». Nothing on rate limits, fair use, blocking or bulk use. | «Vilkår for bruk av Kartverkets opne data», https://www.kartverket.no/api-og-data/vilkar-for-bruk (page dated «Siste oppdatering 21.07.26») |
| The notice page redirects to a machine-readable register, `https://register.geonorge.no/api/register/varsler` (JSON, 1766 alerts on 2026-11-08). Earlier alerts titled «Adresse REST-API» are dated 2020-12-01 and 2022-05-16. | Fetched 2026-11-08 |
| The whole address register is downloadable as open data: «Matrikkelen - Adresse» (CSV, FGDB, GML, PostGIS, SOSI; CC BY 4.0, «Ingen begrensninger på bruk er oppgitt», maintained «Kontinuerlig»; via `https://nedlasting.geonorge.no/api/capabilities/`). | https://kartkatalog.geonorge.no/api/getdata/f7df7a18-b30f-4745-bd64-d0863812350c |

## How we use it (from the code)

- One address lookup (`sok`) or nearest-address lookup (`punktsok`) per owner action in Gable's
  editor, never a crawl. Calls are serialised and spaced at least 250 ms apart
  (`server/config.ts:39`, `geocodeMinIntervalMs: 250`; `server/geocode.ts` `throttled`).
- Answers are cached on disk for 30 days, keyed by the normalised query
  (`server/config.ts:37`, `geocodeCacheTtlMs`; `server/geocode.ts` `cachedAsk`).
- Norwegian addresses only: a trailing «Norge/Norway/Noreg» is dropped (`server/geocode.ts:63`),
  a query with no number gets no lookup at all, and a hit whose street and number are not in the
  query is dropped.
- Every answer carries `© Kartverket (CC BY 4.0)` (`server/geocode.ts:46`, `GEOCODE_ATTRIBUTION`).
  Whether Gable shows it to the owner is an open item (ROADMAP.md).

**Judgement:** at that volume (one request per owner edit, under 4 a second at the very worst,
far fewer after the cache) we are well inside the declared capacity of 10 simultaneous requests
and nowhere near «complete datasets», which is what the terms warn against. A mass job (geocoding
every prospect from the Business Register, say) is a different use: that is what the download
is for, and it should not go through this API.

## What we depend on, and the way out

We depend on: the API staying open without a key, its response shape (`adresser[]` with
`representasjonspunkt`), and roughly 98 % availability. None of it is a contract: the terms are
as-is with no liability (Vilkår for bruk, above).

If it changes (in order of effort, **judgement**):

1. **Cached geocodes:** an address already looked up is answered from the 30-day cache; and a site
   that is published keeps the coordinates it was built with, so an outage only stops new pins.
2. **The owner places the pin:** coordinates entered or dragged by hand. No dependency at all;
   worse for the owner.
3. **Self-hosted address data:** load «Matrikkelen - Adresse» (CSV or PostGIS, CC BY 4.0) into
   our own table and answer `sok`/`punktsok` from it, refreshed on a schedule. Removes the
   dependency; costs a loader, a table and a refresh job.

Watching for change: a breaking change is announced at least 3 months ahead in the notice
register above. Nobody polls it today; a watcher that looks for alerts on record
`44eeffdc-6069-4000-a49b-2d6bfc59ac61` is on the list in ROADMAP.md.
