import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LABEL_CLEARANCE_LAYER_ID,
  LABEL_PLACE_LAYER_ID,
  LABEL_ROAD_LAYER_ID,
  labelLayers,
  resolveLabelStyle,
} from "../src/features/map/infrastructure/labelLayers";

const fallback = { text: "#1c1712", land: "#faf6f0" };
const preset = (name: string) =>
  JSON.parse(readFileSync(path.join(import.meta.dir, "..", "presets", `${name}.json`), "utf8"));

describe("resolveLabelStyle", () => {
  test("no labels section means no labels", () => {
    expect(resolveLabelStyle(undefined, fallback)).toBeNull();
    expect(resolveLabelStyle(null, fallback)).toBeNull();
    expect(resolveLabelStyle({}, fallback)).toBeNull();
    // Styling alone, with neither roads nor places named, draws nothing.
    expect(resolveLabelStyle({ size: 11, color: "#5c5045" }, fallback)).toBeNull();
    expect(resolveLabelStyle({ roads: { classes: [] } }, fallback)).toBeNull();
  });

  test("fills defaults from the preset's own colours", () => {
    const s = resolveLabelStyle({ roads: { classes: ["trunk"] } }, fallback)!;
    expect(s.color).toBe("#1c1712");
    expect(s.halo.color).toBe("#faf6f0");
    expect(s.font).toEqual(["Noto Sans Regular"]);
    expect(s.places).toBeNull();
  });

  test("never repeats a name closer than 600 px, whatever the preset says", () => {
    expect(resolveLabelStyle({ roads: { classes: ["trunk"] }, spacing: 100 }, fallback)!.spacing).toBe(600);
  });

  test("refuses colours that are not hex", () => {
    const s = resolveLabelStyle({ roads: { classes: ["trunk"] }, color: "red; x", halo: { color: 3 } }, fallback)!;
    expect(s.color).toBe("#1c1712");
    expect(s.halo.color).toBe("#faf6f0");
  });
});

describe("labelLayers", () => {
  const style = resolveLabelStyle(
    {
      roads: { classes: ["motorway", "trunk", "primary", "secondary"], minZoom: 13 },
      places: { kinds: ["town", "suburb"], maxCount: 2 },
      size: 11,
      halo: { color: "#faf6f0", width: 1.2 },
    },
    fallback,
  )!;
  const layers = labelLayers(style, { sourceId: "openfreemap", pixelScale: 2 });
  const road = layers.find((l) => l.id === LABEL_ROAD_LAYER_ID) as any;
  const place = layers.find((l) => l.id === LABEL_PLACE_LAYER_ID) as any;

  test("road names come from transportation_name, filtered to the listed classes only", () => {
    expect(road["source-layer"]).toBe("transportation_name");
    expect(road.layout["symbol-placement"]).toBe("line");
    const classMatch = road.filter.find((f: any) => Array.isArray(f) && f[0] === "match" && f[1][1] === "class");
    expect(classMatch[2]).toEqual(["motorway", "trunk", "primary", "secondary"]);
    expect(classMatch[2]).not.toContain("residential");
    expect(classMatch[2]).not.toContain("tertiary");
  });

  test("speaks in output pixels: sizes and spacing scale with the supersampling, zooms shift", () => {
    expect(road.layout["text-size"]).toBe(22);
    expect(road.layout["symbol-spacing"]).toBe(1400);
    expect(road.paint["text-halo-width"]).toBeCloseTo(2.4);
    expect(road.minzoom).toBe(14);
  });

  test("names lie on the ground on a tilted map", () => {
    expect(road.layout["text-pitch-alignment"]).toBe("map");
    expect(road.layout["text-rotation-alignment"]).toBe("map");
  });

  test("place names come from the place layer, limited to the listed kinds", () => {
    expect(place["source-layer"]).toBe("place");
    expect(place.filter).toEqual(["match", ["get", "class"], ["town", "suburb"], true, false]);
  });

  test("the clearance layer is last, so it is placed before every name", () => {
    expect(layers[layers.length - 1].id).toBe(LABEL_CLEARANCE_LAYER_ID);
  });

  test("roads only: no place layer", () => {
    const only = labelLayers(resolveLabelStyle({ roads: { classes: ["trunk"] } }, fallback)!, { sourceId: "s" });
    expect(only.map((l) => l.id)).toEqual([LABEL_ROAD_LAYER_ID, LABEL_CLEARANCE_LAYER_ID]);
  });

  test("places sit above roads, so a town name wins over a street name", () => {
    const ids = layers.map((l) => l.id);
    expect(ids.indexOf(LABEL_PLACE_LAYER_ID)).toBeGreaterThan(ids.indexOf(LABEL_ROAD_LAYER_ID));
  });
});

describe("shipped presets", () => {
  test.each(["paper-warm", "paper-warm-3d", "ink"])("%s names main roads only, never residential lanes", (name) => {
    const s = resolveLabelStyle(preset(name).labels, fallback)!;
    expect(s).not.toBeNull();
    expect(s.roads!.classes).toContain("trunk");
    for (const lane of ["residential", "service", "minor", "path", "track", "living_street"]) {
      expect(s.roads!.classes).not.toContain(lane);
    }
    expect(s.places!.maxCount).toBeLessThanOrEqual(2);
  });
});
