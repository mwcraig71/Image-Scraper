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
const CONCURRENCY = 5;
const REQUEST_TIMEOUT = 20000;
const IMAGE_PROBE_CONCURRENCY = 8;
const IMAGE_PROBE_TIMEOUT = 10000;
const IMAGE_PROBE_MAX_BYTES = 65536; // 64 KB — enough for dimension headers of most formats
const FETCH_MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1200;
const MAX_EXTERNAL_CSS_PER_PAGE = 6;
const RENDER_TIMEOUT = 30000;
const RENDER_SETTLE_MS = 700;

// User-agent pool — rotate on 403/429. Realistic desktop browser strings only;
// a bot-looking UA is the single most common reason a site returns a stripped page.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

const BROWSER_HEADERS: Record<string, string> = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
};

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

// ── URL helpers ────────────────────────────────────────────────────────────

/** Registrable-domain-ish suffix match, so www.site.com, cdn.site.com and
 *  site.com are treated as the same site when subdomain crawling is enabled. */
function baseDomain(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}

function sameSite(a: string, b: string, includeSubdomains: boolean): boolean {
  try {
    const ha = new URL(a).hostname.toLowerCase();
    const hb = new URL(b).hostname.toLowerCase();
    if (ha === hb) return true;
    if (!includeSubdomains) {
      // Treat bare vs. www as equivalent even in strict mode
      return ha.replace(/^www\./, "") === hb.replace(/^www\./, "");
    }
    return baseDomain(ha) === baseDomain(hb);
  } catch {
    return false;
  }
}

