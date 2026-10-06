import maplibregl from "maplibre-gl";
import type { Map as MaplibreMap, StyleSpecification } from "maplibre-gl";
import type { MarkerProjectionInput } from "@/features/markers/domain/types";
import {
  waitForMapIdle,
  createOffscreenContainer,
  resolveExportRenderParams,
} from "./exportUtils";

export interface CapturedMapResult {
  canvas: HTMLCanvasElement;
  markerProjection: MarkerProjectionInput;
  markerScaleX: number;
  markerScaleY: number;
  markerSizeScale: number;
}

/**
 * Captures the currently visible map view at full export resolution.
 * Uses a hidden offscreen map so PNG/PDF output remains sharp.
 */
export async function captureMapAsCanvas(
  map: MaplibreMap,
  exportWidth: number,
  exportHeight: number,
): Promise<CapturedMapResult> {
  await waitForMapIdle(map);

  const {
    center,
    zoom,
    pitch,
    bearing,
    style,
    renderWidth,
    renderHeight,
    pixelRatio,
    markerProjection,
    markerScaleX,
    markerScaleY,
    markerSizeScale,
  } = resolveExportRenderParams(map, exportWidth, exportHeight);

  const canvas = await renderStyleToCanvas(
    { style, center, zoom, pitch, bearing, renderWidth, renderHeight, pixelRatio },
    exportWidth,
    exportHeight,
  );
  return { canvas, markerProjection, markerScaleX, markerScaleY, markerSizeScale };
}

export interface OffscreenRenderParams {
  style: StyleSpecification;
  center: { lng: number; lat: number };
  zoom: number;
  pitch: number;
  bearing: number;
  renderWidth: number;
  renderHeight: number;
  pixelRatio: number;
}

/**
 * Renders a style into a hidden offscreen map and draws the result into a
 * 2D canvas of the export size. Split out of captureMapAsCanvas so the
 * headless render page (src/render/main.ts) takes the same path as the
 * interactive export, without needing a live preview map first.
 */
export interface OffscreenRenderHooks {
  /** Called right after the map is constructed, before the style loads. */
  onCreate?: (map: MaplibreMap) => void;
  /** Called once the map is idle, before the canvas is copied; may change the map and wait again. */
  beforeCapture?: (map: MaplibreMap) => Promise<void>;
}

export async function renderStyleToCanvas(
  params: OffscreenRenderParams,
  exportWidth: number,
  exportHeight: number,
  hooks?: OffscreenRenderHooks,
): Promise<HTMLCanvasElement> {
  const { style, center, zoom, pitch, bearing, renderWidth, renderHeight, pixelRatio } = params;
  const offscreenContainer = createOffscreenContainer(renderWidth, renderHeight);
  document.body.appendChild(offscreenContainer);

  const exportMap = new maplibregl.Map({
    container: offscreenContainer,
    style,
    center: [center.lng, center.lat],
    zoom,
    pitch,
    bearing,
    interactive: false,
    attributionControl: false,
    pixelRatio,
    // A still image: names must be fully drawn at capture, not fading in.
    fadeDuration: 0,
    canvasContextAttributes: { preserveDrawingBuffer: true },
  });

  try {
    hooks?.onCreate?.(exportMap);
    await waitForMapIdle(exportMap);
    if (hooks?.beforeCapture) await hooks.beforeCapture(exportMap);

    const glCanvas = exportMap.getCanvas();
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = exportWidth;
    exportCanvas.height = exportHeight;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not create 2D context for export canvas");
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(glCanvas, 0, 0, exportWidth, exportHeight);

    return exportCanvas;
  } finally {
    exportMap.remove();
    offscreenContainer.remove();
  }
}
