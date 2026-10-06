/** Server configuration, all from the environment (see ../.env.example and infra/compose.yml). */
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** The built app (vite build): index.html is the editor, render.html the headless page. */
  distDir: process.env.DIST_DIR ?? path.join(root, "dist"),
  presetsDir: process.env.PRESETS_DIR ?? path.join(root, "presets"),
  /**
   * TileJSON URL of an OpenMapTiles-schema vector source. OpenFreeMap's
   * public planet is the default and is PROVISIONAL: the tile source for
   * customer sites is an open decision on the Gable side (OPEN_QUESTIONS).
   */
  tileUrl: process.env.TILE_URL ?? "https://tiles.openfreemap.org/planet",
  /**
   * Glyph PBF template for map names (presets' `labels`). OpenFreeMap serves
   * the Noto Sans stacks (Regular, Italic, Bold) at this path; the URL is the
   * `glyphs` of its own styles (https://tiles.openfreemap.org/styles/liberty,
   * read 2026-10-06). Other fonts need PBF glyphs we generate and serve.
   */
  glyphsUrl: process.env.GLYPHS_URL || "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  /** Overrides the attribution read from the TileJSON. Never empty. */
  attributionOverride: (process.env.MAP_ATTRIBUTION ?? "").trim(),
  /** Contact e-mail for Nominatim's identification rule; geocoding is refused without it. */
  nominatimContact: (process.env.NOMINATIM_CONTACT ?? "").trim(),
  nominatimUrl: process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org",
  geocodeCacheDir: process.env.GEOCODE_CACHE_DIR ?? path.join(root, ".cache", "geocode"),
  geocodeCacheTtlMs: 30 * 24 * 60 * 60 * 1000,
  /** Nominatim policy: an absolute maximum of 1 request per second. */
  geocodeMinIntervalMs: 1000,
  maxDimension: 2400,
  minDimension: 64,
  renderTimeoutMs: 30_000,
  /** Renders run one at a time; beyond this many waiting, new requests get 503. */
  maxQueue: 10,
  chromiumPath: process.env.CHROMIUM_PATH || undefined,
  userAgent: "gable-maps/0.1 (+https://github.com/mortenlein/terraink)",
};
