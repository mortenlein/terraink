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
import { generateMapStyle } from "@/features/map/infrastructure/maplibreStyle";
import { renderStyleToCanvas } from "@/features/export/infrastructure/mapExporter";
import { compositeExport } from "@/features/poster/infrastructure/renderer";
import { createPngBlob } from "@/features/export/infrastructure/pngExporter";
import type { ResolvedTheme } from "@/features/theme/domain/types";

export interface RenderPreset extends ResolvedTheme {
  render?: {
    lineWidthScale?: number;
    layers?: Record<string, boolean>;
    marker?: { fill: string; stroke: string };
    label?: { background: string; text: string };
    attribution?: { color: string; backdrop: string };
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

function drawPinAndLabel(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  preset: RenderPreset,
  label: string | undefined,
  marker: boolean,
): void {
  const cx = width / 2;
  const cy = height / 2;
  const base = Math.min(width, height);
  const r = clamp(base * 0.014, 6, 16);
  const markerColors = preset.render?.marker ?? { fill: preset.ui.text, stroke: preset.map.land };

  if (marker) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = markerColors.fill;
    ctx.fill();
    ctx.lineWidth = Math.max(2, r * 0.35);
    ctx.strokeStyle = markerColors.stroke;
    ctx.stroke();
  }

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
  const gap = (marker ? r * 1.8 : 0) + size * 0.3;
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
  const layers = preset.render?.layers ?? {};
  const style = generateMapStyle(preset, {
    ...layers,
    sourceUrl: req.sourceUrl,
    lineWidthScale: preset.render?.lineWidthScale,
    distanceMeters: 1_000,
  });

  const mapCanvas = await renderStyleToCanvas(
    {
      style,
      center: { lng: req.lng, lat: req.lat },
      zoom: req.zoom + Math.log2(SUPERSAMPLE),
      pitch: 0,
      bearing: 0,
      renderWidth: width * SUPERSAMPLE,
      renderHeight: height * SUPERSAMPLE,
      pixelRatio: 1,
    },
    width,
    height,
  );

  // The pin and label go on the map before the attribution, so nothing can
  // ever cover the attribution.
  const mapCtx = mapCanvas.getContext("2d");
  if (!mapCtx) throw new Error("Canvas rendering is not available.");
  drawPinAndLabel(mapCtx, width, height, preset, req.label, req.marker !== false);

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
      fontSizePx: clamp(Math.min(width, height) * 0.017, 11, 18),
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
