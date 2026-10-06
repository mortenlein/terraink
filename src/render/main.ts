/**
 * Headless render page (render.html). The Bun server (server/render.ts)
 * opens this page in Chromium and calls window.renderMap(request); the
 * result is a PNG as base64.
 *
 * It takes the app's own export path: generateMapStyle builds the MapLibre
 * style from a theme, renderStyleToCanvas draws it in an offscreen map (the
 * same code captureMapAsCanvas uses for a poster download), compositeExport
 * draws the attribution, createPngBlob encodes. What is added here is only
 * what a site map needs and a poster does not: a pin and a label at the
 * centre, and an attribution sized for a small image.
 */
import "maplibre-gl/dist/maplibre-gl.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import { generateMapStyle, shaderLuminance, type Building3dStyle } from "@/features/map/infrastructure/maplibreStyle";
import { renderStyleToCanvas } from "@/features/export/infrastructure/mapExporter";
import {
  CLEARANCE_IMAGE_PREFIX,
  LABEL_CLEARANCE_SOURCE_ID,
  PLAQUE_IMAGE_PREFIX,
  LABEL_PLACE_LAYER_ID,
  resolveLabelStyle,
  type LabelPreset,
} from "@/features/map/infrastructure/labelLayers";
import type { GeoJSONSource, Map as MaplibreMap } from "maplibre-gl";
import { compositeExport } from "@/features/poster/infrastructure/renderer";
import { createPngBlob } from "@/features/export/infrastructure/pngExporter";
import type { ResolvedTheme } from "@/features/theme/domain/types";
import { blendHex } from "@/shared/utils/color";

export interface RenderPreset extends ResolvedTheme {
  render?: {
    lineWidthScale?: number;
    layers?: Record<string, boolean>;
    marker?: { fill: string; stroke: string };
    label?: { background: string; text: string };
    attribution?: { color: string; backdrop: string };
    /** Suggested camera; the request's pitch/bearing override it (server/validate.ts resolveView). */
    camera?: { pitch?: number; bearing?: number };
    /** Extruded buildings: `enabled` is the preset's default, the colours apply whenever 3D is on. */
    building3d?: { enabled?: boolean } & Partial<Building3dStyle>;
  };
  /** Road and place names; none when absent (labelLayers.ts, README). */
  labels?: LabelPreset;
}

export interface RenderRequest {
  lat: number;
  lng: number;
  zoom: number;
  width: number;
  height: number;
  preset: RenderPreset;
  label?: string;
  marker?: boolean;
  /** Resolved by the server: request, then preset, then 0 / 0 / false. */
  pitch: number;
  bearing: number;
  buildings3d: boolean;
  /** Device pixel ratio of the output, 1-3. */
  scale: number;
  sourceUrl: string;
  /** Glyph PBF URL template for map names (server config GLYPHS_URL). */
  glyphsUrl: string;
  attribution: string;
}

/**
 * The GL canvas is drawn at SUPERSAMPLE times the output size and scaled
 * down, which smooths lines the way the app's overzoom export does. 2 keeps
 * a 2400 px image inside SwiftShader's 8192 px texture limit.
 */
const SUPERSAMPLE = 2;

const LABEL_FONT = '"Space Grotesk", sans-serif';
const ATTRIBUTION_FONT = '"IBM Plex Mono", monospace';

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Defaults derived from the flat building fill, so any preset can be drawn
 * in 3D. MapLibre's light can only darken walls relative to the roof, so the
 * shade is always the roof darkened (toward black, not toward the text
 * colour: on a dark preset that is lighter and gave walls no shade at all,
 * 2026-10-06). On a dark map the roof is first lifted a step toward the
 * text colour so the blocks stand off the near-black ground.
 */
function resolveBuilding3d(preset: RenderPreset): Building3dStyle {
  const own = preset.render?.building3d ?? {};
  const flat = preset.map.buildings || blendHex(preset.map.land, preset.ui.text, 0.14);
  const dark = shaderLuminance(preset.map.land) < 0.4;
  const color = own.color ?? (dark ? blendHex(flat, preset.ui.text, 0.1) : flat);
  return {
    color,
    shade: own.shade ?? blendHex(color, "#000000", dark ? 0.4 : 0.28),
    opacity: clamp(own.opacity ?? 1, 0, 1),
  };
}

