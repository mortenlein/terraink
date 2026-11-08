/**
 * The map renderer's HTTP service (Bun).
 *
 *   GET  /health          liveness + browser and queue state
 *   GET  /presets         the preset names
 *   POST /render          JSON request -> PNG bytes (see README "Render API")
 *   GET  /geocode?q=...   address -> coordinates (Kartverket, server/geocode.ts), cached
 *   GET  /reverse?lat=&lng=  coordinates -> nearest address (Kartverket), cached
 *   GET  /tiles/*         the tile service (TILE_URL's origin), for the editor in a browser
 *   GET  /*               the built app (dist/): the editor and render.html
 *
 * Bound to 0.0.0.0 inside the container; the host publishes it on
 * 127.0.0.1 only (infra/compose.yml). There is no auth: nothing outside the
 * host can reach it.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { browserState, closeBrowser, queueDepth, render, RenderError } from "./render";
import { geocode, GeocodeError, reverseGeocode } from "./geocode";
import { validateRender } from "./validate";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(config.distDir, rel);
  if (!file.startsWith(path.resolve(config.distDir) + path.sep)) return new Response("Not found", { status: 404 });
  const f = Bun.file(file);
  if (!(await f.exists())) return new Response("Not found", { status: 404 });
  return new Response(f);
}

/**
 * The editor runs in a browser on the host, which cannot resolve the tile service's name on the
 * compose network; it asks /tiles/* here instead. TileJSON (JSON) answers name the upstream origin
 * in their tile URLs, so that origin is rewritten to ours. The headless render does not use this:
 * its Chromium is on the network and fetches the tile service directly.
 */
async function proxyTiles(url: URL): Promise<Response> {
  const upstream = new URL(config.tileUrl).origin;
  const target = upstream + url.pathname.slice("/tiles".length) + url.search;
  // fetch decodes gzip itself, so the upstream's Content-Encoding/Length must not be passed on.
  const res = await fetch(target);
  const type = res.headers.get("Content-Type") ?? "";
  if (!type.includes("json")) {
    const headers = new Headers(res.headers);
    headers.delete("Content-Encoding");
    headers.delete("Content-Length");
    return new Response(res.body, { status: res.status, headers });
  }
  const body = (await res.text()).split(upstream).join(`${url.origin}/tiles`);
  return new Response(body, { status: res.status, headers: { "Content-Type": type } });
}

const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health" && req.method === "GET") {
        return json({ ok: true, browser: browserState(), queue: queueDepth(), tileUrl: config.tileUrl, glyphsUrl: config.glyphsUrl, geocoderUrl: config.geocoderUrl });
      }
      if (url.pathname === "/presets" && req.method === "GET") {
        const names = (await readdir(config.presetsDir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
        return json({ presets: names });
      }
      if (url.pathname === "/render") {
        if (req.method !== "POST") return json({ error: "use POST" }, 405);
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return json({ error: "body must be JSON" }, 400);
        }
        const v = validateRender(body, config);
        if (!v.ok) return json({ error: v.error }, 400);
        const { png, ms } = await render(v.value);
        const { preset, width, height, zoom, scale, pitch, bearing, buildings3d } = v.value;
        console.log(
          `render ${preset} ${width}x${height}@${scale}x z${zoom} p${pitch ?? "-"} b${bearing ?? "-"} 3d:${buildings3d ?? "-"} ${ms}ms ${png.length}B`,
        );
        return new Response(png, {
          headers: { "Content-Type": "image/png", "X-Render-Ms": String(ms), "Cache-Control": "no-store" },
        });
      }
      if (url.pathname === "/geocode") {
        if (req.method !== "GET") return json({ error: "use GET" }, 405);
        const q = url.searchParams.get("q") ?? "";
        const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit") ?? 5) || 5));
        return json(await geocode(q, limit));
      }
      if (url.pathname === "/reverse") {
        if (req.method !== "GET") return json({ error: "use GET" }, 405);
        const lat = Number(url.searchParams.get("lat"));
        const lng = Number(url.searchParams.get("lng"));
        if (!url.searchParams.get("lat") || !url.searchParams.get("lng")) return json({ error: "lat and lng are required" }, 400);
        return json(await reverseGeocode(lat, lng));
      }
      if (url.pathname.startsWith("/tiles/") && req.method === "GET") return proxyTiles(url);
      if (req.method === "GET" || req.method === "HEAD") return serveStatic(url.pathname);
      return json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof RenderError || err instanceof GeocodeError) {
        console.warn(`${url.pathname} ${err.status}: ${err.message}`);
        return json({ error: err.message }, err.status);
      }
      console.error(`${url.pathname} 500:`, err);
      return json({ error: "internal error" }, 500);
    }
  },
});

console.log(`map renderer listening on :${server.port} (tiles ${config.tileUrl}, glyphs ${config.glyphsUrl}, geocoder ${config.geocoderUrl})`);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    await closeBrowser();
    server.stop();
    process.exit(0);
  });
}
