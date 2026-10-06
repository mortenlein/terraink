/**
 * Drives render.html in headless Chromium, one render at a time.
 *
 * WebGL comes from SwiftShader (software), so the container needs no GPU.
 * Recent Chromium only allows the SwiftShader WebGL fallback with
 * --enable-unsafe-swiftshader; the page loads nothing but our own bundle and
 * the tile source, which is what makes that flag acceptable here.
 */
import { chromium, type Browser } from "playwright-core";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { attributionText, resolveView, type RenderInput } from "./validate";

export class RenderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!launching) {
    launching = chromium
      .launch({
        executablePath: config.chromiumPath,
        args: [
          "--use-angle=swiftshader",
          "--use-gl=angle",
          "--enable-unsafe-swiftshader",
          "--ignore-gpu-blocklist",
          "--disable-dev-shm-usage",
        ],
      })
      .then((b) => {
        browser = b;
        b.on("disconnected", () => {
          browser = null;
        });
        return b;
      })
      .finally(() => {
        launching = null;
      });
  }
  return launching;
}

export function browserState(): "up" | "idle" {
  return browser?.isConnected() ? "up" : "idle";
}

export async function closeBrowser(): Promise<void> {
  await browser?.close().catch(() => {});
}

/* ── Presets ── */

export async function loadPreset(name: string): Promise<Record<string, unknown>> {
  const file = path.join(config.presetsDir, `${name}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new RenderError(`unknown preset: ${name}`, 400);
  }
}

/* ── Attribution, read from the tile source's own TileJSON ── */

let attributionCache: { text: string; at: number } | null = null;

export async function tileAttribution(): Promise<string> {
  if (config.attributionOverride) return config.attributionOverride;
  if (attributionCache && Date.now() - attributionCache.at < 24 * 3600_000) return attributionCache.text;
  const res = await fetch(config.tileUrl, { headers: { "User-Agent": config.userAgent } });
  if (!res.ok) throw new RenderError(`tile source answered ${res.status}`, 502);
  const tj = (await res.json()) as { attribution?: string };
  const text = attributionText(tj.attribution ?? "");
  // A map image without attribution breaks ODbL; refuse rather than guess.
  if (!text) throw new RenderError("tile source has no attribution; set MAP_ATTRIBUTION", 502);
  attributionCache = { text, at: Date.now() };
  return text;
}

/* ── Queue: one render at a time ── */

let chain: Promise<unknown> = Promise.resolve();
let waiting = 0;

export function queueDepth(): number {
  return waiting;
}

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  if (waiting >= config.maxQueue) {
    return Promise.reject(new RenderError("render queue is full; retry later", 503));
  }
  waiting++;
  const run = chain.then(job);
  chain = run.catch(() => {}).finally(() => {
    waiting--;
  });
  return run;
}

/* ── One render ── */

async function renderOnce(input: RenderInput): Promise<{ png: Buffer; ms: number }> {
  const [preset, attribution] = await Promise.all([loadPreset(input.preset), tileAttribution()]);
  const view = resolveView(input, preset);
  const b = await getBrowser();
  const context = await b.newContext({ viewport: { width: 800, height: 600 } });
  // Glyphs count like tiles: a missing glyph range would drop names silently.
  const sourceHosts = new Set([new URL(config.tileUrl).host, new URL(config.glyphsUrl.replace(/[{}]/g, "")).host]);
  const failures: string[] = [];
  const started = Date.now();
  try {
    const page = await context.newPage();
    // A tile that fails still lets MapLibre go idle, and the image is then
    // blank where the tile was: count failures and refuse the render.
    page.on("response", (r) => {
      if (r.status() >= 400 && sourceHosts.has(new URL(r.url()).host)) failures.push(`${r.status()} ${r.url()}`);
    });
    page.on("requestfailed", (r) => {
      if (sourceHosts.has(new URL(r.url()).host)) failures.push(`${r.failure()?.errorText} ${r.url()}`);
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto(`http://127.0.0.1:${config.port}/render.html`, { waitUntil: "load" });
    await page.waitForFunction(() => (window as any).renderReady === true, null, { timeout: 10_000 });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new RenderError(`render timed out after ${config.renderTimeoutMs} ms`, 504)), config.renderTimeoutMs),
    );
    const result = (await Promise.race([
      page.evaluate((req) => (window as any).renderMap(req), {
        lat: input.lat,
        lng: input.lng,
        zoom: input.zoom,
        width: input.width,
        height: input.height,
        preset,
        label: input.label,
        marker: input.marker,
        pitch: view.pitch,
        bearing: view.bearing,
        buildings3d: view.buildings3d,
        scale: input.scale,
        sourceUrl: config.tileUrl,
        glyphsUrl: config.glyphsUrl,
        attribution,
      }),
      timeout,
    ])) as { png: string; ms: number };

    if (failures.length) {
      throw new RenderError(`tile fetch failed (${failures.length}): ${failures[0]}`, 502);
    }
    if (pageErrors.length) {
      throw new RenderError(`render page error: ${pageErrors[0]}`, 500);
    }
    return { png: Buffer.from(result.png, "base64"), ms: Date.now() - started };
  } finally {
    await context.close().catch(() => {});
  }
}

export function render(input: RenderInput): Promise<{ png: Buffer; ms: number }> {
  return enqueue(() => renderOnce(input));
}
