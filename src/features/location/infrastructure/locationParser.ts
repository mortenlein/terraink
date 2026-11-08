import type { Location, SearchResult } from "../domain/types";

/** The entry shape the parser reads (geocodeAdapter.ts toEntries builds it from /geocode). */
interface GeocodeEntry {
  lat?: number | string;
  lon?: number | string;
  display_name?: string;
  label?: string;
  place_id?: number | string;
  city?: string;
  country?: string;
  address?: Record<string, string>;
}

function inferContinentFromCoordinates(lat: number, lon: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
  if (lat <= -60) return "Antarctica";
  if (lat >= 5 && lat <= 82 && lon >= -170 && lon <= -20) return "North America";
  if (lat <= 15 && lat >= -60 && lon >= -92 && lon <= -30) return "South America";
  if (lat >= 35 && lon >= -25 && lon <= 60) return "Europe";
  if (lat >= -35 && lat <= 37 && lon >= -20 && lon <= 55) return "Africa";
  if (lat >= -10 && lon >= 110 && lon <= 180) return "Oceania";
  if (lat >= -50 && lon >= 110 && lon <= 180) return "Oceania";
  if (lon >= 25 && lon <= 180) return "Asia";
  return "";
}

function pickFirstAddressValue(
  address: Record<string, string>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = address[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

export function normalizeLocationResult(
  entry: GeocodeEntry | null | undefined,
  fallbackLabel = "",
): SearchResult | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const lat = Number(entry.lat);
  const lon = Number(entry.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  const label = String(
    entry.display_name ?? entry.label ?? fallbackLabel,
  ).trim();
  if (!label) {
    return null;
  }

  const address = entry.address ?? {};
  const city =
    pickFirstAddressValue(address, [
      "city",
      "town",
      "village",
      "hamlet",
      "municipality",
      "county",
      "state",
    ]) || String(entry.city ?? "").trim();
  const country =
    pickFirstAddressValue(address, ["country"]) ||
    String(entry.country ?? "").trim();
  const countryCode = pickFirstAddressValue(address, ["country_code"]).toUpperCase();
  const continent =
    pickFirstAddressValue(address, ["continent"]) ||
    inferContinentFromCoordinates(lat, lon);

  return {
    id: String(entry.place_id ?? label),
    label,
    city,
    country,
    countryCode,
    continent,
    lat,
    lon,
  };
}

export function parseLocationResponseItems(payload: unknown): SearchResult[] {
  const entries = Array.isArray(payload) ? (payload as GeocodeEntry[]) : [];
  const suggestions: SearchResult[] = [];
  const seenLabels = new Set<string>();

  for (const entry of entries) {
    const normalized = normalizeLocationResult(entry);
    if (!normalized) {
      continue;
    }

    const labelKey = normalized.label.toLowerCase();
    if (seenLabels.has(labelKey)) {
      continue;
    }

    seenLabels.add(labelKey);
    suggestions.push(normalized);
  }

  return suggestions;
}
