/**
 * The map renderer's HTTP service (Bun).
 *
 *   GET  /health          liveness + browser and queue state
 *   GET  /presets         the preset names
 *   POST /render          JSON request -> PNG bytes (see README "Render API")
 *   GET  /geocode?q=...   Nominatim, rate-limited and cached
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
import { geocode, GeocodeError } from "./geocode";
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

const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health" && req.method === "GET") {
        return json({ ok: true, browser: browserState(), queue: queueDepth(), tileUrl: config.tileUrl });
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
        console.log(`render ${v.value.preset} ${v.value.width}x${v.value.height} z${v.value.zoom} ${ms}ms ${png.length}B`);
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

console.log(`map renderer listening on :${server.port} (tiles ${config.tileUrl})`);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    await closeBrowser();
    server.stop();
    process.exit(0);
  });
}