function normalizeCrawlUrl(
  href: string,
  base: string,
  targetUrl: string,
  includeSubdomains: boolean,
): string | null {
  try {
    const url = new URL(href, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!sameSite(url.toString(), targetUrl, includeSubdomains)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function absoluteUrl(src: string, base: string): string | null {
  try {
    const url = new URL(src.trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|svg|bmp|avif|tiff?|jfif|heic|heif|ico)(\?|#|$)/i;

/** True when the URL path clearly ends in an image extension. */
function hasImageExtension(url: string): boolean {
  try {
    return IMAGE_EXT_RE.test(new URL(url).pathname);
  } catch {
    return IMAGE_EXT_RE.test(url);
  }
}

/** Heuristic that a URL is *likely* an image even without an extension —
 *  used to decide whether an extension-less candidate is worth probing. */
function looksLikeImage(url: string): boolean {
  const u = url.toLowerCase();
  if (hasImageExtension(url)) return true;
  if (/[?&](format|fm)=(jpe?g|png|webp|gif|avif)/.test(u)) return true;
  if (/\/(image|images|img|photo|photos|media|thumb|thumbs|resize|resized|cdn-cgi\/image|i)\//.test(u)) return true;
  if (/(cloudinary|imgix|imagekit|contentful|shopify|squarespace-cdn|wixstatic|fbcdn|cdninstagram|pinimg|redd\.it|imgur|gyazo|prnt\.sc)/.test(u)) return true;
  if (/[?&](w|width|h|height|q|quality|crop|fit)=/.test(u) && /(image|img|photo|media|upload)/.test(u)) return true;
  return false;
}

const VIDEO_EXT_RE = /\.(mp4|webm|mov|avi|mkv|m4v|ogv|wmv|flv|m2ts|mts|ts|mpg|mpeg|3gp)(\?|#|\/|$)/i;
const STREAM_EXT_RE = /\.(m3u8|mpd)(\?|#|$)/i; // HLS / DASH manifests
const ASSET_EXT_RE = /\.(pdf|zip|rar|7z|gz|tar|mp3|wav|flac|doc|docx|xls|xlsx|ppt|pptx|css|js|json|xml|rss|exe|dmg|apk|woff2?|ttf|eot)(\?|#|$)/i;

// Direct-download / file-host patterns (opaque IDs, no extension in path)
const VIDEO_HOST_PATTERNS: RegExp[] = [
  /\bdrive\.google\.com\/file\/d\/[^/?]+/,
  /\bdrive\.google\.com\/(open|uc)\?/,
  /\bdropbox\.com\/s\/[^?]+\.(mp4|mov|avi|mkv|webm|m4v)/i,
  /\bdropbox\.com\/scl\/fi\//i,
  /\bmega\.(?:nz|co\.nz|io)\/(file|#)/,
  /\bonedrive\.live\.com\//,
  /\b1drv\.ms\//,
  /\bmediafire\.com\/file\//i,
  /\bpixeldrain\.com\/[ul]\//i,
  /\bgofile\.io\/d\//i,
];

// Embedded-player hosts (iframe / watch links). Recorded as videos even though
// they are pages, not files — the user still wants the link.
const VIDEO_EMBED_PATTERNS: RegExp[] = [
  /\byoutube\.com\/(watch\?|embed\/|shorts\/|v\/)/i,
  /\byoutu\.be\//i,
  /\bplayer\.vimeo\.com\/video\//i,
  /\bvimeo\.com\/\d+/i,
  /\bdailymotion\.com\/(video|embed)\//i,
  /\bdai\.ly\//i,
  /\bstreamable\.com\//i,
  /\btwitch\.tv\/(videos\/|clips\.|\?)/i,
  /\bclips\.twitch\.tv\//i,
  /\bfacebook\.com\/(watch|.*\/videos\/)/i,
  /\bfb\.watch\//i,
  /\brumble\.com\/(embed\/|v[a-z0-9]+)/i,
  /\bodysee\.com\//i,
  /\bbitchute\.com\/(video|embed)\//i,
  /\bstreamja\.com\//i,
  /\bstreamff\.com\//i,
  /\bgfycat\.com\//i,
  /\bredgifs\.com\//i,
];

function isDirectVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (VIDEO_EXT_RE.test(u.pathname) || STREAM_EXT_RE.test(u.pathname)) return true;
    const decoded = decodeURIComponent(url);
    if (VIDEO_EXT_RE.test(decoded) || STREAM_EXT_RE.test(decoded)) return true;
    return VIDEO_HOST_PATTERNS.some((re) => re.test(url));
  } catch {
    return false;
  }
}

function isEmbedVideoUrl(url: string): boolean {
  return VIDEO_EMBED_PATTERNS.some((re) => re.test(url));
}

function isAnyVideoUrl(url: string): boolean {
  return isDirectVideoUrl(url) || isEmbedVideoUrl(url);
}

function videoFilename(url: string): string {
  try {
    const gd = url.match(/drive\.google\.com\/file\/d\/([^/?]+)/);
    if (gd) return `gdrive-${gd[1]}.mp4`;
    const yt = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/))([A-Za-z0-9_-]{6,})/);
    if (yt) return `youtube-${yt[1]}.url`;
    const vim = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (vim) return `vimeo-${vim[1]}.url`;
    const mega = url.match(/mega\.[^/]+\/(file|#)!?([A-Za-z0-9_-]+)/);
    if (mega) return `mega-${mega[2]}.mp4`;
    const seg = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
    if (seg) return seg;
    return new URL(url).hostname + ".url";
  } catch {
    return "video";
  }
}

// ── Collectors (per-crawl, closed over in crawl()) ─────────────────────────

interface Collectors {
  sessionId: string;
  minDimension: number;
  imagePathKeys: Set<string>; // dedup by origin+pathname (strips resize/cache params)
  videoUrls: Set<string>;
  axiosInstance: AxiosInstance;
}

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
  c: Collectors,
  url: string,
  sourcePageUrl: string,
  alt: string | null,
  width: number | null,
  height: number | null,
) {
  if (state.sessionId !== c.sessionId) return;
  if (url.startsWith("data:")) return;
  if (c.minDimension > 0 && width !== null && height !== null) {
    if (width < c.minDimension || height < c.minDimension) return;
  }
  const key = imagePathKey(url);
  if (c.imagePathKeys.has(key)) return;
  c.imagePathKeys.add(key);
  state.images.push({ id: randomUUID(), url, sourcePageUrl, alt, width, height });
  state.imagesFound += 1;
}

function addVideo(c: Collectors, url: string, sourcePageUrl: string) {
  if (state.sessionId !== c.sessionId) return;
  if (url.startsWith("blob:") || url.startsWith("data:")) return;
  if (c.videoUrls.has(url)) return;
  c.videoUrls.add(url);
  state.videos.push({ id: randomUUID(), url, sourcePageUrl, filename: videoFilename(url) });
  state.videosFound += 1;
}

// ── Fetch with retry + UA rotation ─────────────────────────────────────────

async function fetchPage(pageUrl: string, axiosInstance: AxiosInstance): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= FETCH_MAX_RETRIES; attempt++) {
    const ua = USER_AGENTS[attempt % USER_AGENTS.length];
    try {
      const resp = await axiosInstance.get<string>(pageUrl, {
        timeout: REQUEST_TIMEOUT,
        responseType: "text",
        headers: { ...BROWSER_HEADERS, "User-Agent": ua, Referer: new URL(pageUrl).origin + "/" },
        maxRedirects: 6,
        // Accept any status < 500 so we can still parse 403/404 bodies if they contain content
        validateStatus: (s) => s < 500,
      });
      return typeof resp.data === "string" ? resp.data : String(resp.data);
    } catch (err) {
      lastError = err;
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 429 && attempt < FETCH_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 2)));
        continue;
      }
      if (status === 403 && attempt < FETCH_MAX_RETRIES) continue;
      if (attempt < FETCH_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      break;
    }
  }
  throw lastError;
}

/** Stream the first bytes of an image and return its content-type + pixel size. */
async function probeImage(
  url: string,
  axiosInstance: AxiosInstance,
): Promise<{ contentType: string | null; width: number | null; height: number | null } | null> {
  try {
    const response = await axiosInstance.get(url, {
      responseType: "stream",
      timeout: IMAGE_PROBE_TIMEOUT,
      maxRedirects: 4,
      headers: {
        "User-Agent": USER_AGENTS[0],
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        Range: `bytes=0-${IMAGE_PROBE_MAX_BYTES - 1}`,
      },
      validateStatus: (s) => s < 400,
    });
    const contentType =
      ((response.headers["content-type"] as string | undefined) || "").split(";")[0].trim().toLowerCase() || null;

    return await new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        let width: number | null = null;
        let height: number | null = null;
        try {
          const dims = imageSize(Buffer.concat(chunks));
          if (dims.width && dims.height) {
            width = dims.width;
            height = dims.height;
          }
        } catch { /* not enough bytes / unknown format */ }
        resolve({ contentType, width, height });
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response.data.on("data", (chunk: any) => {
        const buf = Buffer.from(chunk);
        chunks.push(buf);
        total += buf.length;
        if (total >= IMAGE_PROBE_MAX_BYTES) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (response.data as any).destroy();
          settle();
        }
      });
      response.data.on("end", settle);
      response.data.on("close", settle);
      response.data.on("error", () => { if (!settled) { settled = true; resolve({ contentType, width: null, height: null }); } });
    });
  } catch {
    return null;
  }
}

