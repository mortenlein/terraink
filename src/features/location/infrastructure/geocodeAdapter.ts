import type { ICache } from "@/core/cache/ports";
import type { IHttp } from "@/core/http/ports";
import type { IGeocodePort } from "../domain/ports";
import type { SearchResult } from "../domain/types";
import {
  normalizeLocationResult,
  parseLocationResponseItems,
} from "./locationParser";
import { GEOCODE_TTL_MS, LOCATION_SEARCH_TTL_MS } from "./constants";
import {
  getGeocodeCacheKey,
  getLocationSearchCacheKey,
  getReverseGeocodeCacheKey,
} from "./cacheKeys";

/**
 * The editor's geocoding goes through this service's own /geocode and /reverse (server/geocode.ts:
 * Kartverket's address API, cached and throttled there), never to a public geocoder from the
 * browser (Morten 2026-11-07, gable DECISIONS.md). Kartverket has Norwegian addresses only, so a
 * place outside Norway, or a bare city name, finds nothing.
 */
interface ServerResult {
  lat: number;
  lng: number;
  displayName: string;
}

/** "Storgata 1, 8622 MO I RANA" -> the place after the postcode, as the city. */
function cityOf(displayName: string): string {
  const m = /,\s*\d{4}\s+(.+)$/.exec(displayName);
  return m ? m[1] : "";
}

/** The server's answer -> the entry shape locationParser reads. */
export function toEntries(payload: unknown): Record<string, unknown>[] {
  const results = (payload as { results?: ServerResult[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({
    lat: r.lat,
    lon: r.lng,
    display_name: r.displayName,
    address: { city: cityOf(r.displayName), country: "Norway", country_code: "no" },
  }));
}

// Deduplicate concurrent requests for the same query/coordinates
const inFlightSearchRequests = new Map<string, Promise<SearchResult[]>>();
const inFlightReverseRequests = new Map<string, Promise<SearchResult>>();

export function createGeocodeAdapter(
  http: IHttp,
  cache: ICache,
): IGeocodePort {
  async function searchLocations(
    query: string,
    limit = 6,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const lookup = String(query ?? "").trim();
    if (lookup.length < 2) {
      return [];
    }

    const normalizedLimit = Math.max(1, Math.min(Math.round(limit), 10));
    const cacheKey = getLocationSearchCacheKey(lookup, normalizedLimit);
    const cached = cache.read<SearchResult[]>(cacheKey, LOCATION_SEARCH_TTL_MS);
    if (Array.isArray(cached)) {
      return cached;
    }

    if (inFlightSearchRequests.has(cacheKey)) {
      return inFlightSearchRequests.get(cacheKey)!;
    }

    const url = `/geocode?limit=${normalizedLimit}&q=${encodeURIComponent(lookup)}`;

    const promise = http
      .get(url, { headers: { Accept: "application/json" }, signal }, 16_000)
      .then(async (response) => {
        const data = await response.json();
        const results = parseLocationResponseItems(toEntries(data));
        cache.write(cacheKey, results);
        return results;
      })
      .finally(() => {
        inFlightSearchRequests.delete(cacheKey);
      });

    inFlightSearchRequests.set(cacheKey, promise);
    return promise;
  }

  async function geocodeLocation(query: string): Promise<SearchResult> {
    const lookup = String(query ?? "").trim();
    if (!lookup) {
      throw new Error("Location is required.");
    }

    const cacheKey = getGeocodeCacheKey(lookup);
    const cached = cache.read<Record<string, unknown>>(
      cacheKey,
      GEOCODE_TTL_MS,
    );
    if (cached && typeof cached === "object") {
      const normalizedCached = normalizeLocationResult(cached as any, lookup);
      if (normalizedCached) {
        return normalizedCached;
      }
    }

    const results = await searchLocations(lookup, 1);
    if (results.length === 0) {
      throw new Error(`No coordinates found for "${lookup}"`);
    }

    const first = results[0];
    cache.write(cacheKey, first);
    return first;
  }

  async function geocodeCity(
    city: string,
    country: string,
  ): Promise<{ lat: number; lon: number; displayName: string }> {
    const lookup = `${city}, ${country}`.trim();
    const location = await geocodeLocation(lookup);
    return {
      lat: location.lat,
      lon: location.lon,
      displayName: location.label,
    };
  }

  async function reverseGeocode(lat: number, lon: number): Promise<SearchResult> {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error("Latitude and longitude are required.");
    }

    const cacheKey = getReverseGeocodeCacheKey(lat, lon);
    const cached = cache.read<Record<string, unknown>>(cacheKey, GEOCODE_TTL_MS);
    if (cached && typeof cached === "object") {
      const normalizedCached = normalizeLocationResult(cached as any);
      if (normalizedCached) {
        return normalizedCached;
      }
    }

    if (inFlightReverseRequests.has(cacheKey)) {
      return inFlightReverseRequests.get(cacheKey)!;
    }

    const url = `/reverse?lat=${encodeURIComponent(String(lat))}&lng=${encodeURIComponent(String(lon))}`;

    const promise = http
      .get(url, { headers: { Accept: "application/json" } }, 16_000)
      .then(async (response) => {
        const data = await response.json();
        const normalized = normalizeLocationResult(toEntries(data)[0] as any);
        if (!normalized) {
          throw new Error("No nearby city found for the selected coordinates.");
        }
        cache.write(cacheKey, normalized);
        return normalized;
      })
      .finally(() => {
        inFlightReverseRequests.delete(cacheKey);
      });

    inFlightReverseRequests.set(cacheKey, promise);
    return promise;
  }

  return { searchLocations, geocodeLocation, reverseGeocode, geocodeCity };
}
