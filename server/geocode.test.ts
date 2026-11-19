/**
 * The geocoder against recorded Kartverket answers (fixtures/kartverket-*, fetched 2026-11-08 and
 * 2026-11-19 from https://api.kartverket.no/adresser/v1/; fixtures/constructed-* are not Kartverket
 * answers and say so inside). No test calls the live API: fetch is injected.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fuzzyHitMatchesQuery, geocode, GeocodeError, kartverketQuery, reverseGeocode } from "./geocode";

const fixture = (name: string) => readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8");

// One temp dir for every cache in this file, removed whether the tests pass or fail.
const tmpRoot = mkdtempSync(path.join(tmpdir(), "gable-maps-geocode-test-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const freshCache = () => path.join(tmpRoot, String(n++));

/**
 * A fetch that records what was asked, and when, and answers from fixtures: the n-th call gets the
 * n-th body (or status), the last one repeating.
 */
function recorder(body: string | string[], status: number | number[] = 200) {
  const bodies = Array.isArray(body) ? body : [body];
  const statuses = Array.isArray(status) ? status : [status];
  const calls: URL[] = [];
  const at: number[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const i = calls.length;
    calls.push(new URL(String(input instanceof Request ? input.url : input)));
    at.push(performance.now());
    return new Response(bodies[Math.min(i, bodies.length - 1)], {
      status: statuses[Math.min(i, statuses.length - 1)],
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, at, fetchImpl };
}

/** The sok a recorded fixture answered, from its own metadata.sokeStreng. */
const recordedSok = (body: string) => new URLSearchParams(JSON.parse(body).metadata.sokeStreng).get("sok");

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
  test("spells out a joined abbreviation, one per suffix (Kartverket finds 'kirkegt. 3 arendal' as nothing, 2026-11-19)", () => {
    expect(kartverketQuery("kirkegt. 3 arendal")).toBe("kirkegata 3 arendal");
    expect(kartverketQuery("drammensvn. 175 oslo")).toBe("drammensveien 175 oslo");
    expect(kartverketQuery("gamle svinesundsv. 112")).toBe("gamle svinesundsveien 112");
    expect(kartverketQuery("rådhuspl. 1 oslo")).toBe("rådhusplass 1 oslo");
    expect(kartverketQuery("nygt. 4 lillestrøm")).toBe("nygata 4 lillestrøm");
  });
  test("leaves words that only end in those letters alone", () => {
    // No dot, no abbreviation: "nyhavn" and "navn" end in "vn", "langt" in "gt", "kapl" in "pl".
    expect(kartverketQuery("nyhavn 3 trondheim")).toBe("nyhavn 3 trondheim");
    expect(kartverketQuery("kirkegt 3 arendal")).toBe("kirkegt 3 arendal");
    expect(kartverketQuery("langt 1")).toBe("langt 1");
    expect(kartverketQuery("kapl 2")).toBe("kapl 2");
    // "gt"/"pl"/"vn" inside a word is not a suffix.
    expect(kartverketQuery("engtjernveien 5")).toBe("engtjernveien 5");
    expect(kartverketQuery("splitvn 5")).toBe("splitvn 5");
    expect(kartverketQuery("gtx 1")).toBe("gtx 1");
    // A one-letter stem is a road class or a word, not a street: riksvei, fylkesvei, "v." for "ved".
    expect(kartverketQuery("rv. 4 gran")).toBe("rv. 4 gran");
    expect(kartverketQuery("fv. 33 1")).toBe("fv. 33 1");
    expect(kartverketQuery("hotell v. torget 2")).toBe("hotell v. torget 2");
    expect(kartverketQuery("k. 3")).toBe("k. 3");
    // A number or a dot in the stem is not a street name.
    expect(kartverketQuery("st.pl. 1")).toBe("st.pl. 1");
    expect(kartverketQuery("e6v. 1")).toBe("e6v. 1");
  });
});

