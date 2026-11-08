/**
 * GET /geocode (address -> coordinates) and GET /reverse (coordinates -> nearest address),
 * answered from Kartverket's open address API (Åpent adresse-API, the official addresses in
 * the matrikkel). Decided by Morten 2026-11-07 (gable DECISIONS.md): our own service, no public
 * Nominatim.
 *
 * Source and terms, read 2026-11-08:
 * - https://api.kartverket.no/adresser/v1/ is the distribution URL in Kartverket's catalogue record
 *   (https://kartkatalog.geonorge.no/api/getdata/44eeffdc-6069-4000-a49b-2d6bfc59ac61);
 *   https://ws.geonorge.no/adresser/v1/ answers the same API (its OpenAPI: /openapi.json there).
 * - No login or key ("Det er ikke nødvendig med innlogging/autorisasjon", openapi.json info);
 *   licence CC BY 4.0 (catalogue record, Constraints), so every answer carries Kartverket's credit.
 * - Not for bulk extraction ("egner seg ikke for å hente ut komplette datasett"); breaking changes
 *   are announced 3 months ahead on https://geonorge.no/aktuelt/varsler/Tjenestevarsler/.
 *   No rate limit is published: we still serialise calls and space them (judgement), and cache
 *   answers on disk for 30 days, keyed by the normalised query.
 *
 * Kartverket's `sok` ANDs every word, so a word that is in no address field gives zero hits. Gable
 * sends "<address>, Norge" (gable app/src/components/edit/sections.tsx): the country is dropped.
 * The answer keeps the shape Gable reads (gable app/src/lib/edit/geocode.ts firstHit):
 * { query, cached, results: [{ lat, lng, displayName, type }] }, plus `attribution`.
 * Coordinates are EUREF89 (EPSG:4258), within a metre of WGS84 in Norway.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { normaliseQuery } from "./validate";

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
  type: string;
}

export interface GeocodeAnswer {
  query: string;
  cached: boolean;
  results: GeocodeResult[];
  attribution: string;
}

export const GEOCODE_ATTRIBUTION = "© Kartverket (CC BY 4.0)";

export class GeocodeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Injected in tests; the defaults come from config. */
export interface GeocodeDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  cacheDir?: string;
  minIntervalMs?: number;
}

/** Country words Gable (or a person) appends; Kartverket only has Norwegian addresses. */
const COUNTRY_WORDS = new Set(["norge", "norway", "noreg"]);

/** The normalised query as Kartverket's `sok` wants it: no trailing country word. */
export function kartverketQuery(normalised: string): string {
  const words = normalised.split(" ").filter(Boolean);
  while (words.length > 1 && COUNTRY_WORDS.has(words[words.length - 1].replace(/\.$/, ""))) words.pop();
  return words.join(" ");
}

interface KartverketAddress {
  adressetekst?: string;
  postnummer?: string;
  poststed?: string;
  objtype?: string;
  representasjonspunkt?: { lat?: number; lon?: number };
}

/** One Kartverket address row -> our result, or null when it has no point. Pure. */
export function toResult(a: KartverketAddress): GeocodeResult | null {
  const lat = a.representasjonspunkt?.lat;
  const lng = a.representasjonspunkt?.lon;
  if (typeof lat !== "number" || !Number.isFinite(lat) || typeof lng !== "number" || !Number.isFinite(lng)) return null;
  const place = [a.postnummer, a.poststed].filter(Boolean).join(" ");
  const displayName = [a.adressetekst, place].filter(Boolean).join(", ");
  return { lat, lng, displayName, type: a.objtype ?? "" };
}

export function parseAddresses(body: unknown): GeocodeResult[] {
  const rows = body && typeof body === "object" ? (body as { adresser?: unknown }).adresser : null;
  if (!Array.isArray(rows)) throw new GeocodeError("Kartverket answered without an adresser list", 502);
  return rows.map((r) => toResult((r ?? {}) as KartverketAddress)).filter((r): r is GeocodeResult => r !== null);
}