function extractCssImageUrls(css: string, base: string): string[] {
  const out: string[] = [];
  const regex = /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi;
  const importRe = /@import\s+(?:url\()?\s*(['"])([^'"]+)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(css)) !== null) {
    const raw = m[2];
    if (!raw || raw.startsWith("data:")) continue;
    const abs = absoluteUrl(raw, base);
    if (abs) out.push(abs);
  }
  while ((m = importRe.exec(css)) !== null) {
    const abs = absoluteUrl(m[2], base);
    if (abs) out.push(abs);
  }
  return out;
}

/** Pick the largest entry in a srcset by width/density descriptor. */
function largestFromSrcset(srcset: string, base: string): string | null {
  let best: { url: string; score: number } | null = null;
  for (const part of srcset.split(",")) {
    const tokens = part.trim().split(/\s+/);
    const raw = tokens[0];
    if (!raw) continue;
    const abs = absoluteUrl(raw, base);
    if (!abs) continue;
    const descriptor = tokens[1] || "1x";
    let score = 1;
    const w = descriptor.match(/([\d.]+)w/);
    const x = descriptor.match(/([\d.]+)x/);
    if (w) score = parseFloat(w[1]);
    else if (x) score = parseFloat(x[1]) * 1000;
    if (!best || score > best.score) best = { url: abs, score };
  }
  return best ? best.url : null;
}

// Regexes that pull media URLs out of inline <script> / JSON blobs
const SCRIPT_MEDIA_RE =
  /["'](https?:\\?\/\\?\/[^"'\\]+?\.(?:mp4|webm|m3u8|mpd|mov|m4v|jpe?g|png|webp|gif|avif))(?:\?[^"'\\]*)?["']/gi;

interface PageMedia {
  imageCandidates: Map<string, { alt: string | null; width: number | null; height: number | null }>;
  crawlLinks: string[];
  externalCss: string[];
}

/** Parse one page's HTML and register every image/video candidate found. */
function extractFromHtml(
  c: Collectors,
  html: string,
  pageUrl: string,
  targetUrl: string,
  includeSubdomains: boolean,
): PageMedia {
  const $ = cheerio.load(html);
  const imageCandidates = new Map<string, { alt: string | null; width: number | null; height: number | null }>();
  const crawlLinks: string[] = [];
  const externalCss: string[] = [];

  const addCandidate = (raw: string | undefined | null, alt: string | null, w: number | null = null, h: number | null = null) => {
    if (!raw) return;
    const abs = absoluteUrl(raw, pageUrl);
    if (!abs) return;
    if (hasImageExtension(abs) || looksLikeImage(abs)) {
      const existing = imageCandidates.get(abs);
      if (!existing) imageCandidates.set(abs, { alt, width: w, height: h });
      else if (w && h && (!existing.width || !existing.height)) { existing.width = w; existing.height = h; }
    }
  };

  // ── <img> and all its lazy-load variants ──────────────────────────────────
  $("img").each((_i, el) => {
    const alt = $(el).attr("alt") || null;
    const w = parseInt($(el).attr("width") || "0") || null;
    const h = parseInt($(el).attr("height") || "0") || null;
    for (const attr of [
      "src", "data-src", "data-lazy-src", "data-original", "data-original-src",
      "data-url", "data-image", "data-img", "data-fallback-src", "data-hi-res-src",
      "data-echo", "data-flickity-lazyload", "data-defer-src",
    ]) {
      addCandidate($(el).attr(attr), alt, w, h);
    }
    for (const ssAttr of ["srcset", "data-srcset", "data-lazy-srcset"]) {
      const ss = $(el).attr(ssAttr);
      if (ss) addCandidate(largestFromSrcset(ss, pageUrl), alt, w, h);
    }
  });

  // ── <picture>/<source srcset>, <audio>/<video> posters handled below ──────
  $("picture source[srcset], source[srcset]").each((_i, el) => {
    const ss = $(el).attr("srcset");
    if (ss) addCandidate(largestFromSrcset(ss, pageUrl), null);
    addCandidate($(el).attr("src"), null);
  });

  // ── Elements carrying background/full-image hints ─────────────────────────
  $("[style], [data-bg], [data-background], [data-background-image], [data-image], [data-full], [data-zoom-image], [data-large], [data-large-file], [data-full-size], [data-src-full], [data-poster], [data-thumb], [data-lightbox], [data-featherlight], [data-fancybox-href]").each((_i, el) => {
    const style = $(el).attr("style");
    if (style) for (const u of extractCssImageUrls(style, pageUrl)) addCandidate(u, null);
    for (const attr of [
      "data-bg", "data-background", "data-background-image", "data-image", "data-full",
      "data-zoom-image", "data-large", "data-large-file", "data-full-size",
      "data-src-full", "data-poster", "data-thumb", "data-lightbox",
      "data-featherlight", "data-fancybox-href",
    ]) {
      addCandidate($(el).attr(attr), null);
    }
  });

  // ── <style> blocks ────────────────────────────────────────────────────────
  $("style").each((_i, el) => {
    for (const u of extractCssImageUrls($(el).text(), pageUrl)) addCandidate(u, null);
  });

  // ── External stylesheets (queued for fetch by caller) ─────────────────────
  $('link[rel~="stylesheet"][href], link[rel="preload"][as="style"][href]').each((_i, el) => {
    const abs = absoluteUrl($(el).attr("href") || "", pageUrl);
    if (abs && externalCss.length < MAX_EXTERNAL_CSS_PER_PAGE) externalCss.push(abs);
  });

  // ── <link rel="image_src"> / preload / apple-touch-icon ───────────────────
  $('link[rel="image_src"][href], link[rel="preload"][as="image"][href], link[rel~="apple-touch-icon"][href]').each((_i, el) => {
    addCandidate($(el).attr("href"), null);
  });
  $('link[rel="preload"][as="image"][imagesrcset]').each((_i, el) => {
    const ss = $(el).attr("imagesrcset");
    if (ss) addCandidate(largestFromSrcset(ss, pageUrl), null);
  });

  // ── Open Graph / Twitter / itemprop meta images and videos ────────────────
  for (const sel of [
    'meta[property="og:image"]', 'meta[property="og:image:secure_url"]', 'meta[property="og:image:url"]',
    'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]', 'meta[itemprop="image"]',
    'meta[name="thumbnail"]',
  ]) {
    addCandidate($(sel).attr("content"), "meta image");
  }
  for (const sel of [
    'meta[property="og:video"]', 'meta[property="og:video:url"]', 'meta[property="og:video:secure_url"]',
    'meta[name="twitter:player:stream"]', 'meta[name="twitter:player"]',
  ]) {
    const content = $(sel).attr("content");
    const abs = content ? absoluteUrl(content, pageUrl) : null;
    if (abs && isAnyVideoUrl(abs)) addVideo(c, abs, pageUrl);
  }

  // ── JSON-LD structured data ───────────────────────────────────────────────
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const walk = (obj: any) => {
        if (!obj || typeof obj !== "object") return;
        for (const key of ["image", "thumbnail", "thumbnailUrl", "contentUrl"]) {
          const val = obj[key];
          const take = (v: unknown) => {
            if (typeof v === "string") addCandidate(v, "json-ld");
            else if (v && typeof v === "object") {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const u = (v as any).url || (v as any).contentUrl;
              if (typeof u === "string") addCandidate(u, "json-ld");
            }
          };
          if (Array.isArray(val)) val.forEach(take);
          else take(val);
        }
        // og:video-style contentUrl on VideoObject
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (obj["@type"] === "VideoObject" && typeof obj.contentUrl === "string") {
          const abs = absoluteUrl(obj.contentUrl, pageUrl);
          if (abs && isAnyVideoUrl(abs)) addVideo(c, abs, pageUrl);
        }
        for (const v of Object.values(obj)) if (v && typeof v === "object") walk(v);
      };
      walk(JSON.parse($(el).text()));
    } catch { /* skip malformed */ }
  });

  // ── <noscript> fallbacks (lazy-load sites hide real <img> here) ───────────
  $("noscript").each((_i, el) => {
    try {
      const inner = cheerio.load($(el).text());
      inner("img").each((_j, im) => {
        addCandidate(inner(im).attr("src"), inner(im).attr("alt") || null);
        const ss = inner(im).attr("srcset");
        if (ss) addCandidate(largestFromSrcset(ss, pageUrl), null);
      });
    } catch { /* skip */ }
  });

  // ── <video> / <source> / <track> and posters ─────────────────────────────
  $("video, video source, audio source").each((_i, el) => {
    for (const attr of ["src", "data-src", "data-video-src"]) {
      const raw = $(el).attr(attr);
      const abs = raw ? absoluteUrl(raw, pageUrl) : null;
      if (abs && isAnyVideoUrl(abs)) addVideo(c, abs, pageUrl);
    }
    const poster = $(el).attr("poster");
    if (poster) addCandidate(poster, "video poster");
  });

  // ── <iframe> embeds (YouTube/Vimeo/etc.) ──────────────────────────────────
  $("iframe[src], iframe[data-src]").each((_i, el) => {
    const raw = $(el).attr("src") || $(el).attr("data-src");
    const abs = raw ? absoluteUrl(raw, pageUrl) : null;
    if (abs && isEmbedVideoUrl(abs)) addVideo(c, abs, pageUrl);
  });

  // ── <a href> — the big one: full-size images + video links behind thumbs ──
  $("a[href]").each((_i, el) => {
    const raw = $(el).attr("href");
    if (!raw) return;
    const abs = absoluteUrl(raw, pageUrl);
    if (!abs) return;

    if (isAnyVideoUrl(abs)) { addVideo(c, abs, pageUrl); return; }

    const containsImg = $(el).find("img").length > 0;
    if (hasImageExtension(abs)) {
      // Direct link to an image file — almost always the full-res original
      const alt = $(el).find("img").first().attr("alt") || null;
      addCandidate(abs, alt);
    } else if (containsImg && looksLikeImage(abs)) {
      // Thumbnail wrapped in a link to an extension-less full-size image
      addCandidate(abs, $(el).find("img").first().attr("alt") || null);
    }

    // Visible text that is itself a media URL (forum plain-text pastes)
    const text = $(el).text().trim();
    if (/^https?:\/\//.test(text)) {
      const t = absoluteUrl(text, pageUrl);
      if (t) {
        if (isAnyVideoUrl(t)) addVideo(c, t, pageUrl);
        else if (hasImageExtension(t)) addCandidate(t, null);
      }
    }

    // Same-site link → crawl candidate (skip direct media/asset files —
    // fetching a .jpg/.mp4/.pdf as an HTML page just wastes a request)
    if (!hasImageExtension(abs) && !isAnyVideoUrl(abs) && !ASSET_EXT_RE.test(abs)) {
      const crawl = normalizeCrawlUrl(raw, pageUrl, targetUrl, includeSubdomains);
      if (crawl) crawlLinks.push(crawl);
    }
  });

  // ── Inline <script> / JSON blobs — pull out embedded media URLs ───────────
  $("script:not([src])").each((_i, el) => {
    const js = $(el).text();
    if (!js || js.length > 500000) return; // skip giant bundles
    let m: RegExpExecArray | null;
    SCRIPT_MEDIA_RE.lastIndex = 0;
    while ((m = SCRIPT_MEDIA_RE.exec(js)) !== null) {
      const cleaned = m[1].replace(/\\\//g, "/");
      const abs = absoluteUrl(cleaned, pageUrl);
      if (!abs) continue;
      if (isAnyVideoUrl(abs)) addVideo(c, abs, pageUrl);
      else if (hasImageExtension(abs)) addCandidate(abs, null);
    }
  });

  // ── Raw body text — bare media URLs not wrapped in tags ───────────────────
  {
    const rawText = $("body").text();
    const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
    let m: RegExpExecArray | null;
    while ((m = urlPattern.exec(rawText)) !== null) {
      const candidate = m[0].replace(/[.,;:!?)>\]'"]+$/, "");
      if (!candidate.includes(".")) continue;
      if (isAnyVideoUrl(candidate)) {
        const abs = absoluteUrl(candidate, pageUrl);
        if (abs) addVideo(c, abs, pageUrl);
      } else if (hasImageExtension(candidate)) {
        const abs = absoluteUrl(candidate, pageUrl);
        if (abs) addCandidate(abs, null);
      }
    }
  }

  return { imageCandidates, crawlLinks, externalCss };
}

