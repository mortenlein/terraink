import { expect, test } from "bun:test";
import { DEFAULT_GEOCODER_URL, DEFAULT_GLYPHS_URL, DEFAULT_TILE_URL, loadConfig } from "./config";

// Morten 2026-11-07 (gable DECISIONS.md): our own tiles and Kartverket, never the public services.
const PUBLIC_HOSTS = /openfreemap\.org|nominatim\.openstreetmap\.org/;

test("the defaults are the self-hosted tiles and Kartverket, not the public services", () => {
  const c = loadConfig({});
  expect(c.tileUrl).toBe(DEFAULT_TILE_URL);
  expect(c.glyphsUrl).toBe(DEFAULT_GLYPHS_URL);
  expect(c.geocoderUrl).toBe(DEFAULT_GEOCODER_URL);
  for (const url of [c.tileUrl, c.glyphsUrl, c.geocoderUrl]) expect(url).not.toMatch(PUBLIC_HOSTS);
  expect(new URL(c.tileUrl).host).toBe("gable-maps-tiles:3000");
  expect(new URL(c.geocoderUrl).host).toBe("api.kartverket.no");
  expect(c.glyphsUrl).toContain("{fontstack}");
  expect(c.glyphsUrl).toContain("{range}");
});

test("every base URL can be moved by the environment; empty means the default", () => {
  const c = loadConfig({ TILE_URL: "http://t:1/x", GLYPHS_URL: "http://t:1/f/{fontstack}/{range}", GEOCODER_URL: "https://ws.geonorge.no/adresser/v1" });
  expect(c.tileUrl).toBe("http://t:1/x");
  expect(c.glyphsUrl).toBe("http://t:1/f/{fontstack}/{range}");
  expect(c.geocoderUrl).toBe("https://ws.geonorge.no/adresser/v1");
  expect(loadConfig({ TILE_URL: "", GEOCODER_URL: "" }).tileUrl).toBe(DEFAULT_TILE_URL);
  expect(loadConfig({ GEOCODER_URL: "" }).geocoderUrl).toBe(DEFAULT_GEOCODER_URL);
});
