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
 * A query without any number is answered with no hit, and a hit whose own street and number are
 * not in the query is dropped (geocode(), hitMatchesQuery): no answer is better than a wrong pin.
 * When the exact ask leaves nothing, it is asked once more with fuzzy=true (a second call, spaced
 * like the first), and only a near miss of the street with the exact number and place is kept
 * (fuzzyHitMatchesQuery).
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

/**
 * Abbreviations written joined to the street name ("kirkegt.", "drammensvn."), spelled out.
 * Measured 2026-11-19: "kirkegt. 3 arendal" and "kirkegt 3 arendal" find nothing, "kirkegata 3
 * arendal" finds Kirkegaten 3. Kartverket's sok treats gata/gaten/gate, vei/veien and
 * plass/plassen as one word, so one spelled-out form per suffix finds them all. It does NOT treat
 * vei and veg as one ("svinesundsvegen" finds nothing where "svinesundsveien" finds Gamle
 * Svinesundsvei): "-v."/"-vn." are spelled out in bokmål, and a nynorsk "-vegen" street is left to
 * the fuzzy retry.
 * Only with the dot, and only after a stem of at least two letters: without the dot, "nyhavn" and
 * "navn" end in "vn", "langt" in "gt"; a one-letter stem is "rv."/"fv." (riksvei, fylkesvei) or
 * "v." for "ved".
 */
const JOINED_ABBREVIATIONS: ReadonlyArray<readonly [string, string]> = [
  ["gt.", "gata"],
  ["vn.", "veien"],
  ["v.", "veien"],
  ["pl.", "plass"],
];

function spellOutJoined(word: string): string {
  for (const [suffix, full] of JOINED_ABBREVIATIONS) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, -suffix.length);
    return /^\p{L}{2,}$/u.test(stem) ? stem + full : word;
  }
  return word;
}

/**
 * The normalised query as Kartverket's `sok` wants it: no trailing country word, a standalone
 * "gt."/"gt" spelled out as "gate" (the register has no abbreviations; "karl johans gt 1 oslo" finds
 * nothing, 2026-11-08), a joined one ("kirkegt.", JOINED_ABBREVIATIONS) spelled out, and a house
 * letter joined to its number.
 */
export function kartverketQuery(normalised: string): string {
  const words = normalised
    .split(" ")
    .filter(Boolean)
    .map((w) => (w === "gt" || w === "gt." ? "gate" : spellOutJoined(w)));
  while (words.length > 1 && COUNTRY_WORDS.has(words[words.length - 1].replace(/\.$/, ""))) words.pop();
  // "2 b" -> "2b": the register's house letter only matches joined to its number (2026-11-08).
  return words.join(" ").replace(/(^| )(\d+) ([a-zæøå])(?= |$)/gu, "$1$2$3");
}

interface KartverketAddress {
  adressenavn?: string;
  adressetekst?: string;
  adressetekstutenadressetilleggsnavn?: string;
  adressetilleggsnavn?: string | null;
  kommunenummer?: string;
  kommunenavn?: string;
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

function addressRows(body: unknown): KartverketAddress[] {
  const rows = body && typeof body === "object" ? (body as { adresser?: unknown }).adresser : null;
  if (!Array.isArray(rows)) throw new GeocodeError("Kartverket answered without an adresser list", 502);
  return rows.map((r) => (r ?? {}) as KartverketAddress);
}

export function parseAddresses(body: unknown): GeocodeResult[] {
  return addressRows(body).map(toResult).filter((r): r is GeocodeResult => r !== null);
}

/** Words for comparing an address with a query: lower case, no punctuation, "6 b" joined as "6b". */
export function addressWords(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/]+/gu, " ")
    .split(" ")
    .filter(Boolean)
    .join(" ")
    .replace(/(^| )(\d+) ([a-zæøå])(?= |$)/gu, "$1$2$3")
    .split(" ")
    .filter(Boolean);
}