// ── Optional JavaScript rendering via Playwright ───────────────────────────
// Playwright is an OPTIONAL dependency. If it (or its browser) is not installed,
// the renderer returns null and the crawl silently falls back to static fetch.
// Enable with: pnpm --filter @workspace/api-server add playwright && npx playwright install chromium

interface BrowserRenderer {
  renderPage(url: string): Promise<{ html: string; mediaUrls: string[] } | null>;
  close(): Promise<void>;
}

function cookiesToPlaywright(cookieHeader: string, targetUrl: string): Array<{ name: string; value: string; domain: string; path: string }> {
  let host = "";
  try { host = new URL(targetUrl).hostname; } catch { return []; }
  const out: Array<{ name: string; value: string; domain: string; path: string }> = [];
  for (const pair of cookieHeader.split(";").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) out.push({ name, value, domain: host, path: "/" });
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function autoScroll(page: any): Promise<void> {
  // Passed as a string so the browser evaluates it — keeps TypeScript from
  // typechecking browser globals (document/window) in the Node context.
  const scrollScript = `new Promise((resolve) => {
    let total = 0; const step = 800;
    const timer = setInterval(() => {
      const el = document.scrollingElement || document.body;
      window.scrollBy(0, step); total += step;
      if (total >= el.scrollHeight - window.innerHeight - step || total > 40000) { clearInterval(timer); resolve(); }
    }, 250);
  })`;
  try { await page.evaluate(scrollScript); } catch { /* best-effort */ }
}

async function createBrowserRenderer(cookies: string, targetUrl: string): Promise<BrowserRenderer | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chromium: any;
  try {
    // @ts-ignore — optional peer dependency, may not be installed
    const pw = await import("playwright");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chromium = (pw as any).chromium;
    if (!chromium) throw new Error("playwright.chromium unavailable");
  } catch {
    console.warn("[SCRAPER] renderJs requested but Playwright is not installed — falling back to static fetch. Enable with: pnpm --filter @workspace/api-server add playwright && npx playwright install chromium");
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"] });
  } catch (e) {
    console.warn("[SCRAPER] Playwright chromium failed to launch — falling back to static fetch:", e instanceof Error ? e.message : String(e));
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const context: any = await browser.newContext({ userAgent: USER_AGENTS[0], ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, locale: "en-US" });
  if (cookies) { try { await context.addCookies(cookiesToPlaywright(cookies, targetUrl)); } catch { /* ignore bad cookies */ } }
  console.log("[SCRAPER] JS rendering ENABLED (Playwright chromium)");

  return {
    async renderPage(url: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page: any = await context.newPage();
      const mediaUrls = new Set<string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page.on("response", (resp: any) => {
        try {
          const ct = String(resp.headers()["content-type"] || "").toLowerCase();
          const u = resp.url();
          if (u.startsWith("http") && (ct.startsWith("image/") || ct.startsWith("video/") || /\.(m3u8|mpd)(\?|#|$)/i.test(u))) {
            mediaUrls.add(u);
          }
        } catch { /* ignore */ }
      });
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT });
        await autoScroll(page);
        await page.waitForTimeout(RENDER_SETTLE_MS);
        const html = await page.content();
        return { html, mediaUrls: [...mediaUrls] };
      } catch {
        try { const html = await page.content(); return { html, mediaUrls: [...mediaUrls] }; }
        catch { return null; }
      } finally {
        await page.close().catch(() => {});
      }
    },
    async close() { await browser.close().catch(() => {}); },
  };
}

