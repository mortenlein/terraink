import { describe, expect, test } from "bun:test";
import { attributionText, normaliseQuery, validateRender } from "./validate";

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
});

test("normaliseQuery folds case, commas and whitespace", () => {
  expect(normaliseQuery("  Storgata 1,  Mo i Rana ")).toBe(normaliseQuery("storgata 1 mo i rana"));
});

test("attributionText reads OpenFreeMap's TileJSON attribution", () => {
  const html = '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
  expect(attributionText(html)).toBe("OpenFreeMap © OpenMapTiles Data from OpenStreetMap");
});