/**
 * Whether a hit's own address (street and number, or gnr/bnr) is in the query, word for word.
 * Kartverket's `sok` also matches a number against other fields: "storgata 1 porsgrunn" is answered
 * with Storgata 2 in Brevik, and "8622 mo i rana" with a random cadastral 20/440 (2026-11-08). A hit
 * that fails this is not what was asked for, and a wrong pin is worse than none.
 */
export function hitMatchesQuery(row: KartverketAddress, sok: string): boolean {
  const own = addressWords(row.adressetekstutenadressetilleggsnavn ?? row.adressetekst ?? "").map(foldEnding);
  if (!own.length) return false;
  const asked = new Set(addressWords(sok).map(foldEnding));
  return own.every((w) => asked.has(w));
}

/**
 * The endings Kartverket's sok treats as one word, folded to one form (measured 2026-11-19:
 * "kirkegata", "kirkegate" and "kirkegaten 3 arendal" all answer Kirkegaten 3; "gamle
 * svinesundsveien 112" answers Gamle Svinesundsvei 112; "rådhusplass 1 oslo" answers
 * Rådhusplassen 1). Without it the filter drops the right hit whenever the owner writes the other
 * form. vei/veg are not folded: Kartverket does not treat them as one either.
 */
export function foldEnding(word: string): string {
  return word.replace(/gat(?:a|en)$/u, "gate").replace(/veien$/u, "vei").replace(/plassen$/u, "plass");
}

/** Edits allowed between a street word and the word asked: none under 5 letters, 1 under 9, else 2. */
function maxEdits(length: number): number {
  return length >= 9 ? 2 : length >= 5 ? 1 : 0;
}

