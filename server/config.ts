/** Server configuration, all from the environment (see infra/.env.example and infra/compose.yml). */
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");

/**
 * The self-hosted tile service (infra/compose.yml service `tiles`, container gable-maps-tiles:
 * martin serving infra/build-tiles.sh's Norway OpenMapTiles extract). The renderer reaches it by
 * its compose name on the project network: inside this container 127.0.0.1 is the container
 * itself, and the host's 127.0.0.1:8216 is for checks from the host only. Decided by Morten
 * 2026-11-07 (gable DECISIONS.md): no public OpenFreeMap tiles.
 */
export const DEFAULT_TILE_URL = "http://gable-maps-tiles:3000/norway";
/** martin cuts glyph PBFs from the TTFs it serves (/font/{fontstack}/{start}-{end}). */
export const DEFAULT_GLYPHS_URL = "http://gable-maps-tiles:3000/font/{fontstack}/{range}";
/** Kartverket's open address API (server/geocode.ts has the source and terms). */
export const DEFAULT_GEOCODER_URL = "https://api.kartverket.no/adresser/v1";

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  return {
    port: Number(env.PORT ?? 3000),
    /** The built app (vite build): index.html is the editor, render.html the headless page. */
    distDir: env.DIST_DIR ?? path.join(root, "dist"),
    presetsDir: env.PRESETS_DIR ?? path.join(root, "presets"),
    /** TileJSON URL of an OpenMapTiles-schema vector source. */
    tileUrl: env.TILE_URL || DEFAULT_TILE_URL,
    /**
     * Glyph PBF template for map names (presets' `labels`, which ask for "Noto Sans Regular";
     * the tile service serves Noto Sans Regular, Bold and Italic under those stack names).
     */
    glyphsUrl: env.GLYPHS_URL || DEFAULT_GLYPHS_URL,
    /** Overrides the attribution read from the TileJSON. Never empty on an image. */
    attributionOverride: (env.MAP_ATTRIBUTION ?? "").trim(),
    /** Base of Kartverket's address API (…/sok, …/punktsok). */
    geocoderUrl: env.GEOCODER_URL || DEFAULT_GEOCODER_URL,
    geocodeCacheDir: env.GEOCODE_CACHE_DIR ?? path.join(root, ".cache", "geocode"),
    geocodeCacheTtlMs: 30 * 24 * 60 * 60 * 1000,
    /** Kartverket publishes no rate limit; calls are still serialised and spaced (judgement). */
    geocodeMinIntervalMs: 250,
    maxDimension: 2400,
    minDimension: 64,
    renderTimeoutMs: 30_000,
    /** Renders run one at a time; beyond this many waiting, new requests get 503. */
    maxQueue: 10,
    chromiumPath: env.CHROMIUM_PATH || undefined,
    userAgent: "gable-maps/0.1 (+https://github.com/mortenlein/terraink)",
  };
}

export const config = loadConfig();