/**
 * Flat maps get a dot on the spot. A tilted map gets a pin whose tip is the
 * spot, with a squashed shadow under it, so it reads as standing on the
 * ground in front of the buildings rather than hovering over a roof.
 * Returns how far above the spot the pin reaches, for the label.
 */
function drawMarker(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  colors: { fill: string; stroke: string },
  shadow: string,
  standing: boolean,
): number {
  if (!standing) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = colors.fill;
    ctx.fill();
    ctx.lineWidth = Math.max(2, r * 0.35);
    ctx.strokeStyle = colors.stroke;
    ctx.stroke();
    return r;
  }
  const head = r * 1.25;
  const headY = cy - head * 2.3;
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.ellipse(cx, cy, head * 0.7, head * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Teardrop: the head circle and the two tangents from the tip. A tangent
  // from a point at distance d touches the circle acos(r / d) either side
  // of the line to that point (asin gave a needle that vanished in the tip).
  const d = cy - headY;
  const a = Math.acos(head / d);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, headY, head, Math.PI / 2 + a, Math.PI / 2 - a);
  ctx.closePath();
  ctx.fillStyle = colors.fill;
  ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.3);
  ctx.lineJoin = "round";
  ctx.strokeStyle = colors.stroke;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, headY, head * 0.38, 0, Math.PI * 2);
  ctx.fillStyle = colors.stroke;
  ctx.fill();
  return d + head;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the pin and the label box go, in CSS pixels of the output. */
interface PinLayout {
  cx: number;
  cy: number;
  r: number;
  marker: boolean;
  standing: boolean;
  /** Everything the pin and its label cover; map names keep out of it. */
  bounds: Rect | null;
  label?: { text: string; size: number; box: Rect };
}

function layoutPinAndLabel(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  label: string | undefined,
  marker: boolean,
  standing: boolean,
): PinLayout {
  const cx = width / 2;
  const cy = height / 2;
  const base = Math.min(width, height);
  const r = clamp(base * 0.014, 6, 16);
  // Mirrors drawMarker's geometry: the dot with its stroke, or the standing
  // pin from its head down to the shadow under the tip.
  const head = r * 1.25;
  const reach = !marker ? 0 : standing ? head * 2.3 + head : r;
  let bounds: Rect | null = !marker
    ? null
    : standing
      ? { x: cx - head * 1.2, y: cy - reach - r * 0.3, w: head * 2.4, h: reach + r * 0.3 + head * 0.4 }
      : { x: cx - r * 1.4, y: cy - r * 1.4, w: r * 2.8, h: r * 2.8 };

  const text = label?.trim();
  if (!text) return { cx, cy, r, marker, standing, bounds };
  let size = clamp(base * 0.03, 13, 30);
  ctx.font = `700 ${size}px ${LABEL_FONT}`;
  const maxWidth = width * 0.8;
  let textWidth = ctx.measureText(text).width;
  if (textWidth > maxWidth) {
    size = size * (maxWidth / textWidth);
    ctx.font = `700 ${size}px ${LABEL_FONT}`;
    textWidth = ctx.measureText(text).width;
  }
  const padX = size * 0.6;
  const padY = size * 0.4;
  const boxW = textWidth + padX * 2;
  const boxH = size + padY * 2;
  const gap = (marker ? reach + r * 0.8 : 0) + size * 0.3;
  const box = {
    x: clamp(cx - boxW / 2, 4, width - boxW - 4),
    y: Math.max(4, cy - gap - boxH),
    w: boxW,
    h: boxH,
  };
  bounds = bounds ? union(bounds, box) : box;
  return { cx, cy, r, marker, standing, bounds, label: { text, size, box } };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function drawPinAndLabel(ctx: CanvasRenderingContext2D, layout: PinLayout, preset: RenderPreset): void {
  const markerColors = preset.render?.marker ?? { fill: preset.ui.text, stroke: preset.map.land };
  if (layout.marker) {
    drawMarker(ctx, layout.cx, layout.cy, layout.r, markerColors, preset.ui.text, layout.standing);
  }
  if (!layout.label) return;
  const { text, size, box } = layout.label;
  const labelColors = preset.render?.label ?? { background: preset.ui.text, text: preset.map.land };
  ctx.font = `700 ${size}px ${LABEL_FONT}`;
  ctx.fillStyle = labelColors.background;
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.w, box.h, size * 0.3);
  ctx.fill();
  ctx.fillStyle = labelColors.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, box.x + box.w / 2, box.y + box.h / 2 + size * 0.04);
}

