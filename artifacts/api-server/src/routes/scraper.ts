import { Router, type IRouter, type Request, type Response } from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import archiver from "archiver";
import { randomUUID } from "crypto";

const router: IRouter = Router();

const TARGET_URL = "https://www.thecandidplanet.com/";
const DEFAULT_MAX_PAGES = 500;
const CONCURRENCY = 3;
const REQUEST_TIMEOUT = 15000;

interface ScrapedImage {
  id: string;
  url: string;
  sourcePageUrl: string;
  alt: string | null;
  width: number | null;
  height: number | null;
}

interface ScrapeState {
  sessionId: string;
  status: "idle" | "running" | "done" | "error";
  pagesVisited: number;
  pagesQueued: number;
  imagesFound: number;
  currentUrl: string | null;
  errorMessage: string | null;
  images: ScrapedImage[];
}

const state: ScrapeState = {
  sessionId: "none",
  status: "idle",
  pagesVisited: 0,
  pagesQueued: 0,
  imagesFound: 0,
  currentUrl: null,
  errorMessage: null,
  images: [],
};

function resetState(): string {
  const newSessionId = randomUUID();
  state.sessionId = newSessionId;
  state.status = "idle";
  state.pagesVisited = 0;
  state.pagesQueued = 0;
  state.imagesFound = 0;
  state.currentUrl = null;
  state.errorMessage = null;
  state.images = [];
  return newSessionId;
}

function normalizeUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    const target = new URL(TARGET_URL);
    if (url.hostname !== target.hostname) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeImageUrl(src: string, base: string): string | null {
  try {
    const url = new URL(src, base);
    return url.toString();
  } catch {
    return null;
  }
}

function isImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const pathname = u.pathname.toLowerCase();
    if (/\.(jpe?g|png|gif|webp|svg|bmp|avif|tiff?)(\?|$)/i.test(pathname)) return true;
    if (url.startsWith("data:image/")) return true;
    return false;
  } catch {
    return false;
  }
}

function extractCssImageUrls(css: string, base: string): string[] {
  const urls: string[] = [];
  const regex = /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(css)) !== null) {
    const rawUrl = match[2];
    if (!rawUrl || rawUrl.startsWith("data:")) continue;
    const normalized = normalizeImageUrl(rawUrl, base);
    if (normalized && isImageUrl(normalized)) {
      urls.push(normalized);
    }
  }
  return urls;
}

function addImage(
  url: string,
  sourcePageUrl: string,
  imageUrls: Set<string>,
  sessionId: string,
  minDimension: number,
  alt: string | null = null,
  width: number | null = null,
  height: number | null = null,
) {
  // Guard: only write if this crawl's session is still the active one
  if (state.sessionId !== sessionId) return;
  // Skip images whose known dimensions fall below the threshold
  if (minDimension > 0 && width !== null && height !== null) {
    if (width < minDimension || height < minDimension) return;
  }
  if (!imageUrls.has(url)) {
    imageUrls.add(url);
    state.images.push({ id: randomUUID(), url, sourcePageUrl, alt, width, height });
    state.imagesFound += 1;
  }
}

async function crawl(sessionId: string, maxPages: number, minDimension: number, cookies: string) {
  const visited = new Set<string>();
  const imageUrls = new Set<string>();
  const queue: string[] = [TARGET_URL];

  state.pagesQueued = 1;

  while (
    queue.length > 0 &&
    (maxPages === 0 || state.pagesVisited < maxPages) &&
    state.status === "running" &&
    state.sessionId === sessionId  // stop if reset/new session started
  ) {
    const batch = queue.splice(0, CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (pageUrl) => {
        if (visited.has(pageUrl)) return [];
        visited.add(pageUrl);

        // Re-check session is still active before each fetch
        if (state.sessionId !== sessionId) return [];

        state.currentUrl = pageUrl;

        const response = await axios.get(pageUrl, {
          timeout: REQUEST_TIMEOUT,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; ImageScraper/1.0)",
            Accept: "text/html,application/xhtml+xml",
            ...(cookies ? { Cookie: cookies } : {}),
          },
          maxRedirects: 5,
        });

        // Re-check after async fetch
        if (state.sessionId !== sessionId) return [];

        state.pagesVisited += 1;
        const html = response.data as string;
        const $ = cheerio.load(html);

        // ── <img> tags ──────────────────────────────────────────────────────
        $("img").each((_i, el) => {
          const alt = $(el).attr("alt") || null;
          const w = parseInt($(el).attr("width") || "0") || null;
          const h = parseInt($(el).attr("height") || "0") || null;

          const candidates = [
            $(el).attr("src"),
            $(el).attr("data-src"),
            $(el).attr("data-lazy-src"),
            $(el).attr("data-original"),
          ].filter(Boolean) as string[];

          for (const src of candidates) {
            const normalized = normalizeImageUrl(src, pageUrl);
            if (normalized && isImageUrl(normalized)) {
              addImage(normalized, pageUrl, imageUrls, sessionId, minDimension, alt, w, h);
            }
          }

          // srcset
          const srcsets = [
            $(el).attr("srcset"),
            $(el).attr("data-srcset"),
          ].filter(Boolean) as string[];

          for (const srcset of srcsets) {
            for (const part of srcset.split(",")) {
              const src = part.trim().split(/\s+/)[0];
              if (src) {
                const normalized = normalizeImageUrl(src, pageUrl);
                if (normalized && isImageUrl(normalized)) {
                  addImage(normalized, pageUrl, imageUrls, sessionId, minDimension, alt, null, null);
                }
              }
            }
          }
        });

        // ── Inline style background-image ───────────────────────────────────
        $("[style]").each((_i, el) => {
          const style = $(el).attr("style") || "";
          for (const url of extractCssImageUrls(style, pageUrl)) {
            addImage(url, pageUrl, imageUrls, sessionId, minDimension, null, null, null);
          }
        });

        // ── <style> blocks ──────────────────────────────────────────────────
        $("style").each((_i, el) => {
          const css = $(el).text();
          for (const url of extractCssImageUrls(css, pageUrl)) {
            addImage(url, pageUrl, imageUrls, sessionId, minDimension, null, null, null);
          }
        });

        // ── Internal links for further crawling ─────────────────────────────
        const newLinks: string[] = [];
        $("a[href]").each((_i, el) => {
          const href = $(el).attr("href");
          if (href) {
            const normalized = normalizeUrl(href, pageUrl);
            if (normalized && !visited.has(normalized) && !queue.includes(normalized)) {
              newLinks.push(normalized);
            }
          }
        });

        return newLinks;
      })
    );

    if (state.sessionId !== sessionId) break;

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        for (const link of result.value) {
          if (!visited.has(link) && !queue.includes(link)) {
            queue.push(link);
            state.pagesQueued += 1;
          }
        }
      }
    }
  }

  // Only finalize status if this session is still active
  if (state.sessionId === sessionId && state.status === "running") {
    state.status = "done";
    state.currentUrl = null;
  }
}

