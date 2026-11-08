/**
 * The geocoder against recorded Kartverket answers (fixtures/, fetched 2026-11-08 from
 * https://api.kartverket.no/adresser/v1/). No test calls the live API: fetch is injected.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { geocode, GeocodeError, kartverketQuery, reverseGeocode } from "./geocode";

const fixture = (name: string) => readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8");

// One temp dir for every cache in this file, removed whether the tests pass or fail.
const tmpRoot = mkdtempSync(path.join(tmpdir(), "gable-maps-geocode-test-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const freshCache = () => path.join(tmpRoot, String(n++));

/** A fetch that records what was asked and answers from a fixture. */
function recorder(body: string, status = 200) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(new URL(String(input instanceof Request ? input.url : input)));
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const BASE = "https://api.kartverket.no/adresser/v1";

describe("kartverketQuery", () => {
  test("drops the country Gable appends, keeps the address", () => {
    expect(kartverketQuery("ole tobias olsens gate 6 8622 mo i rana norge")).toBe("ole tobias olsens gate 6 8622 mo i rana");
    expect(kartverketQuery("storgata 1 oslo norway")).toBe("storgata 1 oslo");
    expect(kartverketQuery("norgesgata 3")).toBe("norgesgata 3");
    expect(kartverketQuery("norge")).toBe("norge");
  });
  test("spells out a standalone gt. (Kartverket has 'gate', and 'gt' finds nothing)", () => {
    expect(kartverketQuery("karl johans gt. 1 oslo")).toBe("karl johans gate 1 oslo");
    expect(kartverketQuery("karl johans gt 1 oslo")).toBe("karl johans gate 1 oslo");
    expect(kartverketQuery("gtx 1")).toBe("gtx 1");
  });
  test("joins a house letter to its number (Kartverket finds 'storgata 2b brevik', not '2 b')", () => {
    expect(kartverketQuery("storgata 2 b brevik")).toBe("storgata 2b brevik");
    expect(kartverketQuery("storgata 2b brevik")).toBe("storgata 2b brevik");
  });
});

