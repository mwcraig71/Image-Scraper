import { Router, type IRouter, type Request, type Response } from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import archiver from "archiver";
import { randomUUID } from "crypto";
import { imageSize } from "image-size";

const router: IRouter = Router();

const TARGET_URL = "https://www.thecandidplanet.com/";
const DEFAULT_MAX_PAGES = 500;
const CONCURRENCY = 3;
const REQUEST_TIMEOUT = 15000;
const IMAGE_PROBE_CONCURRENCY = 5;
const IMAGE_PROBE_TIMEOUT = 8000;
const IMAGE_PROBE_MAX_BYTES = 8192;

interface ScrapedImage {
  id: string;
  url: string;
  sourcePageUrl: string;
  alt: string | null;
  width: number | null;
  height: number | null;
}

interface ScrapedVideo {
  id: string;
  url: string;
  sourcePageUrl: string;
  filename: string;
}

interface ScrapeState {
  sessionId: string;
  status: "idle" | "running" | "done" | "error";
  pagesVisited: number;
  pagesQueued: number;
  imagesFound: number;
  videosFound: number;
  currentUrl: string | null;
  errorMessage: string | null;
  images: ScrapedImage[];
  videos: ScrapedVideo[];
}

const state: ScrapeState = {
  sessionId: "none",
  status: "idle",
  pagesVisited: 0,
  pagesQueued: 0,
  imagesFound: 0,
  videosFound: 0,
  currentUrl: null,
  errorMessage: null,
  images: [],
  videos: [],
};

function resetState(): string {
  const newSessionId = randomUUID();
  state.sessionId = newSessionId;
  state.status = "idle";
  state.pagesVisited = 0;
  state.pagesQueued = 0;
  state.imagesFound = 0;
  state.videosFound = 0;
  state.currentUrl = null;
  state.errorMessage = null;
  state.images = [];
  state.videos = [];
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

function isVideoUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return /\.(mp4|webm|mov|avi|mkv|m4v|ogv|wmv|flv|m2ts|ts)(\?|$)/i.test(pathname);
  } catch {
    return false;
  }
}

function videoFilename(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
  } catch {
    return url;
  }
}

function addVideo(
  url: string,
  sourcePageUrl: string,
  videoUrls: Set<string>,
  sessionId: string,
) {
  if (state.sessionId !== sessionId) return;
  if (!videoUrls.has(url)) {
    videoUrls.add(url);
    state.videos.push({ id: randomUUID(), url, sourcePageUrl, filename: videoFilename(url) });
    state.videosFound += 1;
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

/** Stream the first IMAGE_PROBE_MAX_BYTES of an image and return its pixel dimensions. */
async function probeImageDimensions(
  url: string,
  cookies: string,
): Promise<{ width: number; height: number } | null> {
  try {
    const response = await axios.get(url, {
      responseType: "stream",
      timeout: IMAGE_PROBE_TIMEOUT,
      maxRedirects: 3,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ImageScraper/1.0)",
        Range: `bytes=0-${IMAGE_PROBE_MAX_BYTES - 1}`,
        ...(cookies ? { Cookie: cookies } : {}),
      },
    });

    return await new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;

      const settle = () => {
        if (settled) return;
        settled = true;
        try {
          const buf = Buffer.concat(chunks);
          const dims = imageSize(buf);
          resolve(dims.width && dims.height ? { width: dims.width, height: dims.height } : null);
        } catch {
          resolve(null);
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response.data.on("data", (chunk: any) => {
        const buf = Buffer.from(chunk);
        chunks.push(buf);
        totalBytes += buf.length;
        if (totalBytes >= IMAGE_PROBE_MAX_BYTES) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (response.data as any).destroy();
          settle();
        }
      });
      response.data.on("end", settle);
      response.data.on("close", settle);
      response.data.on("error", () => { settled = true; resolve(null); });
    });
  } catch {
    return null;
  }
}

