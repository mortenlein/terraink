import { describe, expect, test } from "bun:test";
import { attributionText, normaliseQuery, resolveView, validateRender } from "./validate";

const limits = { minDimension: 64, maxDimension: 2400 };
const ok = { lat: 66.3128, lng: 14.1428, zoom: 14, width: 1200, height: 800, preset: "paper-warm", format: "png" };

describe("validateRender", () => {
  test("accepts the documented example", () => {
    const r = validateRender(ok, limits);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.marker).toBe(true);
  });
  test("caps the size", () => {
    expect(validateRender({ ...ok, width: 2401 }, limits).ok).toBe(false);
    expect(validateRender({ ...ok, height: 10 }, limits).ok).toBe(false);
    expect(validateRender({ ...ok, width: 100.5 }, limits).ok).toBe(false);
  });
  test("refuses a preset name that could walk the file system", () => {
    expect(validateRender({ ...ok, preset: "../etc/passwd" }, limits).ok).toBe(false);
    expect(validateRender({ ...ok, preset: "Paper" }, limits).ok).toBe(false);
  });
  test("only png", () => {
    expect(validateRender({ ...ok, format: "jpeg" }, limits).ok).toBe(false);
  });
  test("strings are not numbers", () => {
    expect(validateRender({ ...ok, lat: "66.3" }, limits).ok).toBe(false);
  });
  test("long labels are refused, blank labels dropped", () => {
    expect(validateRender({ ...ok, label: "x".repeat(81) }, limits).ok).toBe(false);
    const r = validateRender({ ...ok, label: "  " }, limits);
    expect(r.ok && r.value.label).toBe(undefined);
  });
  test("pitch 90 is refused (MapLibre stops at 60)", () => {
    const r = validateRender({ ...ok, pitch: 90 }, limits);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("pitch");
    expect(validateRender({ ...ok, pitch: -1 }, limits).ok).toBe(false);
    expect(validateRender({ ...ok, pitch: "50" }, limits).ok).toBe(false);
  });
  test("bearing outside [-180, 180] is refused", () => {
    expect(validateRender({ ...ok, bearing: 181 }, limits).ok).toBe(false);
    expect(validateRender({ ...ok, bearing: -180 }, limits).ok).toBe(true);
  });
  test("buildings3d must be a boolean", () => {
    expect(validateRender({ ...ok, buildings3d: "yes" }, limits).ok).toBe(false);
    const r = validateRender({ ...ok, buildings3d: true }, limits);
    expect(r.ok && r.value.buildings3d).toBe(true);
  });
  test("scale is 1-3 and the scaled size stays under the cap", () => {
    expect(validateRender({ ...ok, scale: 0.5 }, limits).ok).toBe(false);
    expect(validateRender({ ...ok, scale: 4 }, limits).ok).toBe(false);
    expect(validateRender({ ...ok, scale: 2, width: 1201 }, limits).ok).toBe(false);
    const r = validateRender({ ...ok, width: 600, height: 400, scale: 2 }, limits);
    expect(r.ok && r.value.scale).toBe(2);
    const d = validateRender(ok, limits);
    expect(d.ok && d.value.scale).toBe(1);
  });
  test("camera fields are optional and stay unset", () => {
    const r = validateRender(ok, limits);
    expect(r.ok && [r.value.pitch, r.value.bearing, r.value.buildings3d]).toEqual([undefined, undefined, undefined]);
  });
});

describe("resolveView", () => {
  const base = validateRender(ok, limits);
  if (!base.ok) throw new Error("fixture");
  const preset3d = { render: { camera: { pitch: 50, bearing: -20 }, building3d: { enabled: true } } };
  test("defaults to flat, north-up, no 3D", () => {
    expect(resolveView(base.value, {})).toEqual({ pitch: 0, bearing: 0, buildings3d: false });
  });
  test("takes the preset's suggested camera", () => {
    expect(resolveView(base.value, preset3d)).toEqual({ pitch: 50, bearing: -20, buildings3d: true });
  });
  test("the request overrides the preset, also with 0 and false", () => {
    expect(resolveView({ ...base.value, pitch: 0, bearing: 10, buildings3d: false }, preset3d)).toEqual({
      pitch: 0, bearing: 10, buildings3d: false,
    });
  });
  test("a preset pitch out of range is clamped", () => {
    expect(resolveView(base.value, { render: { camera: { pitch: 85 } } }).pitch).toBe(60);
  });
});

test("normaliseQuery folds case, commas and whitespace", () => {
  expect(normaliseQuery("  Storgata 1,  Mo i Rana ")).toBe(normaliseQuery("storgata 1 mo i rana"));
});

test("attributionText reads OpenFreeMap's TileJSON attribution", () => {
  const html = '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
  expect(attributionText(html)).toBe("OpenFreeMap © OpenMapTiles Data from OpenStreetMap");
});