/* ── Map names (the preset's `labels`) ── */

function attributionFontSize(width: number, height: number): number {
  return clamp(Math.min(width, height) * 0.017, 11, 18);
}

/**
 * Screen areas no map name may enter, in output CSS pixels: the pin and its
 * label (drawn over the map afterwards, so a name there would be half
 * hidden), the attribution in the corner, and a band along every edge so no
 * name is cut off by the frame.
 */
function clearanceRects(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  layout: PinLayout,
  attribution: string,
  labelSize: number,
): Rect[] {
  const rects: Rect[] = [];
  const pad = labelSize * 0.6;
  if (layout.bounds) {
    const b = layout.bounds;
    rects.push({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 });
  }
  // Same layout as typography.ts draws it, with room to spare.
  const size = attributionFontSize(width, height);
  ctx.font = `300 ${size}px ${ATTRIBUTION_FONT}`;
  const margin = Math.min(width, height) * 0.02;
  const textWidth = Math.min(ctx.measureText(attribution).width, width - margin * 4);
  const aw = textWidth + size * 1.6 + pad;
  const ah = size * 1.8 + pad;
  rects.push({ x: width - margin - aw, y: height - margin - ah, w: aw + margin, h: ah + margin });
  const band = Math.max(6, labelSize * 0.8);
  rects.push({ x: 0, y: 0, w: width, h: band });
  rects.push({ x: 0, y: height - band, w: width, h: band });
  rects.push({ x: 0, y: 0, w: band, h: height });
  rects.push({ x: width - band, y: 0, w: band, h: height });
  return rects;
}

/** Long strips are cut into pieces: one icon stays well inside the glyph/icon atlas. */
const CLEARANCE_MAX_PIECE_PX = 1024;

function groundPerPixel(map: MaplibreMap, x: number, y: number): number {
  const a = map.unproject([x - 1, y]);
  const b = map.unproject([x + 1, y]);
  const cos = Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lng - a.lng) * cos, b.lat - a.lat) / 2;
}

function perspectiveScale(map: MaplibreMap, x: number, y: number): number {
  if (map.getPitch() === 0) return 1;
  const canvas = map.getCanvas();
  const centre = groundPerPixel(map, canvas.clientWidth / 2, canvas.clientHeight / 2);
  const here = groundPerPixel(map, x, y);
  if (!(centre > 0) || !(here > 0)) return 1;
  return clamp(0.5 + 0.5 * (centre / here), 0.25, 4);
}

/**
 * A name that lies on the ground (pitch alignment "map") is drawn at about
 * 0.5 + 0.5 * r of its size (MapLibre's perspective ratio) and foreshortened
 * by r again in height, r being the ground scale there over the centre's.
 * On a tilted map the far ground squeezes names into an unreadable smear
 * (Vikaåsen at ~5 px tall, Mo i Rana at pitch 50, 2026-10-06), so the band
 * above the row where (0.5 + 0.5 r) * r drops below MIN_LABEL_SCALE is kept
 * clear. Returns that row in map pixels, 0 when the whole map is near enough.
 */
const MIN_LABEL_SCALE = 0.7;

function farGroundRow(map: MaplibreMap): number {
  if (map.getPitch() === 0) return 0;
  const canvas = map.getCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const centre = groundPerPixel(map, w / 2, h / 2);
  if (!(centre > 0)) return 0;
  const step = Math.max(1, Math.round(h / 200));
  for (let y = h / 2; y >= 0; y -= step) {
    const here = groundPerPixel(map, w / 2, y);
    const r = here > 0 ? centre / here : 0;
    if ((0.5 + 0.5 * r) * r < MIN_LABEL_SCALE) return Math.min(h / 2, y + step);
  }
  return 0;
}