async function crawl(
  sessionId: string,
  targetUrl: string,
  maxPages: number,
  minDimension: number,
  cookies: string,
  includeSubdomains: boolean,
  renderJs: boolean,
) {
  const jar = new CookieJar();
  if (cookies) {
    const origin = new URL(targetUrl).origin + "/";
    for (const pair of cookies.split(";").map((s) => s.trim()).filter(Boolean)) {
      try { jar.setCookieSync(pair, origin); } catch { /* skip malformed */ }
    }
  }
  const axiosInstance: AxiosInstance = axiosCookieJarSupport(axios.create({ jar }));

  const c: Collectors = {
    sessionId,
    minDimension,
    imagePathKeys: new Set<string>(),
    videoUrls: new Set<string>(),
    axiosInstance,
  };

  const visited = new Set<string>();
  const queued = new Set<string>([targetUrl]);
  const cssSeen = new Set<string>();
  const queue: string[] = [targetUrl];
  state.pagesQueued = 1;

  const renderer = renderJs ? await createBrowserRenderer(cookies, targetUrl) : null;

  try {
  while (
    queue.length > 0 &&
    (maxPages === 0 || state.pagesVisited < maxPages) &&
    state.status === "running" &&
    state.sessionId === sessionId
  ) {
    const batch = queue.splice(0, CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (pageUrl) => {
        if (visited.has(pageUrl)) return [] as string[];
        visited.add(pageUrl);
        if (state.sessionId !== sessionId) return [] as string[];
        state.currentUrl = pageUrl;

        let html: string;
        let capturedMedia: string[] = [];
        try {
          if (renderer) {
            const r = await renderer.renderPage(pageUrl);
            if (r) { html = r.html; capturedMedia = r.mediaUrls; }
            else { html = await fetchPage(pageUrl, axiosInstance); }
          } else {
            html = await fetchPage(pageUrl, axiosInstance);
          }
        } catch {
          return [] as string[];
        }
        if (state.sessionId !== sessionId) return [] as string[];
        state.pagesVisited += 1;

        const { imageCandidates, crawlLinks, externalCss } = extractFromHtml(
          c, html, pageUrl, targetUrl, includeSubdomains,
        );

        // Fold in media the browser actually loaded (lazy/JS-injected assets that
        // never appear in the static HTML). Videos are recorded directly; images
        // join the candidate set and go through the same content-type/size checks.
        for (const mu of capturedMedia) {
          if (isAnyVideoUrl(mu)) addVideo(c, mu, pageUrl);
          else if (!imageCandidates.has(mu)) imageCandidates.set(mu, { alt: "rendered", width: null, height: null });
        }

        // Fetch external stylesheets once each and mine them for backgrounds
        for (const cssUrl of externalCss) {
          if (cssSeen.has(cssUrl)) continue;
          cssSeen.add(cssUrl);
          try {
            const resp = await axiosInstance.get<string>(cssUrl, {
              timeout: IMAGE_PROBE_TIMEOUT,
              responseType: "text",
              headers: { "User-Agent": USER_AGENTS[0] },
              validateStatus: (s) => s < 400,
            });
            for (const u of extractCssImageUrls(String(resp.data), cssUrl)) {
              if (hasImageExtension(u) || looksLikeImage(u)) {
                if (!imageCandidates.has(u)) imageCandidates.set(u, { alt: null, width: null, height: null });
              }
            }
          } catch { /* skip */ }
        }

        // Resolve image candidates: add extension-backed ones directly (probing
        // only if a size filter needs dimensions); confirm extension-less ones
        // by content-type before adding.
        const entries = [...imageCandidates.entries()];
        for (let i = 0; i < entries.length; i += IMAGE_PROBE_CONCURRENCY) {
          if (state.sessionId !== sessionId) break;
          const slice = entries.slice(i, i + IMAGE_PROBE_CONCURRENCY);
          await Promise.all(slice.map(async ([url, meta]) => {
            if (state.sessionId !== sessionId) return;
            const known = hasImageExtension(url);
            const needDims = minDimension > 0 && (meta.width === null || meta.height === null);

            if (known && !needDims) {
              addImage(c, url, pageUrl, meta.alt, meta.width, meta.height);
              return;
            }
            const probe = await probeImage(url, axiosInstance);
            if (!probe) {
              // Couldn't fetch. If we already trust the extension and there's no
              // size filter, keep it rather than silently dropping.
              if (known && minDimension === 0) addImage(c, url, pageUrl, meta.alt, meta.width, meta.height);
              return;
            }
            const isImage = known || (probe.contentType?.startsWith("image/") ?? false);
            if (!isImage) return;
            const w = probe.width ?? meta.width;
            const h = probe.height ?? meta.height;
            if (minDimension > 0 && (w === null || h === null)) {
              // Size required but unknowable — keep only if extension-backed
              if (known) addImage(c, url, pageUrl, meta.alt, w, h);
              return;
            }
            addImage(c, url, pageUrl, meta.alt, w, h);
          }));
        }

        return crawlLinks;
      }),
    );

    if (state.sessionId !== sessionId) break;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        for (const link of result.value) {
          if (!visited.has(link) && !queued.has(link)) {
            queued.add(link);
            queue.push(link);
            state.pagesQueued += 1;
          }
        }
      }
    }
  }

  } finally {
    if (renderer) await renderer.close();
  }

  if (state.sessionId === sessionId && state.status === "running") {
    state.status = "done";
    state.currentUrl = null;
  }
}

