/**
 * Road and place names for headless renders, driven by a preset's `labels`
 * section (README "Preset `labels` block").
 *
 * Why it exists: a map of a town with no names gave the reader nothing to
 * hold on to (Morten, 2026-10-06, on the Mo i Rana render), but a map with
 * every street named is a carpet. So only the classes the preset lists are
 * named, at most once or twice per road (a large symbol-spacing), with
 * MapLibre's collision on and generous padding, in a quiet ink with a thin
 * paper halo.
 *
 * Pure: no `@/` imports, so server/labelLayers.test.ts can import it directly.
 * A preset without `labels` gets none of this, and the style stays exactly
 * what it was before labels existed.
 */
import type {
  LayerSpecification,
  SymbolLayerSpecification,
} from "maplibre-gl";

/** What a preset may write in `labels` (all optional except where noted). */
export interface LabelPreset {
  roads?: { classes?: string[]; minZoom?: number };
  places?: {
    kinds?: string[];
    maxCount?: number;
    size?: number;
    letterSpacing?: number;
    transform?: "none" | "uppercase";
  };
  font?: string[];
  /** Text size in CSS pixels at scale 1. */
  size?: number;
  /** In ems. */
  letterSpacing?: number;
  transform?: "none" | "uppercase";
  color?: string;
  halo?: { color?: string; width?: number };
  /** Distance between repeated names along one road, in CSS pixels. */
  spacing?: number;
}

/** The preset's section with every default filled in. */
export interface LabelStyle {
  roads: { classes: string[]; minZoom: number } | null;
  places: {
    kinds: string[];
    maxCount: number;
    size: number;
    letterSpacing: number;
    transform: "none" | "uppercase";
  } | null;
  font: string[];
  size: number;
  letterSpacing: number;
  transform: "none" | "uppercase";
  color: string;
  halo: { color: string; width: number };
  spacing: number;
}

export const LABEL_ROAD_LAYER_ID = "label-road";
export const LABEL_PLACE_LAYER_ID = "label-place";
export const LABEL_CLEARANCE_LAYER_ID = "label-clearance";
export const LABEL_CLEARANCE_SOURCE_ID = "label-clearance";
/** Images named `clearance:<w>:<h>` are transparent boxes made on demand (src/render/main.ts). */
export const CLEARANCE_IMAGE_PREFIX = "clearance:";
/** Images named `plaque:<rrggbb>` are solid swatches made on demand, stretched behind a name. */
export const PLAQUE_IMAGE_PREFIX = "plaque:";

/** OpenFreeMap's glyph server carries the Noto Sans stacks its own styles use. */
const DEFAULT_FONT = ["Noto Sans Regular"];
const DEFAULT_SIZE = 11;
const DEFAULT_LETTER_SPACING = 0.08;
const DEFAULT_SPACING = 700;
/** Never repeat a name closer than this, whatever the preset says. */
const MIN_SPACING = 600;
/** Degrees a line label may bend between characters; low keeps names on straight stretches. */
const TEXT_MAX_ANGLE = 30;
/** Room kept free around every name, in CSS pixels, so names never crowd each other. */
const TEXT_PADDING = 14;
const PLACE_TEXT_PADDING = 16;
/** Perpendicular distance from the road's centre line to the name's, in ems. */
const ROAD_TEXT_OFFSET_EM = -0.95;

/** Biggest roads first when names compete for room (symbol-sort-key: low wins). */
const ROAD_CLASS_PRIORITY = ["motorway", "trunk", "primary", "secondary", "tertiary"];

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
}

function colour(v: unknown, fallback: string): string {
  return typeof v === "string" && HEX.test(v) ? v : fallback;
}

function transformOf(v: unknown, fallback: "none" | "uppercase"): "none" | "uppercase" {
  return v === "uppercase" || v === "none" ? v : fallback;
}

/**
 * Reads a preset's `labels` section. Returns null (no labels at all) when the
 * section is missing or names neither roads nor places. Colours default to
 * the preset's own: the ink is the text colour, the halo the land.
 */
export function resolveLabelStyle(
  raw: unknown,
  fallback: { text: string; land: string },
): LabelStyle | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as LabelPreset;
  const roadClasses = strings(l.roads?.classes);
  const placeKinds = strings(l.places?.kinds);
  const size = clamp(finite(l.size) ?? DEFAULT_SIZE, 6, 24);
  const letterSpacing = clamp(finite(l.letterSpacing) ?? DEFAULT_LETTER_SPACING, 0, 0.5);
  const transform = transformOf(l.transform, "none");
  const roads = roadClasses.length
    ? { classes: roadClasses, minZoom: clamp(finite(l.roads?.minZoom) ?? 13, 0, 22) }
    : null;
  const places = placeKinds.length
    ? {
        kinds: placeKinds,
        maxCount: Math.round(clamp(finite(l.places?.maxCount) ?? 2, 0, 20)),
        size: clamp(finite(l.places?.size) ?? size, 6, 32),
        letterSpacing: clamp(finite(l.places?.letterSpacing) ?? letterSpacing, 0, 0.5),
        transform: transformOf(l.places?.transform, transform),
      }
    : null;
  if (!roads && !places) return null;
  const font = strings(l.font);
  return {
    roads,
    places,
    font: font.length ? font : DEFAULT_FONT,
    size,
    letterSpacing,
    transform,
    color: colour(l.color, fallback.text),
    halo: {
      color: colour(l.halo?.color, fallback.land),
      width: clamp(finite(l.halo?.width) ?? 1.2, 0, 4),
    },
    spacing: Math.max(MIN_SPACING, finite(l.spacing) ?? DEFAULT_SPACING),
  };
}

