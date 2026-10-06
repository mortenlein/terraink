/** Input validation for POST /render; pure, tested in validate.test.ts. */

export interface RenderInput {
  lat: number;
  lng: number;
  zoom: number;
  width: number;
  height: number;
  preset: string;
  label?: string;
  marker: boolean;
  format: "png";
  /** Camera tilt in degrees; undefined means the preset's camera (or 0). */
  pitch?: number;
  /** Camera rotation in degrees; undefined means the preset's camera (or 0). */
  bearing?: number;
  /** Extruded buildings; undefined means the preset's `render.building3d.enabled` (or false). */
  buildings3d?: boolean;
  /** Device pixel ratio: the PNG is width*scale by height*scale, text and pin scaled with it. */
  scale: number;
}

/** What the page draws with once the request and the preset are merged. */
export interface ResolvedView {
  pitch: number;
  bearing: number;
  buildings3d: boolean;
}

export const MAX_PITCH = 60;
export const MAX_SCALE = 3;

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const PRESET_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function validateRender(
  body: unknown,
  limits: { minDimension: number; maxDimension: number },
): Validated<RenderInput> {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const lat = num(b.lat);
  const lng = num(b.lng);
  const zoom = num(b.zoom);
  const width = num(b.width);
  const height = num(b.height);
  if (lat === null || lat < -85 || lat > 85) return { ok: false, error: "lat must be a number in [-85, 85]" };
  if (lng === null || lng < -180 || lng > 180) return { ok: false, error: "lng must be a number in [-180, 180]" };
  if (zoom === null || zoom < 0 || zoom > 20) return { ok: false, error: "zoom must be a number in [0, 20]" };
  for (const [name, v] of [["width", width], ["height", height]] as const) {
    if (v === null || !Number.isInteger(v) || v < limits.minDimension || v > limits.maxDimension) {
      return { ok: false, error: `${name} must be an integer in [${limits.minDimension}, ${limits.maxDimension}]` };
    }
  }
  const format = b.format ?? "png";
  if (format !== "png") return { ok: false, error: 'format must be "png"' };
  if (typeof b.preset !== "string" || !PRESET_NAME.test(b.preset)) {
    return { ok: false, error: "preset must be a preset name (lowercase letters, digits, dashes)" };
  }
  let label: string | undefined;
  if (b.label !== undefined && b.label !== null) {
    if (typeof b.label !== "string" || b.label.length > 80) return { ok: false, error: "label must be a string of at most 80 characters" };
    label = b.label.trim() || undefined;
  }
  if (b.marker !== undefined && typeof b.marker !== "boolean") return { ok: false, error: "marker must be a boolean" };
  let pitch: number | undefined;
  if (b.pitch !== undefined && b.pitch !== null) {
    const p = num(b.pitch);
    // MapLibre's own maxPitch is 60; above it the camera would be clamped silently.
    if (p === null || p < 0 || p > MAX_PITCH) return { ok: false, error: `pitch must be a number in [0, ${MAX_PITCH}]` };
    pitch = p;
  }
  let bearing: number | undefined;
  if (b.bearing !== undefined && b.bearing !== null) {
    const v = num(b.bearing);
    if (v === null || v < -180 || v > 180) return { ok: false, error: "bearing must be a number in [-180, 180]" };
    bearing = v;
  }
  if (b.buildings3d !== undefined && b.buildings3d !== null && typeof b.buildings3d !== "boolean") {
    return { ok: false, error: "buildings3d must be a boolean" };
  }
  let scale = 1;
  if (b.scale !== undefined && b.scale !== null) {
    const v = num(b.scale);
    if (v === null || v < 1 || v > MAX_SCALE) return { ok: false, error: `scale must be a number in [1, ${MAX_SCALE}]` };
    scale = v;
  }
  // The output cap applies to the pixels actually drawn: the GL canvas is a
  // further 2x (SUPERSAMPLE in src/render/main.ts) and SwiftShader stops at 8192.
  for (const [name, v] of [["width", width], ["height", height]] as const) {
    if (Math.round((v as number) * scale) > limits.maxDimension) {
      return { ok: false, error: `${name} * scale must be at most ${limits.maxDimension}` };
    }
  }
  return {
    ok: true,
    value: {
      lat, lng, zoom,
      width: width as number,
      height: height as number,
      preset: b.preset,
      label,
      marker: b.marker !== false,
      format: "png",
      pitch,
      bearing,
      buildings3d: typeof b.buildings3d === "boolean" ? b.buildings3d : undefined,
      scale,
    },
  };
}

/**
 * The request wins, then the preset's suggested camera and 3D switch
 * (`render.camera`, `render.building3d.enabled`), then flat and north-up.
 * A preset value outside the request's ranges is clamped, not trusted.
 */
export function resolveView(input: RenderInput, preset: Record<string, unknown>): ResolvedView {
  const render = (preset.render ?? {}) as { camera?: { pitch?: unknown; bearing?: unknown }; building3d?: { enabled?: unknown } };
  const presetPitch = num(render.camera?.pitch);
  const presetBearing = num(render.camera?.bearing);
  const pitch = input.pitch ?? (presetPitch === null ? 0 : Math.max(0, Math.min(MAX_PITCH, presetPitch)));
  const bearing = input.bearing ?? (presetBearing === null ? 0 : Math.max(-180, Math.min(180, presetBearing)));
  const buildings3d = input.buildings3d ?? render.building3d?.enabled === true;
  return { pitch, bearing, buildings3d };
}

/** Geocode cache key: the same address typed differently hits the same entry. */
export function normaliseQuery(q: string): string {
  return q.normalize("NFC").toLowerCase().replace(/[\s,]+/g, " ").trim();
}

/** Strips the HTML from a TileJSON attribution and decodes the entities it uses. */
export function attributionText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&copy;/g, "©")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
