import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { 
  useStartScrape, 
  useGetScrapeStatus, 
  useGetScrapeImages,
  useGetScrapeVideos,
  useResetScrape,
  useStopScrape,
  useVerifyLogin,
  getGetScrapeStatusQueryKey, 
  getGetScrapeImagesQueryKey,
  getGetScrapeVideosQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Play, Square as StopIcon, RotateCcw, Download, Image as ImageIcon, Link as LinkIcon, AlertCircle, Activity, Box, DownloadCloud, CheckSquare, Square, SlidersHorizontal, KeyRound, ChevronDown, ChevronUp, ShieldCheck, XCircle, Loader2, Copy, Check, Film, ExternalLink, Bookmark, Maximize2, X, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function Dashboard() {
  const queryClient = useQueryClient();

  // ── filter & selection state ─────────────────────────────────────────────
  const [minSize, setMinSize] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [maxPages, setMaxPages] = useState(500);
  const [minScrapeSize, setMinScrapeSize] = useState(0);
  const [targetUrl, setTargetUrl] = useState("https://www.thecandidplanet.com/");
  const [cookies, setCookies] = useState("");
  const [showCookieInput, setShowCookieInput] = useState(false);
  const verifyLogin = useVerifyLogin();
  const verifyResult = verifyLogin.data;

  // ── bookmarklet: auto-fill cookies from ?cookies= URL param ──────────────
  const didAutoFill = useRef(false);
  useEffect(() => {
    if (didAutoFill.current) return;
    const params = new URLSearchParams(window.location.search);
    const captured = params.get("cookies");
    if (captured) {
      didAutoFill.current = true;
      setCookies(captured);
      setShowCookieInput(true);
      // strip the param from the URL without a reload
      params.delete("cookies");
      const newSearch = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (newSearch ? `?${newSearch}` : ""));
      // auto-verify after state settles
      setTimeout(() => {
        verifyLogin.mutate({ data: { cookies: captured, targetUrl: targetUrl.trim() || undefined } });
      }, 100);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── bookmarklet code (set via ref to bypass React's javascript: block) ─────
  const bookmarkletRef = useRef<HTMLAnchorElement>(null);
  const [bookmarkletCopied, setBookmarkletCopied] = useState(false);
  const bookmarkletCode = useRef("");
  useEffect(() => {
    const appUrl = window.location.origin + window.location.pathname;
    bookmarkletCode.current =
      `javascript:(function(){` +
      `var c=document.cookie;` +
      `if(!c){alert('No cookies found \u2014 make sure you are logged in to the target site first');return;}` +
      `window.open(${JSON.stringify(appUrl)}+'?cookies='+encodeURIComponent(c),'_blank');` +
      `})();`;
    if (bookmarkletRef.current) {
      bookmarkletRef.current.setAttribute("href", bookmarkletCode.current);
    }
  }, []);

  const copyBookmarklet = () => {
    navigator.clipboard.writeText(bookmarkletCode.current).then(() => {
      setBookmarkletCopied(true);
      setTimeout(() => setBookmarkletCopied(false), 2500);
    });
  };

  // ── remote data ──────────────────────────────────────────────────────────
  const { data: statusData } = useGetScrapeStatus({
    query: {
      refetchInterval: (query) => query.state.data?.status === "running" ? 1500 : false,
      queryKey: getGetScrapeStatusQueryKey(),
    }
  });

  const { data: imagesData } = useGetScrapeImages({
    query: {
      refetchInterval: (query) => {
        const currentStatus = queryClient.getQueryData<{ status: string }>(getGetScrapeStatusQueryKey());
        return currentStatus?.status === "running" ? 2000 : false;
      },
      queryKey: getGetScrapeImagesQueryKey(),
    }
  });

  const { data: videosData } = useGetScrapeVideos({
    query: {
      refetchInterval: () => {
        const currentStatus = queryClient.getQueryData<{ status: string }>(getGetScrapeStatusQueryKey());
        return currentStatus?.status === "running" ? 2000 : false;
      },
      queryKey: getGetScrapeVideosQueryKey(),
    }
  });

  const startScrape = useStartScrape();
  const stopScrape = useStopScrape();
  const resetScrape = useResetScrape();

  const handleStop = () => {
    stopScrape.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetScrapeStatusQueryKey() });
      }
    });
  };

  const handleStart = () => {
    startScrape.mutate({ data: { targetUrl: targetUrl.trim() || undefined, maxPages, minDimension: minScrapeSize, cookies: cookies.trim() || undefined } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetScrapeStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetScrapeImagesQueryKey() });
        setSelectedIds(new Set());
      }
    });
  };

  const handleReset = () => {
    resetScrape.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetScrapeStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetScrapeImagesQueryKey() });
        setSelectedIds(new Set());
      }
    });
  };

  // ── derived state ────────────────────────────────────────────────────────
  const isRunning = statusData?.status === "running";
  const isDone = statusData?.status === "done";
  const hasImages = (imagesData?.length ?? 0) > 0;
  const totalPages = (statusData?.pagesVisited ?? 0) + (statusData?.pagesQueued ?? 0);
  const progressPercent = totalPages > 0 ? ((statusData?.pagesVisited ?? 0) / totalPages) * 100 : 0;

  // ── filtered gallery ─────────────────────────────────────────────────────
  const filteredImages = useMemo(() => {
    if (!imagesData) return [];
    if (minSize <= 0) return imagesData;
    return imagesData.filter((img) => {
      // show images with known dimensions only if both meet the threshold
      if (img.width !== null && img.height !== null) {
        return img.width >= minSize && img.height >= minSize;
      }
      // unknown dimensions: hide when a filter is active (can't verify size)
      return false;
    });
  }, [imagesData, minSize]);

  // ── lightbox ──────────────────────────────────────────────────────────────
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxImg = lightboxIndex !== null ? filteredImages[lightboxIndex] : null;
  const lightboxVideos = lightboxImg
    ? (videosData ?? []).filter((v) => v.sourcePageUrl === lightboxImg.sourcePageUrl)
    : [];

  const closeLightbox = useCallback(() => setLightboxIndex(null), []);
  const lightboxPrev = useCallback(() =>
    setLightboxIndex((i) => (i !== null && i > 0 ? i - 1 : i)), []);
  const lightboxNext = useCallback(() =>
    setLightboxIndex((i) => (i !== null && i < filteredImages.length - 1 ? i + 1 : i)), [filteredImages.length]);

  useEffect(() => {
    if (lightboxIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLightbox();
      if (e.key === "ArrowLeft") lightboxPrev();
      if (e.key === "ArrowRight") lightboxNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxIndex, closeLightbox, lightboxPrev, lightboxNext]);

  // ── selection helpers ────────────────────────────────────────────────────
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = () => setSelectedIds(new Set(filteredImages.map((img) => img.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const selectedCount = selectedIds.size;
  const allFilteredSelected = filteredImages.length > 0 && filteredImages.every((img) => selectedIds.has(img.id));

  const selectedZipUrl = useMemo(() => {
    if (selectedCount === 0) return null;
    const ids = [...selectedIds].join(",");
    return `/api/scraper/download-zip?ids=${encodeURIComponent(ids)}`;
  }, [selectedIds, selectedCount]);

  return (
    <div className="min-h-screen bg-background text-foreground font-mono flex flex-col items-center">
      {/* Header */}
      <header className="w-full max-w-6xl p-6 border-b border-border/50 bg-card/30 flex items-center justify-between z-10 sticky top-0 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-primary text-primary-foreground flex items-center justify-center font-bold">
            <Box size={18} />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-primary">Image Scraper</h1>
        </div>

        <div className="flex items-center gap-3">
          {selectedCount > 0 && (
            <Button asChild variant="default" className="gap-2 font-sans font-bold">
              <a href={selectedZipUrl!} download="selected-images.zip" data-testid="button-download-selected">
                <DownloadCloud size={16} />
                Download Selected ({selectedCount})
              </a>
            </Button>
          )}

          {hasImages && selectedCount === 0 && (
            <Button asChild variant="outline" className="gap-2 font-sans border-primary/20 hover:border-primary/50 text-primary">
              <a href="/api/scraper/download-zip" download="scraped-images.zip" data-testid="button-download-all">
                <DownloadCloud size={16} />
                Download All ZIP
              </a>
            </Button>
          )}

          <Button 
            variant="destructive" 
            size="icon" 
            onClick={handleReset} 
            disabled={isRunning || (!isDone && statusData?.status !== "error" && !hasImages)}
            title="Reset Scraper"
            data-testid="button-reset"
          >
            <RotateCcw size={16} />
          </Button>

          <div className="flex items-center gap-1.5 bg-card border border-border/60 rounded px-2.5 py-1 text-xs">
            <span className="text-muted-foreground whitespace-nowrap">URL</span>
            <input
              type="url"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              disabled={isRunning}
              placeholder="https://example.com/"
              title="Starting URL to scrape. The crawler stays within the same domain."
              className="w-52 bg-transparent border border-border/60 rounded px-2 py-0.5 text-foreground focus:outline-none focus:border-primary/60 disabled:opacity-40"
              data-testid="input-target-url"
            />
          </div>

          <div className="flex items-center gap-1.5 bg-card border border-border/60 rounded px-2.5 py-1 text-xs">
            <span className="text-muted-foreground whitespace-nowrap">Min image</span>
            <input
              type="number"
              min={0}
              step={50}
              value={minScrapeSize}
              onChange={(e) => setMinScrapeSize(Math.max(0, parseInt(e.target.value) || 0))}
              disabled={isRunning}
              title="Minimum width & height in px to collect. 0 = collect all."
              className="w-16 bg-transparent border border-border/60 rounded px-2 py-0.5 text-foreground text-right focus:outline-none focus:border-primary/60 disabled:opacity-40"
              data-testid="input-min-scrape-size"
            />
            <span className="text-muted-foreground">px</span>
          </div>

          <div className="flex items-center gap-1.5 bg-card border border-border/60 rounded px-2.5 py-1 text-xs">
            <span className="text-muted-foreground whitespace-nowrap">Max pages</span>
            <input
              type="number"
              min={0}
              step={100}
              value={maxPages}
              onChange={(e) => setMaxPages(Math.max(0, parseInt(e.target.value) || 0))}
              disabled={isRunning}
              title="0 = unlimited"
              className="w-16 bg-transparent border border-border/60 rounded px-2 py-0.5 text-foreground text-right focus:outline-none focus:border-primary/60 disabled:opacity-40"
              data-testid="input-max-pages"
            />
          </div>

          {isRunning ? (
            <Button
              onClick={handleStop}
              disabled={stopScrape.isPending}
              variant="destructive"
              className="gap-2 font-bold font-sans tracking-wide"
              data-testid="button-stop"
            >
              {stopScrape.isPending ? (
                <><Loader2 size={16} className="animate-spin" /> Stopping…</>
              ) : (
                <><StopIcon size={16} /> Stop</>
              )}
            </Button>
          ) : (
            <Button 
              onClick={handleStart} 
              disabled={isDone}
              className="gap-2 font-bold font-sans tracking-wide"
              data-testid="button-start"
            >
              <Play size={16} />
              Start Scraping
            </Button>
          )}
        </div>
      </header>

      <main className="w-full max-w-6xl p-6 flex flex-col gap-6">

        {/* Session Cookie Panel */}
        <section className="bg-card border border-border rounded-lg shadow-xl shadow-black/50 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowCookieInput((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-muted/30 transition-colors text-left"
          >
            <div className="flex items-center gap-2.5">
              <KeyRound size={15} className={cookies.trim() ? "text-primary" : "text-muted-foreground"} />
              <span className="text-sm font-semibold">
                {cookies.trim() ? "Session Cookie set" : "Login / Session Cookie"}
              </span>
              {cookies.trim() && (
                <span className="flex items-center gap-1 text-[10px] bg-primary/15 text-primary px-2 py-0.5 rounded-full">
                  <ShieldCheck size={10} />
                  Active
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="text-xs hidden sm:inline">
                {cookies.trim() ? "Click to edit" : "Optional — needed for login-protected pages"}
              </span>
              {showCookieInput ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </div>
          </button>

          {showCookieInput && (
            <div className="px-5 pb-5 flex flex-col gap-4 border-t border-border/50">
              <div className="pt-4 flex flex-col gap-3">
                {/* ── Option 1: Bookmarklet ── */}
                <div className="flex flex-col gap-2.5 bg-primary/5 border border-primary/20 rounded p-3 text-xs">
                  <p className="font-semibold text-foreground">Option 1 — Bookmark capture (easiest, one-time setup)</p>
                  <ol className="text-muted-foreground flex flex-col gap-1.5 pl-1 leading-relaxed list-decimal list-inside">
                    <li>Show your bookmarks bar if hidden (<kbd className="bg-muted px-1 py-0.5 rounded text-[10px]">Ctrl/Cmd+Shift+B</kbd>).</li>
                    <li><strong className="text-foreground">Drag</strong> the blue button below up onto your bookmarks bar.</li>
                    <li>Go to the target site and log in.</li>
                    <li>Click the bookmark you just added → this app reopens with cookies pre-filled.</li>
                  </ol>
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    {/* Draggable bookmarklet — href is set via ref to bypass React's javascript: block.
                        Clicking does nothing useful (it'd run on THIS page), so it's drag-only. */}
                    <a
                      ref={bookmarkletRef}
                      draggable
                      onClick={(e) => e.preventDefault()}
                      title="Drag me to your bookmarks bar"
                      className="inline-flex items-center gap-1.5 h-7 px-3 rounded border border-primary/50 bg-primary/15 text-primary font-medium cursor-grab active:cursor-grabbing select-none no-underline"
                    >
                      <Bookmark size={12} /> Capture Cookies
                    </a>
                    <span className="text-muted-foreground">← drag me to your bookmarks bar</span>
                  </div>
                  <div className="flex items-center gap-2 pt-0.5 border-t border-primary/10 mt-0.5">
                    <span className="text-muted-foreground pt-1.5">Can't drag?</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs gap-1.5 border-primary/40 text-primary hover:border-primary mt-1"
                      onClick={copyBookmarklet}
                    >
                      {bookmarkletCopied
                        ? <><Check size={12} /> Copied!</>
                        : <><Copy size={12} /> Copy Code</>}
                    </Button>
                    <span className="text-muted-foreground pt-1.5">then paste as a new bookmark's URL.</span>
                  </div>
                </div>

                {/* ── Option 2: Network tab ── */}
                <div className="text-xs text-muted-foreground bg-background/60 border border-border/50 rounded p-3 flex flex-col gap-2 leading-relaxed">
                  <p className="font-semibold text-foreground">Option 2 — Network tab (works for all cookies)</p>
                  <ol className="list-decimal list-inside flex flex-col gap-1 pl-1">
                    <li>Log into the target site in your browser.</li>
                    <li>Press <kbd className="bg-muted px-1 py-0.5 rounded text-[10px]">F12</kbd> → click the <strong>Network</strong> tab.</li>
                    <li>Reload the page (<kbd className="bg-muted px-1 py-0.5 rounded text-[10px]">F5</kbd>).</li>
                    <li>Click the <strong>first request</strong> in the list (type: <em>document</em>).</li>
                    <li>In the right panel → <strong>Request Headers</strong> → find <strong>Cookie</strong>.</li>
                    <li>Right-click the value → <strong>Copy value</strong> → paste below.</li>
                  </ol>
                  <div className="flex items-start gap-1.5 mt-0.5 bg-amber-500/10 border border-amber-500/20 rounded px-2.5 py-2 text-amber-400">
                    <AlertCircle size={12} className="mt-0.5 shrink-0" />
                    <span>
                      The bookmarklet can only capture non-HttpOnly cookies. If verify still fails, use the Network tab method — it captures <strong>all</strong> cookies, including the HttpOnly session cookies that browsers hide from the console.
                    </span>
                  </div>
                </div>

                <textarea
                  value={cookies}
                  onChange={(e) => setCookies(e.target.value)}
                  disabled={isRunning}
                  placeholder="Paste your Cookie header value here, e.g. wordpress_logged_in_abc=user%7C...; other_cookie=value"
                  rows={3}
                  className="w-full bg-background/50 border border-border/60 rounded px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:border-primary/60 disabled:opacity-40"
                  data-testid="input-cookies"
                />

                {/* Verify result banner */}
                {verifyResult && (
                  <div className={`flex items-center gap-2.5 px-3 py-2.5 rounded border text-xs font-sans ${
                    verifyResult.loggedIn
                      ? "bg-primary/10 border-primary/30 text-primary"
                      : "bg-destructive/10 border-destructive/30 text-destructive"
                  }`}>
                    {verifyResult.loggedIn
                      ? <ShieldCheck size={15} className="shrink-0" />
                      : <XCircle size={15} className="shrink-0" />}
                    <span className="flex-1">{verifyResult.message}</span>
                  </div>
                )}

                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] text-muted-foreground">
                    Cookies are only kept in memory and sent directly to the target site — never stored or logged.
                  </p>
                  <div className="flex items-center gap-2 shrink-0">
                    {cookies.trim() && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-7 gap-1.5 border-primary/40 text-primary hover:border-primary"
                        disabled={verifyLogin.isPending}
                        onClick={() => verifyLogin.mutate({ data: { cookies: cookies.trim(), targetUrl: targetUrl.trim() || undefined } })}
                        data-testid="button-verify-login"
                      >
                        {verifyLogin.isPending
                          ? <><Loader2 size={12} className="animate-spin" /> Checking...</>
                          : <><ShieldCheck size={12} /> Verify Login</>}
                      </Button>
                    )}
                    {cookies.trim() && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7 text-destructive hover:text-destructive"
                        onClick={() => { setCookies(""); verifyLogin.reset(); }}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Status Panel */}
        <section className="bg-card border border-border rounded-lg p-5 flex flex-col gap-4 shadow-xl shadow-black/50">
          <div className="flex justify-between items-center">
            <h2 className="text-sm uppercase tracking-widest text-muted-foreground">Scraper Status</h2>
            <Badge variant={
              statusData?.status === "running" ? "default" :
              statusData?.status === "done" ? "secondary" :
              statusData?.status === "error" ? "destructive" : "outline"
            }>
              {statusData?.status || "Idle"}
            </Badge>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="flex flex-col gap-1 p-3 bg-background/50 rounded border border-border/50">
              <span className="text-xs text-muted-foreground">Pages Visited</span>
              <span className="text-2xl text-primary font-bold">{statusData?.pagesVisited ?? 0}</span>
            </div>
            <div className="flex flex-col gap-1 p-3 bg-background/50 rounded border border-border/50">
              <span className="text-xs text-muted-foreground">Pages Queued</span>
              <span className="text-2xl text-foreground font-bold">{statusData?.pagesQueued ?? 0}</span>
            </div>
            <div className="flex flex-col gap-1 p-3 bg-background/50 rounded border border-border/50">
              <span className="text-xs text-muted-foreground">Images Found</span>
              <span className="text-2xl text-primary font-bold">{statusData?.imagesFound ?? 0}</span>
            </div>
            <div className="flex flex-col gap-1 p-3 bg-background/50 rounded border border-border/50">
              <span className="text-xs text-muted-foreground">Videos Found</span>
              <span className="text-2xl text-primary font-bold">{statusData?.videosFound ?? 0}</span>
            </div>
          </div>

          {isRunning && (
            <div className="flex flex-col gap-2 mt-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span className="flex items-center gap-2 truncate flex-1">
                  <LinkIcon size={12} />
                  <span className="truncate max-w-[500px]">{statusData?.currentUrl ?? "Initializing..."}</span>
                </span>
                <span>{Math.round(progressPercent)}%</span>
              </div>
              <Progress value={progressPercent} className="h-1 bg-muted">
                <div 
                  className="h-full bg-primary transition-all duration-500 ease-out" 
                  style={{ width: `${progressPercent}%` }} 
                />
              </Progress>
            </div>
          )}

          {statusData?.status === "error" && (
            <div className="flex items-center gap-2 text-destructive bg-destructive/10 p-3 rounded text-sm mt-2 border border-destructive/20">
              <AlertCircle size={16} />
              <span>{statusData.errorMessage ?? "An unknown error occurred."}</span>
            </div>
          )}
        </section>

        {/* Gallery */}
        <section className="flex flex-col gap-4 mt-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <ImageIcon size={18} className="text-primary" />
              Discovered Images
              <span className="text-sm text-muted-foreground font-normal ml-1">
                {filteredImages.length !== (imagesData?.length ?? 0)
                  ? `${filteredImages.length} of ${imagesData?.length ?? 0}`
                  : `${imagesData?.length ?? 0} total`}
              </span>
            </h2>

            {hasImages && (
              <div className="flex items-center gap-3 flex-wrap">
                {/* Min size filter */}
                <div className="flex items-center gap-2 bg-card border border-border rounded px-3 py-1.5 text-xs">
                  <SlidersHorizontal size={13} className="text-muted-foreground" />
                  <label htmlFor="min-size" className="text-muted-foreground whitespace-nowrap">Min size</label>
                  <input
                    id="min-size"
                    type="number"
                    min={0}
                    step={50}
                    value={minSize}
                    onChange={(e) => {
                      setMinSize(Math.max(0, parseInt(e.target.value) || 0));
                      setSelectedIds(new Set());
                    }}
                    className="w-16 bg-transparent border border-border/60 rounded px-2 py-0.5 text-foreground text-right focus:outline-none focus:border-primary/60"
                    data-testid="input-min-size"
                  />
                  <span className="text-muted-foreground">px</span>
                </div>

                {/* Select all / clear */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-xs font-sans h-8 px-2 border border-border/50"
                  onClick={allFilteredSelected ? clearSelection : selectAll}
                  data-testid="button-select-all"
                >
                  {allFilteredSelected
                    ? <><CheckSquare size={13} /> Deselect All</>
                    : <><Square size={13} /> Select All</>}
                </Button>

                {selectedCount > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {selectedCount} selected
                  </span>
                )}
              </div>
            )}
          </div>

          {!hasImages && !isRunning && (
            <div className="flex flex-col items-center justify-center py-20 border border-dashed border-border rounded-lg text-muted-foreground bg-card/30">
              <ImageIcon size={48} className="mb-4 opacity-20" />
              <p>No images found yet.</p>
              <p className="text-sm mt-1">Start a scrape to discover images on the site.</p>
            </div>
          )}

          {hasImages && filteredImages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 border border-dashed border-border rounded-lg text-muted-foreground bg-card/30">
              <SlidersHorizontal size={48} className="mb-4 opacity-20" />
              <p>No images match the current filter.</p>
              <p className="text-sm mt-1">Try lowering the minimum size.</p>
            </div>
          )}

          {filteredImages.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 pb-20">
              {filteredImages.map((img, i) => {
                const isSelected = selectedIds.has(img.id);
                return (
                  <Card
                    key={img.id}
                    onClick={() => toggleSelect(img.id)}
                    className={`overflow-hidden flex flex-col transition-colors animate-in fade-in zoom-in duration-300 cursor-pointer select-none ${
                      isSelected
                        ? "border-primary shadow-[0_0_0_2px_hsl(var(--primary)/0.5)]"
                        : "border-border/50 hover:border-primary/40"
                    }`}
                    style={{ animationDelay: `${(i % 10) * 50}ms` }}
                  >
                    <div className="aspect-square bg-black/50 relative group flex items-center justify-center p-4">
                      {/* Checkered background */}
                      <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPgo8cmVjdCB3aWR0aD0iNCIgaGVpZ2h0PSI0IiBmaWxsPSIjMzMzIj48L3JlY3Q+CjxyZWN0IHg9IjQiIHk9IjQiIHdpZHRoPSI0IiBoZWlnaHQ9IjQiIGZpbGw9IiMzMzMiPjwvcmVjdD4KPC9zdmc+')] opacity-20 z-0" />

                      {/* Selection checkbox badge */}
                      <div
                        className={`absolute top-2 left-2 z-30 rounded transition-opacity ${isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                        onClick={(e) => { e.stopPropagation(); toggleSelect(img.id); }}
                      >
                        {isSelected
                          ? <CheckSquare size={20} className="text-primary drop-shadow-md" />
                          : <Square size={20} className="text-white/80 drop-shadow-md" />}
                      </div>

                      <img 
                        src={`/api/scraper/images/${img.id}/download`}
                        alt={img.alt || "Scraped image"} 
                        className="max-w-full max-h-full object-contain relative z-10 drop-shadow-md cursor-zoom-in"
                        loading="lazy"
                        onClick={(e) => { e.stopPropagation(); setLightboxIndex(i); }}
                      />

                      {/* Hover overlay — view + download buttons */}
                      <div
                        className="absolute inset-0 bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity z-20 flex items-center justify-center gap-2 backdrop-blur-sm"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button variant="secondary" size="sm" className="gap-1.5 font-sans font-bold shadow-xl"
                          onClick={() => setLightboxIndex(i)}>
                          <Maximize2 size={14} /> View
                        </Button>
                        <Button asChild variant="secondary" size="sm" className="gap-1.5 font-sans font-bold shadow-xl">
                          <a href={`/api/scraper/images/${img.id}/download`} download data-testid={`button-download-image-${img.id}`}>
                            <Download size={14} />
                            Download
                          </a>
                        </Button>
                      </div>
                    </div>

                    <CardContent className="p-3 text-xs flex flex-col gap-2 flex-1">
                      <div className="flex flex-col gap-1">
                        <span className="text-muted-foreground font-semibold uppercase text-[10px]">Source URL</span>
                        <a
                          href={img.url}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate text-primary hover:underline"
                          title={img.url}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {img.url}
                        </a>
                      </div>
                      {(img.alt || (img.width && img.height)) && (
                        <div className="flex flex-col gap-1 mt-auto pt-2 border-t border-border/50">
                          {img.alt && (
                            <span className="truncate text-muted-foreground" title={img.alt}>
                              Alt: {img.alt}
                            </span>
                          )}
                          {(img.width && img.height) && (
                            <span className="text-muted-foreground/70">
                              {img.width} × {img.height}
                            </span>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {isRunning && (
            <div className="py-8 flex justify-center items-center">
              <div className="flex gap-2 items-center text-primary font-bold text-sm uppercase tracking-widest">
                <Activity size={16} className="animate-spin" />
                Discovering more...
              </div>
            </div>
          )}

        </section>

        {/* Videos Section */}
        {((videosData?.length ?? 0) > 0 || isRunning) && (
          <section className="bg-card border border-border rounded-lg p-5 flex flex-col gap-4 shadow-xl shadow-black/50">
            <div className="flex items-center gap-2">
              <Film size={16} className="text-primary" />
              <h2 className="text-sm font-semibold text-foreground uppercase tracking-widest">
                Discovered Videos
              </h2>
              <span className="text-xs text-muted-foreground font-normal ml-1">
                {videosData?.length ?? 0} total
              </span>
            </div>

            {(videosData?.length ?? 0) === 0 && isRunning && (
              <p className="text-xs text-muted-foreground">Scanning for video links…</p>
            )}

            {(videosData?.length ?? 0) > 0 && (
              <div className="flex flex-col divide-y divide-border/40">
                {videosData!.map((vid) => (
                  <div key={vid.id} className="flex items-center gap-3 py-2.5 group">
                    <Film size={14} className="text-muted-foreground shrink-0" />
                    <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                      <span className="text-xs font-mono text-foreground truncate" title={vid.filename}>
                        {vid.filename}
                      </span>
                      <a
                        href={vid.sourcePageUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[10px] text-muted-foreground hover:text-primary truncate"
                        title={vid.sourcePageUrl}
                      >
                        {vid.sourcePageUrl}
                      </a>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button asChild variant="ghost" size="sm" className="h-7 text-xs gap-1">
                        <a href={vid.url} target="_blank" rel="noreferrer">
                          <ExternalLink size={12} /> Open
                        </a>
                      </Button>
                      <Button asChild variant="secondary" size="sm" className="h-7 text-xs gap-1">
                        <a href={vid.url} download>
                          <Download size={12} /> Download
                        </a>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

      </main>

      {/* ── Lightbox ─────────────────────────────────────────────────────── */}
      {lightboxImg && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={closeLightbox}
        >
          {/* Top bar */}
          <div
            className="flex items-center justify-between px-4 py-3 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-xs text-white/50 font-mono">
              {lightboxIndex! + 1} / {filteredImages.length}
            </span>
            <div className="flex items-center gap-2">
              <Button asChild variant="ghost" size="sm" className="gap-1.5 text-white/80 hover:text-white">
                <a href={`/api/scraper/images/${lightboxImg.id}/download`} download onClick={(e) => e.stopPropagation()}>
                  <Download size={14} /> Download
                </a>
              </Button>
              <Button variant="ghost" size="icon" className="text-white/60 hover:text-white h-8 w-8" onClick={closeLightbox}>
                <X size={18} />
              </Button>
            </div>
          </div>

          {/* Image area */}
          <div className="flex-1 flex items-center justify-center relative min-h-0 px-14">
            {/* Prev */}
            {lightboxIndex! > 0 && (
              <button
                className="absolute left-2 top-1/2 -translate-y-1/2 z-10 rounded-full bg-white/10 hover:bg-white/20 p-2 text-white transition-colors"
                onClick={(e) => { e.stopPropagation(); lightboxPrev(); }}
              >
                <ChevronLeft size={24} />
              </button>
            )}

            <img
              key={lightboxImg.id}
              src={`/api/scraper/images/${lightboxImg.id}/download`}
              alt={lightboxImg.alt || ""}
              className="max-w-full max-h-full object-contain animate-in zoom-in-95 duration-150"
              onClick={(e) => e.stopPropagation()}
            />

            {/* Next */}
            {lightboxIndex! < filteredImages.length - 1 && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 z-10 rounded-full bg-white/10 hover:bg-white/20 p-2 text-white transition-colors"
                onClick={(e) => { e.stopPropagation(); lightboxNext(); }}
              >
                <ChevronRight size={24} />
              </button>
            )}
          </div>

          {/* Bottom info bar */}
          <div
            className="shrink-0 px-5 py-3 flex flex-col gap-2 bg-black/60 border-t border-white/10 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-white/50">
              {lightboxImg.alt && (
                <span className="italic truncate max-w-sm" title={lightboxImg.alt}>"{lightboxImg.alt}"</span>
              )}
              {lightboxImg.width && lightboxImg.height && (
                <span>{lightboxImg.width} × {lightboxImg.height}px</span>
              )}
              <a
                href={lightboxImg.sourcePageUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-primary/70 hover:text-primary truncate max-w-xs"
                title={lightboxImg.sourcePageUrl}
              >
                <ExternalLink size={11} /> Source page
              </a>
              <a
                href={lightboxImg.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-primary/70 hover:text-primary truncate max-w-xs"
                title={lightboxImg.url}
              >
                <ExternalLink size={11} /> Image URL
              </a>
            </div>

            {/* Related videos from same source page */}
            {lightboxVideos.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-white/10">
                <span className="text-white/40 flex items-center gap-1 shrink-0">
                  <Film size={11} /> Video{lightboxVideos.length > 1 ? "s" : ""} on this page:
                </span>
                {lightboxVideos.map((v) => (
                  <a
                    key={v.id}
                    href={v.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-primary hover:text-primary/80 underline underline-offset-2 font-mono truncate max-w-xs"
                    title={v.url}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Film size={11} /> {v.filename}
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
