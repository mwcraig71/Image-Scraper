import { Router, type IRouter, type Request, type Response } from "express";
import axios, { type AxiosInstance } from "axios";
import { wrapper as axiosCookieJarSupport } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";
import archiver from "archiver";
import { randomUUID } from "crypto";
import { imageSize } from "image-size";

const router: IRouter = Router();

const DEFAULT_MAX_PAGES = 500;
const CONCURRENCY = 3;
const REQUEST_TIMEOUT = 15000;
const IMAGE_PROBE_CONCURRENCY = 5;
const IMAGE_PROBE_TIMEOUT = 8000;
const IMAGE_PROBE_MAX_BYTES = 8192;
const FETCH_MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

// User-agent pool — rotate on 403
const USER_AGENTS = [
  "Mozilla/5.0 (compatible; ImageScraper/1.0)",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
];

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
  targetUrl: string | null;
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
  targetUrl: null,
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
  state.targetUrl = null;
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

function normalizeUrl(href: string, base: string, targetUrl: string): string | null {
  try {
    const url = new URL(href, base);
    const target = new URL(targetUrl);
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

const VIDEO_EXT_RE = /\.(mp4|webm|mov|avi|mkv|m4v|ogv|wmv|flv|m2ts|ts)(\?|\/|$)/i;

// Hosting services that use opaque IDs — no file extension appears in the URL.
const VIDEO_HOST_PATTERNS: RegExp[] = [
  /\bdrive\.google\.com\/file\/d\/[^/?]+/,          // Google Drive file viewer
  /\bdrive\.google\.com\/(open|uc)\?/,              // Google Drive open / direct download
  /\bdropbox\.com\/s\/[^?]+\.(mp4|mov|avi|mkv|webm|m4v)/i, // Dropbox video share
  /\bmega\.(?:nz|co\.nz|io)\/(file|#)/,             // Mega.nz file link
  /\bone\.drive\.live\.com\//,                       // OneDrive
  /\bonedrive\.live\.com\//,                         // OneDrive (alt domain)
];

function isVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // 1. Extension in pathname — direct URLs and file-host paths like .mp4/file
    if (VIDEO_EXT_RE.test(u.pathname.toLowerCase())) return true;
    // 2. Full decoded URL — catches redirect wrappers where the video URL is a query param
    const decoded = decodeURIComponent(url).toLowerCase();
    if (VIDEO_EXT_RE.test(decoded)) return true;
    // 3. Known video-hosting domains that use opaque IDs (no extension in URL)
    return VIDEO_HOST_PATTERNS.some((re) => re.test(url));
  } catch {
    return false;
  }
}

function videoFilename(url: string): string {
  try {
    // Google Drive: /file/d/{ID}/view → gdrive-{ID}.mp4
    const gd = url.match(/drive\.google\.com\/file\/d\/([^/?]+)/);
    if (gd) return `gdrive-${gd[1]}.mp4`;
    // Mega.nz: use the hash fragment ID
    const mega = url.match(/mega\.[^/]+\/(file|#)!?([A-Za-z0-9_-]+)/);
    if (mega) return `mega-${mega[2]}.mp4`;
    // OneDrive: use last path segment
    const od = url.match(/one?drive\.live\.com\/.*\/([^/?]+)/i);
    if (od) return `onedrive-${od[1]}.mp4`;
    // Default: last path segment, decoded
    return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || url);
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
    console.log(`[SCRAPER] VIDEO FOUND: ${url} | source: ${sourcePageUrl}`);
  }
}

/** Fetch a page with automatic retry + UA rotation on 403/429/5xx.
 *  Pass a cookie-jar-wrapped AxiosInstance so Set-Cookie headers are absorbed
 *  automatically across all pages in the same crawl session. */
async function fetchPageWithFallback(
  pageUrl: string,
  axiosInstance: AxiosInstance,
): Promise<{ data: string; finalUrl: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= FETCH_MAX_RETRIES; attempt++) {
    const ua = USER_AGENTS[attempt % USER_AGENTS.length];
    try {
      const resp = await axiosInstance.get<string>(pageUrl, {
        timeout: REQUEST_TIMEOUT,
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: new URL(pageUrl).origin + "/",
        },
        maxRedirects: 5,
      });
      return { data: resp.data, finalUrl: pageUrl };
    } catch (err) {
      lastError = err;
      const status = (err as { response?: { status?: number } }).response?.status;
      // 429 Too Many Requests — wait before next attempt
      if (status === 429 && attempt < FETCH_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 2)));
        continue;
      }
      // 403 — rotate UA on next attempt
      if (status === 403 && attempt < FETCH_MAX_RETRIES) continue;
      // 5xx — brief delay then retry
      if (status && status >= 500 && attempt < FETCH_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      // Network error — retry once
      if (!status && attempt < FETCH_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      break;
    }
  }
  throw lastError;
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