/** Optimal string alignment distance (a swap of two neighbours is one edit). */
export function editDistance(a: string, b: string): number {
  const s = Array.from(a);
  const t = Array.from(b);
  const d = Array.from({ length: s.length + 1 }, (_, i) => Array.from({ length: t.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[s.length][t.length];
}

const hasDigit = (w: string) => /\d/.test(w);

function nearWord(own: string, asked: string): boolean {
  if (hasDigit(own) || hasDigit(asked)) return false;
  const allowed = maxEdits(Math.min(Array.from(own).length, Array.from(asked).length));
  if (!allowed) return false;
  return Math.min(editDistance(own, asked), editDistance(foldEnding(own), foldEnding(asked))) <= allowed;
}

/**
 * hitMatchesQuery for the fuzzy retry only. Under fuzzy=true Kartverket no longer guarantees that
 * every query word is in the row (measured 2026-11-19: "kirkegaten 3 arndal" answers Kirkegaten 3,
 * ARENDAL; "kirkevein 3 arendal" answers Flosta Kirkevei 3), so this checks all three parts itself:
 * - every word of the hit's street is in the query, a street word within maxEdits of one;
 * - every number (house number, letter, postcode) is exact;
 * - every query word left over is exactly in the hit's place (postcode, post town, kommune,
 *   additional name). A misspelled town gives no pin: only the street is loosened.
 */
export function fuzzyHitMatchesQuery(row: KartverketAddress, sok: string): boolean {
  const own = addressWords(row.adressetekstutenadressetilleggsnavn ?? row.adressetekst ?? "");
  if (!own.length) return false;
  const left = addressWords(sok);
  const unmatched: string[] = [];
  // Exact words first, so a near match never takes the word another street word needs exactly.
  for (const w of own) {
    const i = left.findIndex((a) => foldEnding(a) === foldEnding(w));
    if (i < 0) unmatched.push(w);
    else left.splice(i, 1);
  }
  for (const w of unmatched) {
    const i = left.findIndex((a) => nearWord(w, a));
    if (i < 0) return false;
    left.splice(i, 1);
  }
  const place = new Set(
    addressWords([row.adressetilleggsnavn, row.postnummer, row.poststed, row.kommunenavn].filter(Boolean).join(" ")),
  );
  return left.every((w) => place.has(w));
}

/** One street: its name (endings folded) in its kommune. */
function streetKey(row: KartverketAddress): string {
  const name = addressWords(row.adressenavn ?? row.adressetekstutenadressetilleggsnavn ?? row.adressetekst ?? "")
    .filter((w) => !hasDigit(w))
    .map(foldEnding)
    .join(" ");
  return `${name}|${row.kommunenummer ?? row.kommunenavn ?? ""}`;
}

/** Hits asked for before the filter, so a right second hit survives a wrong first one. */
const SOK_PAGE = 10;

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
 * The provider and the answer's rules are in the key: the cache volume still holds 30 days of
 * Nominatim answers from before 2026-11-08, and Kartverket answers cached before the hit filter
 * (v2, hitMatchesQuery) the same day; neither may be served. v3 (2026-11-19, foldEnding): under v2
 * "kirkegata 3 arendal" was cached empty although Kirkegaten 3 is the answer. v4 (2026-11-19, the
 * fuzzy retry): a cached answer is now the outcome of both passes, so a v3 empty (exact only) must
 * not stand in for one. Exact and fuzzy share the key on purpose: the cache holds the final
 * answer to the owner's query, and a separate fuzzy entry would buy nothing.
 */
function cacheFile(dir: string, key: string): string {
  return path.join(dir, `${createHash("sha256").update(`kartverket-v4|${key}`).digest("hex")}.json`);
}

/** One upstream call; each goes through the throttle on its own, a retry included. */
type Call = (url: URL) => Promise<unknown>;

async function cachedAsk(
  key: string,
  deps: GeocodeDeps,
  ask: (call: Call, base: string) => Promise<GeocodeResult[]>,
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
  const minIntervalMs = deps.minIntervalMs ?? config.geocodeMinIntervalMs;
  const results = await ask((url) => throttled(minIntervalMs, () => getJson(fetchImpl, url)), base);
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
  // An address has a number (house or postcode). Without one, Kartverket answers with every
  // address in the place, the first a random cadastral one: a wrong pin nobody would notice.
  if (!/\d/.test(sok)) return { query: sok, cached: false, results: [], attribution: GEOCODE_ATTRIBUTION };
  const answer = await cachedAsk(`sok|${sok}|${limit}`, deps, async (call, base) => {
    const sokUrl = (fuzzy: boolean) => {
      const url = new URL(`${base}/sok`);
      url.searchParams.set("sok", sok);
      url.searchParams.set("treffPerSide", String(Math.max(limit, SOK_PAGE)));
      url.searchParams.set("utkoordsys", "4258");
      if (fuzzy) url.searchParams.set("fuzzy", "true");
      return url;
    };
    const toResults = (rows: KartverketAddress[]) =>
      rows
        .map(toResult)
        .filter((r): r is GeocodeResult => r !== null)
        .slice(0, limit);
    const exact = addressRows(await call(sokUrl(false))).filter((row) => hitMatchesQuery(row, sok));
    // Kartverket: fuzzy "er ikke kompatibelt med bruk av wildcard" (openapi.json, 2026-11-08).
    if (exact.length || sok.includes("*")) return toResults(exact);
    // Nothing the exact filter keeps (no raw hit, or only wrong ones such as "olsens" for "olsen"):
    // ask once more with fuzzy=true and keep only near misses of this street with this number.
    const near = addressRows(await call(sokUrl(true))).filter((row) => fuzzyHitMatchesQuery(row, sok));
    // Two different streets near the one asked: Gable pins the first, and Kartverket's ranking must
    // not choose between them.
    if (new Set(near.map(streetKey)).size > 1) return [];
    return toResults(near);
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
  const answer = await cachedAsk(`punktsok|${rl}|${rg}|${radius}`, deps, async (call, base) => {
    const url = new URL(`${base}/punktsok`);
    url.searchParams.set("lat", rl);
    url.searchParams.set("lon", rg);
    url.searchParams.set("radius", String(radius));
    url.searchParams.set("treffPerSide", "1");
    url.searchParams.set("koordsys", "4258");
    url.searchParams.set("utkoordsys", "4258");
    return parseAddresses(await call(url));
  });
  return { query: `${rl},${rg}`, ...answer, attribution: GEOCODE_ATTRIBUTION };
}
