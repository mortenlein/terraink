/**
 * GET /geocode proxies Nominatim under its usage policy
 * (https://operations.osmfoundation.org/policies/nominatim/):
 * - identification: a User-Agent naming this application and a contact
 *   e-mail (NOMINATIM_CONTACT); without a contact we refuse to call at all;
 * - at most 1 request per second, across all callers of this service;
 * - results cached on disk (30 days) keyed by the normalised query, so the
 *   same address is asked once.
 * The public instance is PROVISIONAL for Gable: Kartverket's address data is
 * the alternative for Norwegian addresses (Gable OPEN_QUESTIONS).
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

export class GeocodeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let nextSlot = 0;
let gate: Promise<unknown> = Promise.resolve();

/** Serialises upstream calls and spaces them at least 1 s apart. */
function throttled<T>(job: () => Promise<T>): Promise<T> {
  const run = gate.then(async () => {
    const wait = nextSlot - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await job();
    } finally {
      nextSlot = Date.now() + config.geocodeMinIntervalMs;
    }
  });
  gate = run.catch(() => {});
  return run;
}

function cacheFile(key: string): string {
  return path.join(config.geocodeCacheDir, `${createHash("sha256").update(key).digest("hex")}.json`);
}

export async function geocode(
  q: string,
  limit: number,
): Promise<{ query: string; cached: boolean; results: GeocodeResult[] }> {
  const normalised = normaliseQuery(q);
  if (!normalised || normalised.length > 300) throw new GeocodeError("q must be 1 to 300 characters", 400);
  const key = `${normalised}|${limit}`;
  const file = cacheFile(key);

  try {
    const hit = JSON.parse(await readFile(file, "utf8")) as { at: number; results: GeocodeResult[] };
    if (Date.now() - hit.at < config.geocodeCacheTtlMs) return { query: normalised, cached: true, results: hit.results };
  } catch {
    // miss
  }

  if (!config.nominatimContact) {
    throw new GeocodeError("geocoding is disabled: NOMINATIM_CONTACT is not set (Nominatim requires identification)", 503);
  }

  const results = await throttled(async () => {
    const url = new URL("/search", config.nominatimUrl);
    url.searchParams.set("q", normalised);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("accept-language", "nb,en");
    const res = await fetch(url, {
      headers: { "User-Agent": `${config.userAgent} contact: ${config.nominatimContact}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new GeocodeError(`Nominatim answered ${res.status}`, 502);
    const rows = (await res.json()) as Array<{ lat: string; lon: string; display_name: string; type?: string }>;
    return rows.map((r) => ({ lat: Number(r.lat), lng: Number(r.lon), displayName: r.display_name, type: r.type ?? "" }));
  });

  await mkdir(config.geocodeCacheDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ at: Date.now(), q: normalised, results }));
  await rename(tmp, file);
  return { query: normalised, cached: false, results };
}