// ── Login verification (unchanged behavior, kept generic) ──────────────────

function detectLoginSignals($: cheerio.CheerioAPI) {
  const hasLogout =
    $('a[href*="logout"], a[href*="signout"], a[href*="sign-out"], a[href*="do=logout"], button[name*="logout"], form[action*="logout"]').length > 0;
  const hasLogin =
    $('a[href*="login"], a[href*="signin"], a[href*="sign-in"], a[href*="controller=login"]').length > 0 ||
    $('input[type="password"]').length > 0 ||
    $('form[action*="login"], form[action*="signin"]').length > 0;
  const hasAccount =
    $('a[href*="account"], a[href*="profile"], a[href*="/user/"], a[href*="myaccount"]').length > 0;
  const username =
    $(".cUserLink").first().text().trim() ||
    $(".ipsUserPhoto[alt]").first().attr("alt")?.trim() ||
    $('[data-ipsMenu] .ipsUserPhoto').first().attr("alt")?.trim() ||
    $('[class*="username"], [class*="user-name"], [class*="userName"]').first().text().trim() ||
    null;
  return { hasLogout, hasLogin, hasAccount, username };
}

router.post("/scraper/verify-login", async (req: Request, res: Response) => {
  const body = req.body as { cookies?: string; targetUrl?: string } | undefined;
  const cookies = typeof body?.cookies === "string" ? body.cookies.trim() : "";
  const rawTarget = typeof body?.targetUrl === "string" ? body.targetUrl.trim() : "";

  if (!cookies) {
    res.json({ loggedIn: false, username: null, message: "No cookies provided. Paste the Cookie value from your browser's Network tab to test login." });
    return;
  }

  let verifyTarget: string;
  try {
    verifyTarget = rawTarget ? new URL(rawTarget).toString() : (state.targetUrl ?? "https://example.com/");
  } catch {
    res.status(400).json({ loggedIn: false, username: null, message: "Invalid target URL — enter a full URL including https:// before verifying." });
    return;
  }

  try {
    const baseHeaders = { ...BROWSER_HEADERS, "User-Agent": USER_AGENTS[0] };
    const [authedResp, guestResp] = await Promise.allSettled([
      axios.get<string>(verifyTarget, { timeout: REQUEST_TIMEOUT, headers: { ...baseHeaders, Cookie: cookies }, maxRedirects: 5 }),
      axios.get<string>(verifyTarget, { timeout: REQUEST_TIMEOUT, headers: baseHeaders, maxRedirects: 5 }),
    ]);
    if (authedResp.status === "rejected") throw authedResp.reason;

    const authed = detectLoginSignals(cheerio.load(authedResp.value.data));
    const guest = guestResp.status === "fulfilled" ? detectLoginSignals(cheerio.load(guestResp.value.data)) : null;
    const ips4Authed = /ips4_member_id\s*=\s*[^;]+/.test(cookies) && /ips4_IPSSessionFront\s*=\s*[^;]+/.test(cookies);

    let loggedIn = false;
    let inconclusive = false;
    if (authed.hasLogout) loggedIn = true;
    else if (guest) {
      const loginDisappeared = guest.hasLogin && !authed.hasLogin;
      const accountAppeared = !guest.hasAccount && authed.hasAccount;
      const usernameAppeared = !guest.username && authed.username !== null;
      loggedIn = loginDisappeared || accountAppeared || usernameAppeared || ips4Authed;
    } else if (ips4Authed) loggedIn = true;
    else inconclusive = true;

    let message: string;
    if (loggedIn) message = `Authenticated${authed.username ? ` as "${authed.username}"` : ""}. Cookies look valid.`;
    else if (inconclusive) message = "Couldn't confirm login state — the guest comparison request failed, so the result is inconclusive. The cookies may still work; try starting the scrape.";
    else message = "The site still returned a guest view with these cookies. Copy the full Cookie value from your browser's Network tab (not the console — it omits HttpOnly session cookies), and make sure your login session hasn't expired.";

    res.json({ loggedIn, username: authed.username || null, message });
  } catch (err) {
    res.status(502).json({ loggedIn: false, username: null, message: `Could not reach the target site: ${err instanceof Error ? err.message : String(err)}` });
  }
});