export interface LabelLayerOptions {
  sourceId: string;
  /**
   * The headless page draws the map at SUPERSAMPLE times the output size and
   * scales it down: every pixel quantity is multiplied by this, and every
   * zoom threshold shifted by log2 of it, so the preset speaks in output
   * CSS pixels and request zooms.
   */
  pixelScale?: number;
}

/** Name if the road has one, else its ref (E 6) unless it carries several (E 6;E 12). */
const ROAD_TEXT: any = [
  "case",
  ["has", "name"],
  ["get", "name"],
  ["all", ["has", "ref"], ["!", ["in", ";", ["get", "ref"]]]],
  ["get", "ref"],
  "",
];

export function labelLayers(labels: LabelStyle, options: LabelLayerOptions): LayerSpecification[] {
  const k = options.pixelScale && options.pixelScale > 0 ? options.pixelScale : 1;
  const zoomShift = Math.log2(k);
  const layers: LayerSpecification[] = [];
  const paint = {
    "text-color": labels.color,
    "text-halo-color": labels.halo.color,
    "text-halo-width": labels.halo.width * k,
    "text-halo-blur": 0,
  };

  if (labels.roads) {
    const r = labels.roads;
    const road: SymbolLayerSpecification = {
      id: LABEL_ROAD_LAYER_ID,
      type: "symbol",
      source: options.sourceId,
      "source-layer": "transportation_name",
      minzoom: r.minZoom + zoomShift,
      filter: [
        "all",
        ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
        ["match", ["get", "class"], r.classes, true, false],
      ],
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": labels.spacing * k,
        "symbol-sort-key": [
          "match",
          ["get", "class"],
          ...ROAD_CLASS_PRIORITY.flatMap((c, i) => [c, i]),
          ROAD_CLASS_PRIORITY.length,
        ] as any,
        "text-field": ROAD_TEXT,
        "text-font": labels.font,
        "text-size": labels.size * k,
        "text-letter-spacing": labels.letterSpacing,
        "text-transform": labels.transform,
        "text-max-angle": TEXT_MAX_ANGLE,
        "text-padding": TEXT_PADDING * k,
        "text-keep-upright": true,
        // A paper-coloured plaque under the name, invisible except where it
        // hides a line. The halo alone cannot: MapLibre caps it near an
        // eighth of the font size, and a word gap has no glyph to halo, so
        // a footpath crossing a name showed through as "Elias-Blix'-gate".
        "icon-image": `${PLAQUE_IMAGE_PREFIX}${labels.halo.color.replace("#", "").toLowerCase()}`,
        "icon-text-fit": "both",
        "icon-text-fit-padding": [1 * k, 3 * k, 1 * k, 3 * k],
        "icon-rotation-alignment": "map",
        "icon-pitch-alignment": "map",
        // Beside the road, not on it: our roads are hairlines, and a name
        // laid over one shows the line through every word gap
        // ("Ole-Tobias-Olsens-gate", first render 2026-10-06).
        "text-offset": [0, ROAD_TEXT_OFFSET_EM],
        // On the ground at any pitch: the name lies along the road rather
        // than standing up off it.
        "text-pitch-alignment": "map",
        "text-rotation-alignment": "map",
      },
      paint: { ...paint },
    };
    layers.push(road);
  }

  // Places above roads: MapLibre places the upper layer first, and the
  // town's name matters more than a street's (at zoom 13 the road names
  // took Mo i Rana's room, 2026-10-06).
  if (labels.places) {
    const p = labels.places;
    const place: SymbolLayerSpecification = {
      id: LABEL_PLACE_LAYER_ID,
      type: "symbol",
      source: options.sourceId,
      "source-layer": "place",
      filter: ["match", ["get", "class"], p.kinds, true, false],
      layout: {
        "text-field": ["get", "name"],
        "text-font": labels.font,
        "text-size": p.size * k,
        "text-letter-spacing": p.letterSpacing,
        "text-transform": p.transform,
        "text-max-width": 10,
        "text-padding": PLACE_TEXT_PADDING * k,
        "text-pitch-alignment": "viewport",
        "text-rotation-alignment": "viewport",
        // OpenMapTiles' rank: lower is more important.
        "symbol-sort-key": ["coalesce", ["get", "rank"], 99],
        // MapLibre has no count limit; the page trims to maxCount after the
        // first placement (src/render/main.ts limitPlaceLabels).
        visibility: p.maxCount > 0 ? "visible" : "none",
      },
      paint: { ...paint },
    };
    layers.push(place);
  }

  // Last, so it is placed first: transparent boxes over the pin, its label
  // and the attribution (and a band along the edges) that no name may enter.
  layers.push({
    id: LABEL_CLEARANCE_LAYER_ID,
    type: "symbol",
    source: LABEL_CLEARANCE_SOURCE_ID,
    layout: {
      "icon-image": ["get", "image"],
      "icon-allow-overlap": true,
      "icon-ignore-placement": false,
      "icon-pitch-alignment": "viewport",
      "icon-rotation-alignment": "viewport",
    },
    paint: { "icon-opacity": 0 },
  });

  return layers;
}
