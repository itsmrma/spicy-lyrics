import { useEffect, useState } from "react";
import { SpotifyPlayer } from "../components/Global/SpotifyPlayer.ts";
import PageView from "../components/Pages/PageView.ts";
import { toast } from "sonner";
import { getExpireStoreSizeBytes, onExpireStoreChange } from "../modules/Store.ts";
import fetchLyrics, { LYRICS_STORE_NAME, LyricsStore } from "./Lyrics/fetchLyrics.ts";
import {
  clearGeniusCache,
  getGeniusCacheStats,
  onGeniusCacheChange,
  removeGeniusCacheForSong,
} from "./Lyrics/Genius/GeniusSingerAttribution.ts";
import ApplyLyrics from "./Lyrics/Global/Applyer.ts";
import { $currentLyricsData } from "./stores.ts";
import Logger from "./Logger.ts";

const cacheToolsLogger = new Logger("Lyrics Cache");

export function formatCacheBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

export async function getAllLyricsCacheStats(): Promise<{
  totalBytes: number;
  totalCount: number;
  lyricsBytes: number;
  lyricsCount: number;
  geniusBytes: number;
  geniusCount: number;
}> {
  const [lyricsStats, geniusStats] = await Promise.all([
    getExpireStoreSizeBytes([LYRICS_STORE_NAME]),
    getGeniusCacheStats(),
  ]);

  return {
    totalBytes: lyricsStats.bytes + geniusStats.bytes,
    totalCount: lyricsStats.count + geniusStats.count,
    lyricsBytes: lyricsStats.bytes,
    lyricsCount: lyricsStats.count,
    geniusBytes: geniusStats.bytes,
    geniusCount: geniusStats.count,
  };
}

export function useLyricsCacheStats() {
  const [stats, setStats] = useState({
    totalBytes: 0,
    totalCount: 0,
    lyricsBytes: 0,
    lyricsCount: 0,
    geniusBytes: 0,
    geniusCount: 0,
  });

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void getAllLyricsCacheStats().then((next) => {
        if (!cancelled) setStats(next);
      });
    };
    refresh();
    const unsubExpire = onExpireStoreChange(refresh);
    const unsubGenius = onGeniusCacheChange(refresh);
    return () => {
      cancelled = true;
      unsubExpire();
      unsubGenius();
    };
  }, []);

  return {
    ...stats,
    formattedTotal: formatCacheBytes(stats.totalBytes),
    formattedLyrics: formatCacheBytes(stats.lyricsBytes),
    formattedGenius: formatCacheBytes(stats.geniusBytes),
  };
}

export const RemoveCurrentLyrics_AllCaches = async (ui: boolean = false) => {
  const currentSongId = SpotifyPlayer.GetId();
  if (!currentSongId || currentSongId === undefined) {
    if (ui) {
      toast.error(`The current song id could not be retrieved`);
    }
  }
  try {
    await LyricsStore.RemoveItem(currentSongId ?? "");
    await removeGeniusCacheForSong(
      SpotifyPlayer.GetName(),
      SpotifyPlayer.GetArtists()?.[0]?.name
    );
    $currentLyricsData.set("");
    if (ui) {
      toast.success(`Lyrics for the current song have been removed from all available caches`);
    }
    if (PageView.IsOpened) {
      const uri = SpotifyPlayer.GetUri();
      if (uri && uri !== undefined) {
        fetchLyrics(uri).then(ApplyLyrics);
      }
    }
  } catch (error) {
    ui
      ? toast.error(`Lyrics for the current song couldn't be removed from all available caches. Check the console for more info.`)
      : null;
    cacheToolsLogger.error(error);
  }
};

export const RemoveLyricsCache = async (ui: boolean = false) => {
  try {
    await LyricsStore.Destroy();
    clearGeniusCache();
    $currentLyricsData.set("");
    if (ui) {
      toast.success("The Lyrics Cache has been cleared successfully");
    }
    if (PageView.IsOpened) {
      const uri = SpotifyPlayer.GetUri();
      if (uri && uri !== undefined) {
        fetchLyrics(uri).then(ApplyLyrics);
      }
    }
  } catch (error) {
    ui
      ? toast.error(`The Lyrics cache couldn't be removed. Check the console for more info.`)
      : null;
    cacheToolsLogger.error(error);
  }
};

export const ClearGeniusCache = async (ui: boolean = false) => {
  try {
    clearGeniusCache();
    $currentLyricsData.set("");
    if (ui) {
      toast.success("The Genius singer cache has been cleared successfully");
    }
    if (PageView.IsOpened) {
      const uri = SpotifyPlayer.GetUri();
      if (uri && uri !== undefined) {
        fetchLyrics(uri).then(ApplyLyrics);
      }
    }
  } catch (error) {
    if (ui) {
      toast.error(`The Genius singer cache couldn't be cleared. Check the console for more info.`);
    }
    console.error("SpicyLyrics:", error);
  }
};

export const RemoveCurrentLyrics_StateCache = (ui: boolean = false) => {
  try {
    $currentLyricsData.set("");
    if (ui) {
      toast.success("Lyrics for the current song have been removed from the internal state successfully");
    }
    if (PageView.IsOpened) {
      const uri = SpotifyPlayer.GetUri();
      if (uri && uri !== undefined) {
        fetchLyrics(uri).then(ApplyLyrics);
      }
    }
  } catch (error) {
    ui
      ? toast.error(`Lyrics for the current song couldn't be removed from the internal state. Check the console for more info.`)
      : null;
    cacheToolsLogger.error(error);
  }
};