router.post("/scraper/start", (req: Request, res: Response) => {
  if (state.status === "running") {
    res.status(409).json({ error: "A scrape is already in progress" });
    return;
  }
  const body = req.body as {
    targetUrl?: string; maxPages?: number; minDimension?: number; cookies?: string; includeSubdomains?: boolean; renderJs?: boolean;
  } | undefined;

  const rawTarget = typeof body?.targetUrl === "string" ? body.targetUrl.trim() : "";
  let targetUrl: string;
  try {
    targetUrl = rawTarget ? new URL(rawTarget).toString() : "https://example.com/";
  } catch {
    res.status(400).json({ error: "Invalid targetUrl — must be a full URL including https://" });
    return;
  }
  const maxPages = typeof body?.maxPages === "number" && body.maxPages >= 0 ? body.maxPages : DEFAULT_MAX_PAGES;
  const minDimension = typeof body?.minDimension === "number" && body.minDimension >= 0 ? body.minDimension : 0;
  const cookies = typeof body?.cookies === "string" ? body.cookies.trim() : "";
  const includeSubdomains = body?.includeSubdomains === true;
  const renderJs = body?.renderJs === true;

  const sessionId = resetState();
  state.status = "running";
  state.targetUrl = targetUrl;

  crawl(sessionId, targetUrl, maxPages, minDimension, cookies, includeSubdomains, renderJs).catch((err: unknown) => {
    if (state.sessionId === sessionId) {
      state.status = "error";
      state.errorMessage = err instanceof Error ? err.message : String(err);
      state.currentUrl = null;
    }
  });

  res.json({ sessionId: state.sessionId, status: state.status, message: "Scrape started" });
});

router.get("/scraper/status", (_req: Request, res: Response) => {
  res.json({
    sessionId: state.sessionId, status: state.status, targetUrl: state.targetUrl,
    pagesVisited: state.pagesVisited, pagesQueued: state.pagesQueued,
    imagesFound: state.imagesFound, videosFound: state.videosFound,
    currentUrl: state.currentUrl, errorMessage: state.errorMessage,
  });
});

router.get("/scraper/images", (_req: Request, res: Response) => { res.json(state.images); });
router.get("/scraper/videos", (_req: Request, res: Response) => { res.json(state.videos); });

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
  const sessionId = resetState();
  res.json({ sessionId, status: state.status, message: "Reset successful" });
});

function extFromContentType(ct: string | undefined, fallbackUrl: string): string {
  const type = (ct || "").split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif",
    "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg", "image/bmp": "bmp",
    "image/tiff": "tiff", "image/x-icon": "ico", "video/mp4": "mp4", "video/webm": "webm",
    "video/quicktime": "mov",
  };
  if (map[type]) return map[type];
  const m = fallbackUrl.split("?")[0].match(/\.([a-z0-9]{2,5})$/i);
  return m ? m[1].toLowerCase() : "jpg";
}