/** Compute a canonical dedup key: origin + pathname, no query string or fragment.
 *  This collapses the same image served with different resize/cache/auth params
 *  (e.g. photo.jpg?w=300, photo.jpg?_key=abc, photo.jpg) into one entry. */
function imagePathKey(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

function addImage(
  url: string,
  sourcePageUrl: string,
  imageUrls: Set<string>,
  imagePathKeys: Set<string>,
  sessionId: string,
  minDimension: number,
  alt: string | null = null,
  width: number | null = null,
  height: number | null = null,
) {
  // Guard: only write if this crawl's session is still the active one
  if (state.sessionId !== sessionId) return;
  // Skip inline data URIs (e.g. SVG avatars encoded as data:image/svg+xml,…)
  if (url.startsWith("data:")) return;
  // Skip images whose known dimensions fall below the threshold
  if (minDimension > 0 && width !== null && height !== null) {
    if (width < minDimension || height < minDimension) return;
  }
  // Deduplicate on canonical path (no query/fragment) so the same image
  // served with different resize/cache/auth params is only stored once.
  const key = imagePathKey(url);
  if (!imagePathKeys.has(key)) {
    imagePathKeys.add(key);
    imageUrls.add(url);
    state.images.push({ id: randomUUID(), url, sourcePageUrl, alt, width, height });
    state.imagesFound += 1;
  }
}

/** Stream the first IMAGE_PROBE_MAX_BYTES of an image and return its pixel dimensions. */
async function probeImageDimensions(
  url: string,
  axiosInstance: AxiosInstance,
): Promise<{ width: number; height: number } | null> {
  try {
    const response = await axiosInstance.get(url, {
      responseType: "stream",
      timeout: IMAGE_PROBE_TIMEOUT,
      maxRedirects: 3,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ImageScraper/1.0)",
        Range: `bytes=0-${IMAGE_PROBE_MAX_BYTES - 1}`,
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

async function crawl(sessionId: string, targetUrl: string, maxPages: number, minDimension: number, cookies: string) {
  // ── Cookie jar — absorbs Set-Cookie headers so the session stays alive ──
  const jar = new CookieJar();
  if (cookies) {
    // Seed the jar with the user-provided Cookie header (name=value pairs)
    const origin = new URL(targetUrl).origin + "/";
    for (const pair of cookies.split(";").map((s) => s.trim()).filter(Boolean)) {
      try { jar.setCookieSync(pair, origin); } catch { /* skip malformed */ }
    }
  }
  // Wrap a fresh axios instance so every request/response goes through the jar
  const axiosInstance: AxiosInstance = axiosCookieJarSupport(axios.create({ jar }));

  const visited = new Set<string>();
  const imageUrls = new Set<string>();
  const imagePathKeys = new Set<string>(); // origin+pathname dedup (strips query/fragment)
  const videoUrls = new Set<string>();
  const queue: string[] = [targetUrl];

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

        // Log cookie count for this domain before fetching
        const jarCookies = jar.getCookiesSync(pageUrl);
        console.log(`[SCRAPER] Fetching (${state.pagesVisited + 1}) | cookies in jar: ${jarCookies.length} | ${pageUrl}`);

        const { data: html } = await fetchPageWithFallback(pageUrl, axiosInstance);

        // Re-check after async fetch
        if (state.sessionId !== sessionId) return [];

        state.pagesVisited += 1;
        const $ = cheerio.load(html);

        // Auth diagnostic: check whether the page looks like a logged-in or guest response
        const htmlLower = html.toLowerCase();
        const looksAuthed =
          !htmlLower.includes('data-action="sign_in"') &&
          !htmlLower.includes('href="#elSignIn"') &&
          (htmlLower.includes('data-ipsquicksearch') || htmlLower.includes('ips4_member_id') ||
           jarCookies.some(c => c.key === 'ips4_member_id' || c.key === 'ips4_IPSSessionFront'));
        console.log(`[SCRAPER] Auth signal: ${looksAuthed ? "MEMBER ✓" : "GUEST ✗"} | jar: ${jarCookies.map(c => c.key).join(", ") || "(empty)"}`);

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
                addImage(normalized, pageUrl, imageUrls, imagePathKeys, sessionId, minDimension, alt, w, h);
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

        // ── <img> extra lazy-load data-* attributes ─────────────────────────
        $("img, [data-bg], [data-background], [data-image], [data-full], [data-zoom-image], [data-large], [data-full-size], [data-src-full], [data-poster]").each((_i, el) => {
          const extras = [
            $(el).attr("data-bg"),
            $(el).attr("data-background"),
            $(el).attr("data-image"),
            $(el).attr("data-full"),
            $(el).attr("data-zoom-image"),
            $(el).attr("data-large"),
            $(el).attr("data-full-size"),
            $(el).attr("data-src-full"),
            $(el).attr("data-poster"),
          ].filter(Boolean) as string[];
          for (const src of extras) {
            const normalized = normalizeImageUrl(src, pageUrl);
            if (normalized && isImageUrl(normalized)) queueUnknown(normalized, null);
          }
        });

        // ── <picture> / <source srcset> ──────────────────────────────────────
        $("picture source[srcset], source[srcset]").each((_i, el) => {
          const srcset = $(el).attr("srcset") || "";
          for (const part of srcset.split(",")) {
            const src = part.trim().split(/\s+/)[0];
            if (src) {
              const normalized = normalizeImageUrl(src, pageUrl);
              if (normalized && isImageUrl(normalized)) queueUnknown(normalized, null);
            }
          }
        });

        // ── Open Graph / Twitter Card meta images ────────────────────────────
        const metaSelectors = [
          'meta[property="og:image"]',
          'meta[property="og:image:secure_url"]',
          'meta[name="twitter:image"]',
          'meta[name="twitter:image:src"]',
        ];
        for (const sel of metaSelectors) {
          const content = $(sel).attr("content");
          if (content) {
            const normalized = normalizeImageUrl(content, pageUrl);
            if (normalized && isImageUrl(normalized)) queueUnknown(normalized, "og/meta image");
          }
        }

        // ── JSON-LD structured data ──────────────────────────────────────────
        $('script[type="application/ld+json"]').each((_i, el) => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const extractImages = (obj: any) => {
              if (!obj || typeof obj !== "object") return;
              for (const key of ["image", "thumbnail", "thumbnailUrl", "contentUrl"]) {
                const val = obj[key];
                if (typeof val === "string") {
                  const n = normalizeImageUrl(val, pageUrl);
                  if (n && isImageUrl(n)) queueUnknown(n, "json-ld");
                } else if (Array.isArray(val)) {
                  for (const item of val) {
                    if (typeof item === "string") {
                      const n = normalizeImageUrl(item, pageUrl);
                      if (n && isImageUrl(n)) queueUnknown(n, "json-ld");
                    } else if (item && typeof item === "object") {
                      const u = item.url || item.contentUrl;
                      if (typeof u === "string") {
                        const n = normalizeImageUrl(u, pageUrl);
                        if (n && isImageUrl(n)) queueUnknown(n, "json-ld");
                      }
                    }
                  }
                } else if (val && typeof val === "object") {
                  const u = val.url || val.contentUrl;
                  if (typeof u === "string") {
                    const n = normalizeImageUrl(u, pageUrl);
                    if (n && isImageUrl(n)) queueUnknown(n, "json-ld");
                  }
                }
              }
              // Recurse into nested objects / arrays
              for (const v of Object.values(obj)) {
                if (v && typeof v === "object") extractImages(v);
              }
            };
            extractImages(JSON.parse($(el).text()));
          } catch { /* malformed JSON — skip */ }
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

          // Also scan visible link text — catches cases where the href is a
          // redirect/tracker but the link text shows the real video URL.
          const text = $(el).text().trim();
          if (text.startsWith("http")) {
            try {
              const textUrl = new URL(text).toString();
              if (isVideoUrl(textUrl)) {
                addVideo(textUrl, pageUrl, videoUrls, sessionId);
              }
            } catch { /* not a valid URL */ }
          }
        });

        // Also scan raw page text for bare video URLs not wrapped in <a> tags.
        // Covers plain-text pastes inside spoiler/hidden-content boxes on forums.
        {
          const rawText = $("body").text();
          const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
          let m: RegExpExecArray | null;
          while ((m = urlPattern.exec(rawText)) !== null) {
            const candidate = m[0].replace(/[.,;:!?)>\]'"]+$/, ""); // strip trailing punctuation
            if (!candidate.includes(".") ) continue;
            if (isVideoUrl(candidate)) {
              try {
                addVideo(new URL(candidate).toString(), pageUrl, videoUrls, sessionId);
              } catch { /* skip */ }
            }
          }
        }

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
                const dims = await probeImageDimensions(url, axiosInstance);
                if (dims) {
                  addImage(url, pageUrl, imageUrls, imagePathKeys, sessionId, minDimension, alt, dims.width, dims.height);
                }
                // dims === null → can't determine size → skip (conservative)
              } else {
                // No size filter — add without probing
                addImage(url, pageUrl, imageUrls, imagePathKeys, sessionId, 0, alt, null, null);
              }
            }),
          );
        }

        // ── Internal links for further crawling ─────────────────────────────
        const newLinks: string[] = [];
        $("a[href]").each((_i, el) => {
          const href = $(el).attr("href");
          if (href) {
            const normalized = normalizeUrl(href, pageUrl, targetUrl);
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

/** Generic login-state signals from a parsed page. */
function detectLoginSignals($: cheerio.CheerioAPI) {
  // Logout / sign-out indicators — strong signal of being authenticated.
  // Scoped to actual links/buttons (not body text) to avoid false positives
  // from help/FAQ content that merely mentions "log out".
  const hasLogout =
    $('a[href*="logout"], a[href*="signout"], a[href*="sign-out"], a[href*="do=logout"], button[name*="logout"], form[action*="logout"]').length > 0;

  // Login / sign-in indicators — present for guests
  const hasLogin =
    $('a[href*="login"], a[href*="signin"], a[href*="sign-in"], a[href*="controller=login"]').length > 0 ||
    $('input[type="password"]').length > 0 ||
    $('form[action*="login"], form[action*="signin"]').length > 0;

  // Account / profile indicators — common when authenticated
  const hasAccount =
    $('a[href*="account"], a[href*="profile"], a[href*="/user/"], a[href*="myaccount"]').length > 0;

  // Username extraction — IPS4 selectors first, then generic
  const username =
    $(".cUserLink").first().text().trim() ||
    $(".ipsUserPhoto[alt]").first().attr("alt")?.trim() ||
    $('[data-ipsMenu] .ipsUserPhoto').first().attr("alt")?.trim() ||
    $('[class*="username"], [class*="user-name"], [class*="userName"]').first().text().trim() ||
    null;

  return { hasLogout, hasLogin, hasAccount, username };
}

// POST /api/scraper/verify-login — test whether provided cookies grant authenticated access
router.post("/scraper/verify-login", async (req: Request, res: Response) => {
  const body = req.body as { cookies?: string; targetUrl?: string } | undefined;
  const cookies = typeof body?.cookies === "string" ? body.cookies.trim() : "";
  const rawTarget = typeof body?.targetUrl === "string" ? body.targetUrl.trim() : "";

  if (!cookies) {
    res.json({
      loggedIn: false,
      username: null,
      message: "No cookies provided. Paste the Cookie value from your browser's Network tab to test login.",
    });
    return;
  }

  // Prefer the URL the user is about to scrape (sent in the request); fall back to
  // the active scrape target, then a last-resort default.
  let verifyTarget: string;
  try {
    verifyTarget = rawTarget
      ? new URL(rawTarget).toString()
      : (state.targetUrl ?? "https://www.thecandidplanet.com/");
  } catch {
    res.status(400).json({
      loggedIn: false,
      username: null,
      message: "Invalid target URL — enter a full URL including https:// before verifying.",
    });
    return;
  }

  try {

    // Fetch both the guest view (no cookies) and the authenticated view (with cookies)
    // so we can detect login state generically — by how the page DIFFERS — rather than
    // relying on any single site's cookie names.
    const baseHeaders = {
      "User-Agent": USER_AGENTS[1],
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    };

    const [authedResp, guestResp] = await Promise.allSettled([
      axios.get<string>(verifyTarget, {
        timeout: REQUEST_TIMEOUT,
        headers: { ...baseHeaders, Cookie: cookies },
        maxRedirects: 5,
      }),
      axios.get<string>(verifyTarget, {
        timeout: REQUEST_TIMEOUT,
        headers: baseHeaders,
        maxRedirects: 5,
      }),
    ]);

    if (authedResp.status === "rejected") {
      throw authedResp.reason;
    }

    const authed = detectLoginSignals(cheerio.load(authedResp.value.data));
    const guest =
      guestResp.status === "fulfilled"
        ? detectLoginSignals(cheerio.load(guestResp.value.data))
        : null;

    // IPS4 bonus signal (kept as an extra positive hint, not a requirement)
    const ips4Authed = /ips4_member_id\s*=\s*[^;]+/.test(cookies) && /ips4_IPSSessionFront\s*=\s*[^;]+/.test(cookies);

    let loggedIn = false;
    let inconclusive = false;
    if (authed.hasLogout) {
      // Logout affordance present in authed view → almost certainly logged in
      loggedIn = true;
    } else if (guest) {
      // Compare against guest view: login affordance disappeared, or account/username appeared
      const loginDisappeared = guest.hasLogin && !authed.hasLogin;
      const accountAppeared = !guest.hasAccount && authed.hasAccount;
      const usernameAppeared = !guest.username && authed.username !== null;
      loggedIn = loginDisappeared || accountAppeared || usernameAppeared || ips4Authed;
    } else if (ips4Authed) {
      // Guest fetch failed but the platform's authenticated cookie pair is present
      loggedIn = true;
    } else {
      // Guest fetch failed and no strong signal — can't compare, so report inconclusive
      inconclusive = true;
    }

    let message: string;
    if (loggedIn) {
      message = `Authenticated${authed.username ? ` as "${authed.username}"` : ""}. Cookies look valid.`;
    } else if (inconclusive) {
      message =
        "Couldn't confirm login state — the guest comparison request failed, so the result is inconclusive. " +
        "The cookies may still work; try starting the scrape, or re-test in a moment.";
    } else {
      message =
        "The site still returned a guest view with these cookies. " +
        "Copy the full Cookie value from your browser's Network tab (not the console — it omits HttpOnly session cookies), " +
        "and make sure your login session hasn't expired.";
    }

    res.json({ loggedIn, username: authed.username || null, message });
  } catch (err) {
    res.status(502).json({
      loggedIn: false,
      username: null,
      message: `Could not reach the target site: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

// POST /api/scraper/start
router.post("/scraper/start", (req: Request, res: Response) => {
  if (state.status === "running") {
    res.status(409).json({ error: "A scrape is already in progress" });
    return;
  }

  const body = req.body as { targetUrl?: string; maxPages?: number; minDimension?: number; cookies?: string } | undefined;
  const rawTarget = typeof body?.targetUrl === "string" ? body.targetUrl.trim() : "";
  let targetUrl: string;
  try {
    // Ensure it's a valid absolute URL; default to a safe fallback only if blank
    targetUrl = rawTarget ? new URL(rawTarget).toString() : "https://example.com/";
  } catch {
    res.status(400).json({ error: "Invalid targetUrl — must be a full URL including https://" });
    return;
  }
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
  state.targetUrl = targetUrl;

  crawl(sessionId, targetUrl, maxPages, minDimension, cookies).catch((err: unknown) => {
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
    targetUrl: state.targetUrl,
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
router.post("/scraper/stop", (_req: Request, res: Response) => {
  if (state.status !== "running") {
    res.status(409).json({ error: "No scrape is currently running" });
    return;
  }
  state.status = "done";
  state.currentUrl = null;
  res.json({ sessionId: state.sessionId, status: state.status, message: "Scrape stopped" });
});

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