describe("geocode", () => {
  test("asks Kartverket's /sok and maps the answer to Gable's shape", async () => {
    const { calls, fetchImpl } = recorder(fixture("kartverket-sok-mo-i-rana.json"));
    const r = await geocode("Ole Tobias Olsens gate 6, 8622 Mo i Rana, Norge", 1, {
      fetchImpl,
      baseUrl: BASE,
      cacheDir: freshCache(),
      minIntervalMs: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].origin + calls[0].pathname).toBe(`${BASE}/sok`);
    expect(calls[0].searchParams.get("sok")).toBe("ole tobias olsens gate 6 8622 mo i rana");
    expect(calls[0].searchParams.get("treffPerSide")).toBe("10");
    expect(calls[0].searchParams.get("utkoordsys")).toBe("4258");
    expect(r.cached).toBe(false);
    expect(r.attribution).toBe("© Kartverket (CC BY 4.0)");
    expect(r.results).toEqual([
      { lat: 66.30813179313053, lng: 14.135732100009525, displayName: "Ole Tobias Olsens gate 6, 8622 MO I RANA", type: "Vegadresse" },
    ]);
  });

  test("the second ask is served from the cache without a call", async () => {
    const cacheDir = freshCache();
    const { calls, fetchImpl } = recorder(fixture("kartverket-sok-mo-i-rana.json"));
    const deps = { fetchImpl, baseUrl: BASE, cacheDir, minIntervalMs: 0 };
    await geocode("Ole Tobias Olsens gate 6, 8622 Mo i Rana", 1, deps);
    const again = await geocode("ole tobias olsens gate 6  8622 MO I RANA", 1, deps);
    expect(calls).toHaveLength(1);
    expect(again.cached).toBe(true);
    expect(again.results[0].lat).toBeCloseTo(66.30813, 5);
  });

  test("no hit is an empty list, not an error", async () => {
    const { fetchImpl } = recorder(fixture("kartverket-sok-none.json"));
    const r = await geocode("finnesikkeveien 999 nowhere", 5, { fetchImpl, baseUrl: BASE, cacheDir: freshCache(), minIntervalMs: 0 });
    expect(r.results).toEqual([]);
  });

  test("an upstream error is a 502, and nothing is cached", async () => {
    const cacheDir = freshCache();
    const bad = recorder("oops", 500);
    await expect(geocode("storgata 1 oslo", 1, { fetchImpl: bad.fetchImpl, baseUrl: BASE, cacheDir, minIntervalMs: 0 })).rejects.toMatchObject({
      status: 502,
    });
    const good = recorder(fixture("kartverket-sok-none.json"));
    await geocode("storgata 1 oslo", 1, { fetchImpl: good.fetchImpl, baseUrl: BASE, cacheDir, minIntervalMs: 0 });
    expect(good.calls).toHaveLength(1);
  });

  test("a query without a number finds nothing and never calls out", async () => {
    // Kartverket answers "mo i rana" with 9 428 addresses, the first a random cadastral one
    // (127/3, 8616 MO I RANA, 2026-11-08): a pin there would be wrong without anyone noticing.
    const { calls, fetchImpl } = recorder(fixture("kartverket-sok-mo-i-rana.json"));
    const r = await geocode("Mo i Rana, Norge", 1, { fetchImpl, baseUrl: BASE, cacheDir: freshCache(), minIntervalMs: 0 });
    expect(r.results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("a hit whose street and number are not in the query is dropped (no wrong pin)", async () => {
    // Recorded 2026-11-08: "storgata 1 porsgrunn" is answered with Storgata 2 and 2B in Brevik
    // (sok matches loose numbers against other fields), "8622 mo i rana" with 1 059 addresses,
    // the first a cadastral 20/440. Neither may become a pin.
    for (const [q, name] of [
      ["Storgata 1, Porsgrunn, Norge", "kartverket-sok-storgata-1-porsgrunn.json"],
      ["8622 Mo i Rana, Norge", "kartverket-sok-8622-mo-i-rana.json"],
    ]) {
      const { fetchImpl } = recorder(fixture(name));
      const r = await geocode(q, 1, { fetchImpl, baseUrl: BASE, cacheDir: freshCache(), minIntervalMs: 0 });
      expect(r.results).toEqual([]);
    }
  });

  test("asks for more hits than it returns, so a right second hit survives a wrong first", async () => {
    const { calls, fetchImpl } = recorder(fixture("kartverket-sok-8622-mo-i-rana.json"));
    const r = await geocode("Almveien 12, 8622 Mo i Rana", 1, { fetchImpl, baseUrl: BASE, cacheDir: freshCache(), minIntervalMs: 0 });
    expect(Number(calls[0].searchParams.get("treffPerSide"))).toBeGreaterThanOrEqual(10);
    expect(r.results.map((x) => x.displayName)).toEqual(["Almveien 12, 8622 MO I RANA"]);
  });

  test("a letter written apart from the number still matches (6 b = 6B)", async () => {
    const body = fixture("kartverket-sok-storgata-1-porsgrunn.json");
    const { fetchImpl } = recorder(body);
    const r = await geocode("Storgata 2 b, Brevik", 5, { fetchImpl, baseUrl: BASE, cacheDir: freshCache(), minIntervalMs: 0 });
    expect(r.results.map((x) => x.displayName)).toEqual(["Storgata 2B, 3950 BREVIK"]);
  });

  test("an empty or overlong query is a 400 and never calls out", async () => {
    const { calls, fetchImpl } = recorder("{}");
    const deps = { fetchImpl, baseUrl: BASE, cacheDir: freshCache(), minIntervalMs: 0 };
    await expect(geocode("  ,  ", 1, deps)).rejects.toBeInstanceOf(GeocodeError);
    await expect(geocode("x".repeat(301), 1, deps)).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});

describe("reverseGeocode", () => {
  test("asks /punktsok and returns the nearest address", async () => {
    const { calls, fetchImpl } = recorder(fixture("kartverket-punktsok-mo-i-rana.json"));
    const r = await reverseGeocode(66.308131, 14.135732, { fetchImpl, baseUrl: BASE, cacheDir: freshCache(), minIntervalMs: 0 });
    expect(calls[0].pathname).toBe("/adresser/v1/punktsok");
    expect(calls[0].searchParams.get("lat")).toBe("66.30813");
    expect(calls[0].searchParams.get("lon")).toBe("14.13573");
    expect(r.results[0].displayName).toBe("Ole Tobias Olsens gate 6, 8622 MO I RANA");
  });

  test("refuses coordinates that are not coordinates", async () => {
    const { calls, fetchImpl } = recorder("{}");
    await expect(reverseGeocode(91, 0, { fetchImpl, baseUrl: BASE, cacheDir: freshCache() })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});