let nextSlot = 0;
let gate: Promise<unknown> = Promise.resolve();

/** Serialises upstream calls and spaces them at least minIntervalMs apart. */
function throttled<T>(minIntervalMs: number, job: () => Promise<T>): Promise<T> {
  const run = gate.then(async () => {
    const wait = nextSlot - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await job();
    } finally {
      nextSlot = Date.now() + minIntervalMs;
    }
  });
  gate = run.catch(() => {});
  return run;
}

/**
 * The provider is in the key: the cache volume still holds 30 days of Nominatim answers from
 * before 2026-11-08, and those must never be served as Kartverket's.
 */
function cacheFile(dir: string, key: string): string {
  return path.join(dir, `${createHash("sha256").update(`kartverket|${key}`).digest("hex")}.json`);
}

async function cachedAsk(
  key: string,
  deps: GeocodeDeps,
  ask: (fetchImpl: typeof fetch, base: string) => Promise<GeocodeResult[]>,
): Promise<{ cached: boolean; results: GeocodeResult[] }> {
  const dir = deps.cacheDir ?? config.geocodeCacheDir;
  const file = cacheFile(dir, key);
  try {
    const hit = JSON.parse(await readFile(file, "utf8")) as { at: number; results: GeocodeResult[] };
    if (Date.now() - hit.at < config.geocodeCacheTtlMs) return { cached: true, results: hit.results };
  } catch {
    // miss
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = (deps.baseUrl ?? config.geocoderUrl).replace(/\/+$/, "");
  const results = await throttled(deps.minIntervalMs ?? config.geocodeMinIntervalMs, () => ask(fetchImpl, base));
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ at: Date.now(), key, results }));
  await rename(tmp, file);
  return { cached: false, results };
}

async function getJson(fetchImpl: typeof fetch, url: URL): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { "User-Agent": config.userAgent, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new GeocodeError(`Kartverket unreachable (${e instanceof Error ? e.name : String(e)})`, 502);
  }
  if (!res.ok) throw new GeocodeError(`Kartverket answered ${res.status}`, 502);
  try {
    return await res.json();
  } catch {
    throw new GeocodeError("Kartverket answered something that is not JSON", 502);
  }
}

export async function geocode(q: string, limit: number, deps: GeocodeDeps = {}): Promise<GeocodeAnswer> {
  const normalised = normaliseQuery(q);
  if (!normalised || normalised.length > 300) throw new GeocodeError("q must be 1 to 300 characters", 400);
  const sok = kartverketQuery(normalised);
  const answer = await cachedAsk(`sok|${sok}|${limit}`, deps, async (fetchImpl, base) => {
    const url = new URL(`${base}/sok`);
    url.searchParams.set("sok", sok);
    url.searchParams.set("treffPerSide", String(limit));
    url.searchParams.set("utkoordsys", "4258");
    return parseAddresses(await getJson(fetchImpl, url));
  });
  return { query: sok, ...answer, attribution: GEOCODE_ATTRIBUTION };
}

/** The nearest official address within `radius` metres of a point (Kartverket /punktsok). */
export async function reverseGeocode(lat: number, lng: number, deps: GeocodeDeps = {}, radius = 200): Promise<GeocodeAnswer> {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new GeocodeError("lat and lng must be coordinates", 400);
  }
  // ~1 m: nearer points share a cache entry.
  const rl = lat.toFixed(5);
  const rg = lng.toFixed(5);
  const answer = await cachedAsk(`punktsok|${rl}|${rg}|${radius}`, deps, async (fetchImpl, base) => {
    const url = new URL(`${base}/punktsok`);
    url.searchParams.set("lat", rl);
    url.searchParams.set("lon", rg);
    url.searchParams.set("radius", String(radius));
    url.searchParams.set("treffPerSide", "1");
    url.searchParams.set("koordsys", "4258");
    url.searchParams.set("utkoordsys", "4258");
    return parseAddresses(await getJson(fetchImpl, url));
  });
  return { query: `${rl},${rg}`, ...answer, attribution: GEOCODE_ATTRIBUTION };
}
