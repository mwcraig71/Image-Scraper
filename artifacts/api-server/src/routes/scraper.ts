import { Router, type IRouter, type Request, type Response } from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import archiver from "archiver";
import { randomUUID } from "crypto";

const router: IRouter = Router();

const TARGET_URL = "https://www.thecandidplanet.com/";
const MAX_PAGES = 100;
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

function resetState() {
  state.sessionId = randomUUID();
  state.status = "idle";
  state.pagesVisited = 0;
  state.pagesQueued = 0;
  state.imagesFound = 0;
  state.currentUrl = null;
  state.errorMessage = null;
  state.images = [];
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
  // Match url('...'), url("..."), url(...)
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

function addImage(url: string, sourcePageUrl: string, imageUrls: Set<string>, alt: string | null = null, width: number | null = null, height: number | null = null) {
  if (!imageUrls.has(url)) {
    imageUrls.add(url);
    state.images.push({ id: randomUUID(), url, sourcePageUrl, alt, width, height });
    state.imagesFound += 1;
  }
}

async function crawl() {
  const visited = new Set<string>();
  const imageUrls = new Set<string>();
  const queue: string[] = [TARGET_URL];

  state.pagesQueued = 1;

  while (queue.length > 0 && state.pagesVisited < MAX_PAGES && state.status === "running") {
    const batch = queue.splice(0, CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (pageUrl) => {
        if (visited.has(pageUrl)) return [];
        visited.add(pageUrl);
        state.currentUrl = pageUrl;

        const response = await axios.get(pageUrl, {
          timeout: REQUEST_TIMEOUT,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; ImageScraper/1.0)",
            Accept: "text/html,application/xhtml+xml",
          },
          maxRedirects: 5,
        });

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
              addImage(normalized, pageUrl, imageUrls, alt, w, h);
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
                  addImage(normalized, pageUrl, imageUrls, alt, null, null);
                }
              }
            }
          }
        });

        // ── Inline style attributes with background-image ───────────────────
        $("[style]").each((_i, el) => {
          const style = $(el).attr("style") || "";
          for (const url of extractCssImageUrls(style, pageUrl)) {
            addImage(url, pageUrl, imageUrls, null, null, null);
          }
        });

        // ── <style> blocks ──────────────────────────────────────────────────
        $("style").each((_i, el) => {
          const css = $(el).text();
          for (const url of extractCssImageUrls(css, pageUrl)) {
            addImage(url, pageUrl, imageUrls, null, null, null);
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

  if (state.status === "running") {
    state.status = "done";
    state.currentUrl = null;
  }
}

// POST /api/scraper/start
router.post("/scraper/start", (_req: Request, res: Response) => {
  if (state.status === "running") {
    res.status(409).json({ error: "A scrape is already in progress" });
    return;
  }

  resetState();
  state.status = "running";

  crawl().catch((err: unknown) => {
    state.status = "error";
    state.errorMessage = err instanceof Error ? err.message : String(err);
    state.currentUrl = null;
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
  if (state.status === "running") {
    state.status = "idle"; // signal crawl loop to stop
  }
  resetState();
  res.json({ sessionId: state.sessionId, status: state.status, message: "Reset successful" });
});

// GET /api/scraper/download-zip — streams a zip of all found images
router.get("/scraper/download-zip", async (_req: Request, res: Response) => {
  const images = [...state.images];
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
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to create zip" });
    }
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