router.get("/scraper/videos/:id/download", async (req: Request, res: Response) => {
  const { id } = req.params;
  const video = state.videos.find((v) => v.id === id);
  if (!video) { res.status(404).json({ error: "Video not found" }); return; }

  // Embedded players (YouTube/Vimeo/etc.) are pages, not files — send the user there.
  if (isEmbedVideoUrl(video.url) && !isDirectVideoUrl(video.url)) {
    res.redirect(video.url);
    return;
  }
  try {
    const upstream = await axios.get(video.url, {
      responseType: "stream", timeout: REQUEST_TIMEOUT, maxRedirects: 5,
      headers: { "User-Agent": USER_AGENTS[0], Accept: "video/*,*/*", Referer: new URL(video.sourcePageUrl).origin + "/" },
    });
    const contentType = (upstream.headers["content-type"] as string | undefined) || "application/octet-stream";
    const safeName = video.filename.replace(/[^\w.\-]+/g, "_") || `video-${id.slice(0, 8)}.mp4`;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Cache-Control", "no-cache");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    (upstream.data as NodeJS.ReadableStream).pipe(res);
  } catch {
    if (!res.headersSent) res.status(502).json({ error: "Failed to fetch video from origin" });
  }
});

router.get("/scraper/download-videos-zip", async (req: Request, res: Response) => {
  const idsParam = req.query.ids as string | undefined;
  const idSet = idsParam ? new Set(idsParam.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const videos = idSet ? state.videos.filter((v) => idSet.has(v.id)) : [...state.videos];
  if (videos.length === 0) { res.status(400).json({ error: "No videos to download" }); return; }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="scraped-videos.zip"');
  const archive = archiver("zip", { zlib: { level: 0 } }); // video files are already compressed
  archive.pipe(res);
  archive.on("error", (err: archiver.ArchiverError) => { console.error("Archive error:", err); });

  const used = new Set<string>();
  const uniqueName = (name: string): string => {
    let n = name;
    while (used.has(n)) {
      const dot = n.lastIndexOf(".");
      const rand = Math.random().toString(36).slice(2, 6);
      n = dot > 0 ? `${n.slice(0, dot)}-${rand}${n.slice(dot)}` : `${n}-${rand}`;
    }
    used.add(n);
    return n;
  };

  // Embedded-player links can't be downloaded as files — save each as a .url.txt
  // so a mixed selection still yields something useful for every item.
  const embeds = videos.filter((v) => isEmbedVideoUrl(v.url) && !isDirectVideoUrl(v.url));
  for (const v of embeds) {
    const base = (v.filename.replace(/\.[^.]*$/, "") || "video").replace(/[^\w.\-]+/g, "_");
    archive.append(`${v.url}\n`, { name: uniqueName(`${base}.url.txt`) });
  }

  const files = videos.filter((v) => !(isEmbedVideoUrl(v.url) && !isDirectVideoUrl(v.url)));
  const BATCH = 3;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async (v) => {
      try {
        const response = await axios.get(v.url, {
          responseType: "stream", timeout: REQUEST_TIMEOUT, maxRedirects: 5,
          headers: { "User-Agent": USER_AGENTS[0], Referer: new URL(v.sourcePageUrl).origin + "/" },
        });
        const safeName = v.filename.replace(/[^\w.\-]+/g, "_") || "video.mp4";
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        archive.append(response.data as import("stream").Readable, { name: uniqueName(safeName) });
      } catch { /* skip failed downloads */ }
    }));
  }
  await archive.finalize();
});

router.get("/scraper/images/:id/download", async (req: Request, res: Response) => {
  const { id } = req.params;
  const image = state.images.find((img) => img.id === id);
  if (!image) { res.status(404).json({ error: "Image not found" }); return; }
  try {
    const upstream = await axios.get(image.url, {
      responseType: "stream", timeout: REQUEST_TIMEOUT,
      headers: { "User-Agent": USER_AGENTS[0], Accept: "image/*,*/*", Referer: new URL(image.sourcePageUrl).origin + "/" },
      maxRedirects: 5,
    });
    const contentType = (upstream.headers["content-type"] as string | undefined) || "application/octet-stream";
    const ext = extFromContentType(contentType, image.url);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="image-${id.slice(0, 8)}.${ext}"`);
    res.setHeader("Cache-Control", "no-cache");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    (upstream.data as NodeJS.ReadableStream).pipe(res);
  } catch {
    if (!res.headersSent) res.status(502).json({ error: "Failed to fetch image from origin" });
  }
});

router.get("/scraper/download-zip", async (req: Request, res: Response) => {
  const idsParam = req.query.ids as string | undefined;
  const idSet = idsParam ? new Set(idsParam.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const images = idSet ? state.images.filter((img) => idSet.has(img.id)) : [...state.images];
  if (images.length === 0) { res.status(400).json({ error: "No images to download" }); return; }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="scraped-images.zip"');
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.pipe(res);
  archive.on("error", (err: archiver.ArchiverError) => { console.error("Archive error:", err); });

  const used = new Set<string>();
  const BATCH = 6;
  for (let i = 0; i < images.length; i += BATCH) {
    const batch = images.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async (img) => {
      try {
        const response = await axios.get(img.url, {
          responseType: "stream", timeout: REQUEST_TIMEOUT,
          headers: { "User-Agent": USER_AGENTS[0], Referer: new URL(img.sourcePageUrl).origin + "/" },
          maxRedirects: 5,
        });
        const ext = extFromContentType(response.headers["content-type"] as string | undefined, img.url);
        let name = `${img.id.slice(0, 8)}.${ext}`;
        while (used.has(name)) name = `${img.id.slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
        used.add(name);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        archive.append(response.data as import("stream").Readable, { name });
      } catch { /* skip failed downloads */ }
    }));
  }
  await archive.finalize();
});

export default router;