describe("joined abbreviations against Kartverket", () => {
  // Each fixture is Kartverket's real answer (2026-11-19) to exactly the string the code sends;
  // the test checks the outgoing sok against the fixture's own metadata.sokeStreng, so it cannot
  // pass on an answer to a query that was never asked.
  for (const [asked, name, expected] of [
    ["Kirkegt. 3, Arendal, Norge", "kartverket-sok-kirkegata-3-arendal.json", "Kirkegaten 3, 4836 ARENDAL"],
    ["Drammensvn. 175, Oslo", "kartverket-sok-drammensveien-175-oslo.json", "Drammensveien 175, 0277 OSLO"],
    ["Gamle Svinesundsv. 112", "kartverket-sok-gamle-svinesundsveien-112.json", "Gamle Svinesundsvei 112, 1789 BERG I ØSTFOLD"],
    ["Rådhuspl. 1, Oslo", "kartverket-sok-radhusplass-1-oslo.json", "Rådhusplassen 1, 0037 OSLO"],
  ]) {
    test(`${asked} -> ${expected}`, async () => {
      const body = fixture(name);
      const { calls, fetchImpl } = recorder(body);
      const r = await geocode(asked, 1, { fetchImpl, baseUrl: BASE, cacheDir: freshCache(), minIntervalMs: 0 });
      const recorded = new URLSearchParams(JSON.parse(body).metadata.sokeStreng).get("sok");
      expect(calls[0].searchParams.get("sok")).toBe(recorded);
      expect(r.results.map((x) => x.displayName)).toEqual([expected]);
    });
  }

  test("gata/gaten/gate, veien/vei and plass/plassen are one word, as Kartverket's sok treats them", async () => {
    // Measured 2026-11-19: "kirkegata", "kirkegate" and "kirkegaten 3 arendal" all answer Kirkegaten 3;
    // "gamle svinesundsveien 112" answers Gamle Svinesundsvei 112; "rådhusplass" answers Rådhusplassen.
    for (const [asked, name, expected] of [
      ["Kirkegata 3, Arendal", "kartverket-sok-kirkegata-3-arendal.json", "Kirkegaten 3, 4836 ARENDAL"],
      ["Gamle Svinesundsveien 112", "kartverket-sok-gamle-svinesundsveien-112.json", "Gamle Svinesundsvei 112, 1789 BERG I ØSTFOLD"],
      ["Rådhusplass 1, Oslo", "kartverket-sok-radhusplass-1-oslo.json", "Rådhusplassen 1, 0037 OSLO"],
    ]) {
      const { fetchImpl } = recorder(fixture(name));
      const r = await geocode(asked, 1, { fetchImpl, baseUrl: BASE, cacheDir: freshCache(), minIntervalMs: 0 });
      expect(r.results.map((x) => x.displayName)).toEqual([expected]);
    }
  });

  test("the fold is of the ending only: another street or number is still dropped", async () => {
    const { fetchImpl } = recorder(fixture("kartverket-sok-kirkegata-3-arendal.json"));
    for (const asked of ["Kirkeveien 3, Arendal", "Kirkegata 33, Arendal", "Storkirkegata 3, Arendal"]) {
      const r = await geocode(asked, 1, { fetchImpl, baseUrl: BASE, cacheDir: freshCache(), minIntervalMs: 0 });
      expect(r.results).toEqual([]);
    }
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
    // Called out again: the exact ask, and (it is empty) the fuzzy retry.
    expect(good.calls).toHaveLength(2);
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

describe("misspelled streets: one fuzzy retry", () => {
  // Kartverket's real answers (2026-11-19) to the exact query, then to the same sok with fuzzy=true.
  const deps = (fetchImpl: typeof fetch, minIntervalMs = 0) => ({ fetchImpl, baseUrl: BASE, cacheDir: freshCache(), minIntervalMs });

  for (const [asked, stem, expected] of [
    ["Kirkegatn 3, Arendal", "kirkegatn-3-arendal", ["Kirkegaten 3, 4836 ARENDAL"]],
    ["Rådhusplasen 1, Oslo", "radhusplasen-1-oslo", ["Rådhusplassen 1, 0037 OSLO"]],
    // A nynorsk street asked in bokmål: exact finds nothing (Kartverket does not fold vei/veg).
    // Fuzzy also offers Kyrkjevegen 3 in Suldalsosen; Røldal is not its place, so it is not kept.
    ["Kyrkjeveien 3, Røldal", "kyrkjeveien-3-roldal", ["Kyrkjevegen 3, 5760 RØLDAL"]],
    // Exact answers Ole Tobias Olsens gate 6, which the exact filter drops ("olsen" is not "olsens"):
    // the retry is on an empty answer after the filter, not on zero raw hits.
    ["Ole Tobias Olsen gate 6, 8622 Mo i Rana", "ole-tobias-olsen-gate-6-mo-i-rana", ["Ole Tobias Olsens gate 6, 8622 MO I RANA"]],
  ] as const) {
    test(`a near miss is found: ${asked}`, async () => {
      const exact = fixture(`kartverket-sok-${stem}.json`);
      const fuzzy = fixture(`kartverket-sok-${stem}-fuzzy.json`);
      const { calls, fetchImpl } = recorder([exact, fuzzy]);
      const r = await geocode(asked, 5, deps(fetchImpl));
      expect(calls).toHaveLength(2);
      expect(calls[0].searchParams.get("sok")).toBe(recordedSok(exact));
      expect(calls[0].searchParams.has("fuzzy")).toBe(false);
      expect(calls[1].searchParams.get("sok")).toBe(recordedSok(fuzzy));
      expect(calls[1].searchParams.get("fuzzy")).toBe("true");
      expect(r.results.map((x) => x.displayName)).toEqual([...expected]);
    });
  }

  test("a different street with the right number is NOT accepted", async () => {
    // "kirkevein 3 arendal": fuzzy answers Flosta Kirkevei 3 (Arendal kommune) and Tromøy kirkevei 349.
    // Flosta Kirkevei is another street, though its number and kommune fit.
    const exact = fixture("kartverket-sok-kirkevein-3-arendal.json");
    const fuzzy = fixture("kartverket-sok-kirkevein-3-arendal-fuzzy.json");
    const { calls, fetchImpl } = recorder([exact, fuzzy]);
    const r = await geocode("Kirkevein 3, Arendal", 5, deps(fetchImpl));
    expect(calls).toHaveLength(2);
    expect(r.results).toEqual([]);
  });

  test("the right street with another number is NOT accepted (the number is exact)", async () => {
    // "storgata 1 porsgrunn": exact and fuzzy both answer only Storgata 2 and 2B in Brevik.
    const exact = fixture("kartverket-sok-storgata-1-porsgrunn.json");
    const fuzzy = fixture("kartverket-sok-storgata-1-porsgrunn-fuzzy.json");
    const { calls, fetchImpl } = recorder([exact, fuzzy]);
    const r = await geocode("Storgata 1, Porsgrunn", 5, deps(fetchImpl));
    expect(calls).toHaveLength(2);
    expect(calls[1].searchParams.get("fuzzy")).toBe("true");
    expect(r.results).toEqual([]);
  });

  test("only the street is loosened: a misspelled town gives no pin", async () => {
    // Fuzzy answers "kirkegaten 3 arndal" with Kirkegaten 3, ARENDAL. "arndal" is not its place.
    // (The exact call's answer is the shared empty fixture; it was not recorded for this query.)
    const fuzzy = fixture("kartverket-sok-kirkegaten-3-arndal-fuzzy.json");
    const { calls, fetchImpl } = recorder([fixture("kartverket-sok-none.json"), fuzzy]);
    const r = await geocode("Kirkegaten 3, Arndal", 5, deps(fetchImpl));
    expect(calls[1].searchParams.get("sok")).toBe(recordedSok(fuzzy));
    expect(r.results).toEqual([]);
  });

  test("two different near streets give no pin (constructed fixture)", async () => {
    const { fetchImpl } = recorder([fixture("kartverket-sok-kirkegatn-3-arendal.json"), fixture("constructed-sok-kirkegatn-3-arendal-fuzzy-tie.json")]);
    const r = await geocode("Kirkegatn 3, Arendal", 5, deps(fetchImpl));
    expect(r.results).toEqual([]);
  });

  test("the edit allowance scales with length: short words exact, a far street rejected", () => {
    const row = (street: string) => ({ adressetekstutenadressetilleggsnavn: street, poststed: "ARENDAL", kommunenavn: "ARENDAL" });
    expect(fuzzyHitMatchesQuery(row("Kirkegaten 3"), "kirkegatn 3 arendal")).toBe(true);
    expect(fuzzyHitMatchesQuery(row("Kirkgata 3"), "kirkegatn 3 arendal")).toBe(false); // 2 edits at 8 letters
    expect(fuzzyHitMatchesQuery(row("Lia 3"), "lie 3 arendal")).toBe(false); // under 5 letters: exact only
    expect(fuzzyHitMatchesQuery(row("Kirkegaten 3B"), "kirkegatn 3 arendal")).toBe(false); // the letter is part of the number
    expect(fuzzyHitMatchesQuery(row("Kirkegaten 3"), "kirkegatn 3 4836 arendal")).toBe(false); // 4836 is not this row's place
  });

  test("an exact hit is never retried", async () => {
    const { calls, fetchImpl } = recorder(fixture("kartverket-sok-kirkegata-3-arendal.json"));
    await geocode("Kirkegata 3, Arendal", 5, deps(fetchImpl));
    expect(calls).toHaveLength(1);
  });

  test("a wildcard query is not retried (Kartverket: fuzzy is not compatible with *)", async () => {
    const { calls, fetchImpl } = recorder(fixture("kartverket-sok-none.json"));
    await geocode("kirke* 3 arendal", 5, deps(fetchImpl));
    expect(calls).toHaveLength(1);
  });

  test("the retry is spaced like any other call", async () => {
    const { at, fetchImpl } = recorder([fixture("kartverket-sok-kirkegatn-3-arendal.json"), fixture("kartverket-sok-kirkegatn-3-arendal-fuzzy.json")]);
    await geocode("Kirkegatn 3, Arendal", 1, deps(fetchImpl, 60));
    expect(at).toHaveLength(2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(55);
  });

  test("a failed retry is a 502 and caches nothing, so the next ask tries both again", async () => {
    const cacheDir = freshCache();
    const miss = fixture("kartverket-sok-kirkegatn-3-arendal.json");
    const bad = recorder([miss, "oops"], [200, 500]);
    await expect(geocode("Kirkegatn 3, Arendal", 1, { fetchImpl: bad.fetchImpl, baseUrl: BASE, cacheDir, minIntervalMs: 0 })).rejects.toMatchObject({
      status: 502,
    });
    const good = recorder([miss, fixture("kartverket-sok-kirkegatn-3-arendal-fuzzy.json")]);
    const r = await geocode("Kirkegatn 3, Arendal", 1, { fetchImpl: good.fetchImpl, baseUrl: BASE, cacheDir, minIntervalMs: 0 });
    expect(good.calls).toHaveLength(2);
    expect(r.results.map((x) => x.displayName)).toEqual(["Kirkegaten 3, 4836 ARENDAL"]);
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