/**
 * Turns the clearance rectangles into transparent icons at the points under
 * them (map pixels are SUPERSAMPLE times output pixels). The icons sit in the
 * topmost symbol layer with allow-overlap on, so MapLibre places them first
 * and every name that would touch one is dropped.
 */
function installClearance(map: MaplibreMap, cssRects: Rect[]): void {
  const far = farGroundRow(map) / SUPERSAMPLE;
  const rects = far > 0 ? [...cssRects, { x: 0, y: 0, w: map.getCanvas().clientWidth / SUPERSAMPLE, h: far }] : cssRects;
  // Both kinds of image the label layers name are made here on demand: the
  // transparent clearance boxes and the solid plaques under road names.
  map.on("styleimagemissing", (e: { id: string }) => {
    if (map.hasImage(e.id)) return;
    if (e.id.startsWith(CLEARANCE_IMAGE_PREFIX)) {
      const [w, h] = e.id.slice(CLEARANCE_IMAGE_PREFIX.length).split(":").map(Number);
      map.addImage(e.id, { width: w, height: h, data: new Uint8Array(w * h * 4) });
    } else if (e.id.startsWith(PLAQUE_IMAGE_PREFIX)) {
      const hex = e.id.slice(PLAQUE_IMAGE_PREFIX.length);
      const full = hex.length === 3 ? hex.replace(/./g, "$&$&") : hex;
      const rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
      const size = 8;
      const data = new Uint8Array(size * size * 4);
      for (let i = 0; i < size * size; i++) data.set([...rgb, 255], i * 4);
      map.addImage(e.id, { width: size, height: size, data });
    }
  });
  const features: GeoJSON.Feature[] = [];
  for (const rect of rects) {
    const x0 = rect.x * SUPERSAMPLE;
    const y0 = rect.y * SUPERSAMPLE;
    const w = rect.w * SUPERSAMPLE;
    const h = rect.h * SUPERSAMPLE;
    const nx = Math.ceil(w / CLEARANCE_MAX_PIECE_PX);
    const ny = Math.ceil(h / CLEARANCE_MAX_PIECE_PX);
    const pw = Math.max(1, Math.ceil(w / nx));
    const ph = Math.max(1, Math.ceil(h / ny));
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const px = x0 + pw * (i + 0.5);
        const py = y0 + ph * (j + 0.5);
        const at = map.unproject([px, py]);
        // On a tilted map MapLibre scales a viewport-aligned symbol by
        // 0.5 + 0.5 * (camera-to-centre / camera-to-anchor) (symbol shader,
        // maplibre-gl 5.19): far boxes shrink, near ones grow. That distance
        // ratio is the ground covered by one pixel at the centre over the
        // same at the box, so the box is drawn at its size over the factor.
        const k = perspectiveScale(map, px, py);
        const iw = Math.max(1, Math.round(pw / k));
        const ih = Math.max(1, Math.round(ph / k));
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [at.lng, at.lat] },
          properties: { image: `${CLEARANCE_IMAGE_PREFIX}${iw}:${ih}` },
        });
      }
    }
  }
  // An inline style may already be loaded when the constructor returns.
  const fill = () =>
    (map.getSource(LABEL_CLEARANCE_SOURCE_ID) as GeoJSONSource).setData({ type: "FeatureCollection", features });
  if (map.getSource(LABEL_CLEARANCE_SOURCE_ID)) fill();
  else map.once("style.load", fill);
}

/**
 * MapLibre has no "at most N" for symbols, so the place layer is placed once
 * with its rank as sort key and then filtered down to the N most important
 * names that were actually placed. Roads may then take the freed room.
 */
