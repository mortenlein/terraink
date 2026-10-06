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

function drawPinAndLabel(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  preset: RenderPreset,
  label: string | undefined,
  marker: boolean,
  standing: boolean,
): void {
  const cx = width / 2;
  const cy = height / 2;
  const base = Math.min(width, height);
  const r = clamp(base * 0.014, 6, 16);
  const markerColors = preset.render?.marker ?? { fill: preset.ui.text, stroke: preset.map.land };

  let reach = 0;
  if (marker) reach = drawMarker(ctx, cx, cy, r, markerColors, preset.ui.text, standing);

  const text = label?.trim();
  if (!text) return;
  const labelColors = preset.render?.label ?? { background: preset.ui.text, text: preset.map.land };
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
  const boxX = clamp(cx - boxW / 2, 4, width - boxW - 4);
  const boxY = Math.max(4, cy - gap - boxH);
  ctx.fillStyle = labelColors.background;
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, size * 0.3);
  ctx.fill();
  ctx.fillStyle = labelColors.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, boxX + boxW / 2, boxY + boxH / 2 + size * 0.04);
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
  const style = generateMapStyle(preset, {
    ...layers,
    sourceUrl: req.sourceUrl,
    lineWidthScale: preset.render?.lineWidthScale,
    distanceMeters: 1_000,
    buildings3d: req.buildings3d ? resolveBuilding3d(preset) : undefined,
  });

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
  );

  // The pin and label go on the map before the attribution, so nothing can
  // ever cover the attribution.
  const mapCtx = mapCanvas.getContext("2d");
  if (!mapCtx) throw new Error("Canvas rendering is not available.");
  mapCtx.save();
  mapCtx.scale(outWidth / width, outHeight / height);
  drawPinAndLabel(mapCtx, width, height, preset, req.label, req.marker !== false, req.pitch > 0);
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
      fontSizePx: clamp(Math.min(width, height) * 0.017, 11, 18) * scale,
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