// POST /api/scraper/start
router.post("/scraper/start", (req: Request, res: Response) => {
  if (state.status === "running") {
    res.status(409).json({ error: "A scrape is already in progress" });
    return;
  }

  const body = req.body as { maxPages?: number; minDimension?: number; cookies?: string } | undefined;
  const maxPages =
    typeof body?.maxPages === "number" && body.maxPages >= 0
      ? body.maxPages
      : DEFAULT_MAX_PAGES;
  const minDimension =
    typeof body?.minDimension === "number" && body.minDimension >= 0
      ? body.minDimension
      : 0;
  const cookies = typeof body?.cookies === "string" ? body.cookies.trim() : "";

  const sessionId = resetState();
  state.status = "running";

  crawl(sessionId, maxPages, minDimension, cookies).catch((err: unknown) => {
    if (state.sessionId === sessionId) {
      state.status = "error";
      state.errorMessage = err instanceof Error ? err.message : String(err);
      state.currentUrl = null;
    }
  });

  res.json({ sessionId: state.sessionId, status: state.status, message: "Scrape started" });
});

// GET /api/scraper/status
router.get("/scraper/status", (_req: Request, res: Response) => {
  res.json({
    sessionId: state.sessionId,
    status: state.status,
    pagesVisited: state.pagesVisited,
    pagesQueued: state.pagesQueued,
    imagesFound: state.imagesFound,
    currentUrl: state.currentUrl,
    errorMessage: state.errorMessage,
  });
});

// GET /api/scraper/images
router.get("/scraper/images", (_req: Request, res: Response) => {
  res.json(state.images);
});

// POST /api/scraper/reset
router.post("/scraper/reset", (_req: Request, res: Response) => {
  // Generating a new sessionId causes any in-flight crawl to stop writing
  const sessionId = resetState();
  res.json({ sessionId, status: state.status, message: "Reset successful" });
});

// GET /api/scraper/images/:id/download — server-side proxy for cross-origin downloads
router.get("/scraper/images/:id/download", async (req: Request, res: Response) => {
  const { id } = req.params;
  const image = state.images.find((img) => img.id === id);

  if (!image) {
    res.status(404).json({ error: "Image not found" });
    return;
  }

  try {
    const upstream = await axios.get(image.url, {
      responseType: "stream",
      timeout: REQUEST_TIMEOUT,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ImageScraper/1.0)",
        Accept: "image/*,*/*",
      },
    });

    const contentType =
      (upstream.headers["content-type"] as string | undefined) || "application/octet-stream";
    const ext = contentType.split("/")[1]?.split(";")[0]?.trim() || "jpg";
    const filename = `image-${id.slice(0, 8)}.${ext}`;

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-cache");

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    (upstream.data as NodeJS.ReadableStream).pipe(res);
  } catch {
    if (!res.headersSent) {
      res.status(502).json({ error: "Failed to fetch image from origin" });
    }
  }
});

// GET /api/scraper/download-zip — streams a zip of all (or selected) found images
router.get("/scraper/download-zip", async (req: Request, res: Response) => {
  const idsParam = req.query.ids as string | undefined;
  const idSet = idsParam ? new Set(idsParam.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const images = idSet ? state.images.filter((img) => idSet.has(img.id)) : [...state.images];
  if (images.length === 0) {
    res.status(400).json({ error: "No images to download" });
    return;
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="scraped-images.zip"');

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.pipe(res);

  archive.on("error", (err: archiver.ArchiverError) => {
    console.error("Archive error:", err);
  });

  const BATCH = 5;
  for (let i = 0; i < images.length; i += BATCH) {
    const batch = images.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (img) => {
        try {
          const response = await axios.get(img.url, {
            responseType: "stream",
            timeout: REQUEST_TIMEOUT,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; ImageScraper/1.0)" },
          });
          const ext = (img.url.split("?")[0].split(".").pop() || "jpg").toLowerCase();
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          archive.append(response.data as import("stream").Readable, { name: `${img.id}.${ext}` });
        } catch {
          // Skip images that fail to download
        }
      })
    );
  }

  await archive.finalize();
});

export default router;