async function limitPlaceLabels(map: MaplibreMap, maxCount: number): Promise<void> {
  if (!map.getLayer(LABEL_PLACE_LAYER_ID)) return;
  const placed = map.queryRenderedFeatures({ layers: [LABEL_PLACE_LAYER_ID] });
  const byName = new Map<string, number>();
  for (const f of placed) {
    const name = f.properties?.name;
    if (typeof name !== "string") continue;
    const rank = typeof f.properties?.rank === "number" ? f.properties.rank : 99;
    byName.set(name, Math.min(rank, byName.get(name) ?? Infinity));
  }
  if (byName.size <= maxCount) return;
  const keep = [...byName.entries()].sort((a, b) => a[1] - b[1]).slice(0, maxCount).map(([n]) => n);
  const filter = map.getFilter(LABEL_PLACE_LAYER_ID);
  map.setFilter(LABEL_PLACE_LAYER_ID, ["all", filter as any, ["match", ["get", "name"], keep.length ? keep : [""], true, false]]);
  await new Promise<void>((resolve) => {
    map.once("idle", () => resolve());
    map.triggerRepaint();
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function renderMap(req: RenderRequest): Promise<{ png: string; ms: number }> {
  const started = performance.now();
  await Promise.all([
    document.fonts.load(`700 20px ${LABEL_FONT}`),
    document.fonts.load(`400 20px ${ATTRIBUTION_FONT}`),
  ]);

  const { preset, width, height } = req;
  // `scale` is a device pixel ratio: the map keeps its extent and line
  // weights (MapLibre's pixelRatio), and everything drawn on top is laid out
  // in CSS pixels and scaled, so a 600x400 @2x image shown at 600 px wide
  // looks like the 1x one, only sharp, attribution included.
  const scale = req.scale > 0 ? req.scale : 1;
  const outWidth = Math.round(width * scale);
  const outHeight = Math.round(height * scale);
  const layers = preset.render?.layers ?? {};
  const labels = resolveLabelStyle(preset.labels, { text: preset.ui.text, land: preset.map.land });
  const style = generateMapStyle(preset, {
    ...layers,
    sourceUrl: req.sourceUrl,
    lineWidthScale: preset.render?.lineWidthScale,
    distanceMeters: 1_000,
    buildings3d: req.buildings3d ? resolveBuilding3d(preset) : undefined,
    labels: labels ? { style: labels, glyphsUrl: req.glyphsUrl, pixelScale: SUPERSAMPLE } : undefined,
  });

  const scratch = document.createElement("canvas").getContext("2d");
  if (!scratch) throw new Error("Canvas rendering is not available.");
  const pin = layoutPinAndLabel(scratch, width, height, req.label, req.marker !== false, req.pitch > 0);

  // The camera centre is the requested point at any pitch, so the pin at the
  // canvas centre stays on the spot.
  const mapCanvas = await renderStyleToCanvas(
    {
      style,
      center: { lng: req.lng, lat: req.lat },
      zoom: req.zoom + Math.log2(SUPERSAMPLE),
      pitch: req.pitch,
      bearing: req.bearing,
      renderWidth: width * SUPERSAMPLE,
      renderHeight: height * SUPERSAMPLE,
      pixelRatio: scale,
    },
    outWidth,
    outHeight,
    labels
      ? {
          onCreate: (map) =>
            installClearance(map, clearanceRects(scratch, width, height, pin, req.attribution, labels.size)),
          beforeCapture: labels.places ? (map) => limitPlaceLabels(map, labels.places!.maxCount) : undefined,
        }
      : undefined,
  );

  // The pin and label go on the map before the attribution, so nothing can
  // ever cover the attribution.
  const mapCtx = mapCanvas.getContext("2d");
  if (!mapCtx) throw new Error("Canvas rendering is not available.");
  mapCtx.save();
  mapCtx.scale(outWidth / width, outHeight / height);
  drawPinAndLabel(mapCtx, pin, preset);
  mapCtx.restore();

  const attributionColors = preset.render?.attribution;
  const { canvas } = await compositeExport(mapCanvas, {
    theme: preset,
    center: { lat: req.lat, lon: req.lng },
    widthInches: 0,
    heightInches: 0,
    displayCity: "",
    displayCountry: "",
    fontFamily: "",
    showPosterText: false,
    showOverlay: false,
    includeCredits: false,
    attribution: {
      text: req.attribution,
      // Sized for the CSS width; the margin scales with the canvas on its own.
      fontSizePx: attributionFontSize(width, height) * scale,
      color: attributionColors?.color,
      backdrop: attributionColors?.backdrop,
    },
  });

  const blob = await createPngBlob(canvas, 72);
  return { png: await blobToBase64(blob), ms: Math.round(performance.now() - started) };
}

declare global {
  interface Window {
    renderMap: typeof renderMap;
    renderReady: boolean;
  }
}

window.renderMap = renderMap;
window.renderReady = true;
