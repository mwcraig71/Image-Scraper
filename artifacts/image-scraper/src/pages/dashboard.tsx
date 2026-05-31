import { useMemo } from "react";
import { 
  useStartScrape, 
  useGetScrapeStatus, 
  useGetScrapeImages, 
  useResetScrape, 
  getGetScrapeStatusQueryKey, 
  getGetScrapeImagesQueryKey 
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Play, RotateCcw, Download, Image as ImageIcon, Link as LinkIcon, AlertCircle, Activity, Box, DownloadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function Dashboard() {
  const queryClient = useQueryClient();

  const { data: statusData } = useGetScrapeStatus({
    query: {
      refetchInterval: (query) => query.state.data?.status === "running" ? 1500 : false,
      queryKey: getGetScrapeStatusQueryKey(),
    }
  });

  const { data: imagesData } = useGetScrapeImages({
    query: {
      refetchInterval: (query) => {
        // We only want to refetch images if running.
        const currentStatus = queryClient.getQueryData<any>(getGetScrapeStatusQueryKey());
        return currentStatus?.status === "running" ? 2000 : false;
      },
      queryKey: getGetScrapeImagesQueryKey(),
    }
  });

  const startScrape = useStartScrape();
  const resetScrape = useResetScrape();

  const handleStart = () => {
    startScrape.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetScrapeStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetScrapeImagesQueryKey() });
      }
    });
  };

  const handleReset = () => {
    resetScrape.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetScrapeStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetScrapeImagesQueryKey() });
      }
    });
  };

  const isRunning = statusData?.status === "running";
  const isDone = statusData?.status === "done";
  const hasImages = (imagesData?.length ?? 0) > 0;
  
  const totalPages = (statusData?.pagesVisited ?? 0) + (statusData?.pagesQueued ?? 0);
  const progressPercent = totalPages > 0 ? ((statusData?.pagesVisited ?? 0) / totalPages) * 100 : 0;

  return (
    <div className="min-h-screen bg-background text-foreground font-mono flex flex-col items-center">
      {/* Header */}
      <header className="w-full max-w-6xl p-6 border-b border-border/50 bg-card/30 flex items-center justify-between z-10 sticky top-0 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-primary text-primary-foreground flex items-center justify-center font-bold">
            <Box size={18} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-primary">Image Scraper</h1>
            <p className="text-xs text-muted-foreground font-sans">Target: thecandidplanet.com</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {hasImages && (
            <Button asChild variant="outline" className="gap-2 font-sans border-primary/20 hover:border-primary/50 text-primary">
              <a href="/api/scraper/download-zip" download="scraped-images.zip" data-testid="button-download-all">
                <DownloadCloud size={16} />
                Download ZIP
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

          <Button 
            onClick={handleStart} 
            disabled={isRunning || isDone}
            className="gap-2 font-bold font-sans tracking-wide"
            data-testid="button-start"
          >
            {isRunning ? (
              <>
                <Activity size={16} className="animate-pulse" />
                Scraping...
              </>
            ) : (
              <>
                <Play size={16} />
                Start Scraping
              </>
            )}
          </Button>
        </div>
      </header>

      <main className="w-full max-w-6xl p-6 flex flex-col gap-6">
        
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

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <ImageIcon size={18} className="text-primary" />
              Discovered Images
            </h2>
            <span className="text-sm text-muted-foreground">
              {imagesData?.length ?? 0} total
            </span>
          </div>

          {!hasImages && !isRunning && (
            <div className="flex flex-col items-center justify-center py-20 border border-dashed border-border rounded-lg text-muted-foreground bg-card/30">
              <ImageIcon size={48} className="mb-4 opacity-20" />
              <p>No images found yet.</p>
              <p className="text-sm mt-1">Start a scrape to discover images on the site.</p>
            </div>
          )}

          {hasImages && (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 pb-20">
              {imagesData?.map((img, i) => (
                <Card key={img.id} className="overflow-hidden flex flex-col border-border/50 hover:border-primary/50 transition-colors animate-in fade-in zoom-in duration-300" style={{ animationDelay: `${(i % 10) * 50}ms` }}>
                  <div className="aspect-square bg-black/50 relative group flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPgo8cmVjdCB3aWR0aD0iNCIgaGVpZ2h0PSI0IiBmaWxsPSIjMzMzIj48L3JlY3Q+CjxyZWN0IHg9IjQiIHk9IjQiIHdpZHRoPSI0IiBoZWlnaHQ9IjQiIGZpbGw9IiMzMzMiPjwvcmVjdD4KPC9zdmc+')] opacity-20 z-0"></div>
                    <img 
                      src={img.url} 
                      alt={img.alt || "Scraped image"} 
                      className="max-w-full max-h-full object-contain relative z-10 drop-shadow-md"
                      loading="lazy"
                    />
                    <div className="absolute inset-0 bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity z-20 flex items-center justify-center backdrop-blur-sm">
                      <Button asChild variant="secondary" className="gap-2 font-sans font-bold shadow-xl">
                        <a href={img.url} download data-testid={`button-download-image-${img.id}`}>
                          <Download size={16} />
                          Download
                        </a>
                      </Button>
                    </div>
                  </div>
                  <CardContent className="p-3 text-xs flex flex-col gap-2 flex-1">
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground font-semibold uppercase text-[10px]">Source URL</span>
                      <a href={img.url} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline" title={img.url}>
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
              ))}
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
      </main>
    </div>
  );
}