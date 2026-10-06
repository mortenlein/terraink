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
}

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
    },
  };
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