async function crawl(sessionId: string, maxPages: number, minDimension: number, cookies: string) {
  const visited = new Set<string>();
  const imageUrls = new Set<string>();
  const videoUrls = new Set<string>();
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

        // Candidates whose real dimensions need probing (no HTML width/height)
        type ProbePending = { url: string; alt: string | null };
        const probePending: ProbePending[] = [];

        const queueUnknown = (url: string, alt: string | null) => {
          if (!imageUrls.has(url)) probePending.push({ url, alt });
        };

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
              if (w && h) {
                addImage(normalized, pageUrl, imageUrls, sessionId, minDimension, alt, w, h);
              } else {
                queueUnknown(normalized, alt);
              }
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
                  queueUnknown(normalized, alt);
                }
              }
            }
          }
        });

        // ── Inline style background-image ───────────────────────────────────
        $("[style]").each((_i, el) => {
          const style = $(el).attr("style") || "";
          for (const url of extractCssImageUrls(style, pageUrl)) {
            queueUnknown(url, null);
          }
        });

        // ── <style> blocks ──────────────────────────────────────────────────
        $("style").each((_i, el) => {
          const css = $(el).text();
          for (const url of extractCssImageUrls(css, pageUrl)) {
            queueUnknown(url, null);
          }
        });

        // ── <video> tags and <a> links to video files ───────────────────────
        $("video[src], video source[src]").each((_i, el) => {
          const src = $(el).attr("src");
          if (src) {
            const normalized = normalizeImageUrl(src, pageUrl);
            if (normalized && isVideoUrl(normalized)) {
              addVideo(normalized, pageUrl, videoUrls, sessionId);
            }
          }
        });

        $("a[href]").each((_i, el) => {
          const href = $(el).attr("href");
          if (href) {
            try {
              const normalized = new URL(href, pageUrl).toString();
              if (isVideoUrl(normalized)) {
                addVideo(normalized, pageUrl, videoUrls, sessionId);
              }
            } catch { /* skip malformed */ }
          }
        });

        // ── Probe unknown-dimension candidates ──────────────────────────────
        // Process in batches to avoid flooding the target server
        for (let i = 0; i < probePending.length; i += IMAGE_PROBE_CONCURRENCY) {
          if (state.sessionId !== sessionId) break;
          const batch = probePending.slice(i, i + IMAGE_PROBE_CONCURRENCY);
          await Promise.all(
            batch.map(async ({ url, alt }) => {
              if (state.sessionId !== sessionId) return;
              if (minDimension > 0) {
                // Must verify actual size — probe the image header bytes
                const dims = await probeImageDimensions(url, cookies);
                if (dims) {
                  addImage(url, pageUrl, imageUrls, sessionId, minDimension, alt, dims.width, dims.height);
                }
                // dims === null → can't determine size → skip (conservative)
              } else {
                // No size filter — add without probing
                addImage(url, pageUrl, imageUrls, sessionId, 0, alt, null, null);
              }
            }),
          );
        }

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

// POST /api/scraper/verify-login — test whether provided cookies grant authenticated access
router.post("/scraper/verify-login", async (req: Request, res: Response) => {
  const body = req.body as { cookies?: string } | undefined;
  const cookies = typeof body?.cookies === "string" ? body.cookies.trim() : "";

  try {
    const response = await axios.get(TARGET_URL, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ImageScraper/1.0)",
        Accept: "text/html,application/xhtml+xml",
        ...(cookies ? { Cookie: cookies } : {}),
      },
      maxRedirects: 5,
    });

    const html = response.data as string;
    const $ = cheerio.load(html);

    // ── IPS4 login detection ─────────────────────────────────────────────────
    // IPS4 injects a logout link when authenticated
    const hasLogoutLink =
      $('a[href*="do=logout"]').length > 0 ||
      $('a[href*="&do=logout"]').length > 0;

    // IPS4 renders a login/register link for guests
    const hasLoginLink =
      $('a[href*="app=core&module=system&controller=login"]').length > 0 ||
      $('a[href*="controller=login"]').length > 0;

    // IPS4 embeds the member username in several places when logged in
    const username =
      $(".cUserLink").first().text().trim() ||
      $(".ipsUserPhoto[alt]").first().attr("alt")?.trim() ||
      $('[data-ipsMenu] .ipsUserPhoto').first().attr("alt")?.trim() ||
      null;

    // Cookie-level hint: IPS4 sets ips4_member_id for authenticated sessions
    const hasMemberIdCookie = /ips4_member_id\s*=\s*[^;]+/.test(cookies);
    const hasSessionCookie = /ips4_IPSSessionFront\s*=\s*[^;]+/.test(cookies);

    const loggedIn = hasLogoutLink || (hasMemberIdCookie && hasSessionCookie) || (!hasLoginLink && (hasMemberIdCookie || username !== null));

    let message: string;
    if (loggedIn) {
      message = `Authenticated${username ? ` as "${username}"` : ""}`;
    } else if (!hasSessionCookie && !hasMemberIdCookie) {
      message =
        "Session cookies not found in what you pasted. " +
        "Make sure to copy the Cookie value from the Network tab (not the browser console) — " +
        "the console omits HttpOnly cookies like ips4_IPSSessionFront that are required to log in.";
    } else {
      message =
        "The site returned a guest view. Your session may have expired — " +
        "try logging in again and copying fresh cookies from the Network tab.";
    }

    res.json({ loggedIn, username: username || null, message });
  } catch (err) {
    res.status(502).json({
      loggedIn: false,
      username: null,
      message: `Could not reach ${TARGET_URL}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

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
    videosFound: state.videosFound,
    currentUrl: state.currentUrl,
    errorMessage: state.errorMessage,
  });
});

// GET /api/scraper/images
router.get("/scraper/images", (_req: Request, res: Response) => {
  res.json(state.images);
});

// GET /api/scraper/videos
router.get("/scraper/videos", (_req: Request, res: Response) => {
  res.json(state.videos);
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
