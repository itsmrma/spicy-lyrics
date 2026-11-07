import Logger from "../../Logger.ts";
import { isExperimentEnabled } from "../../experiments.ts";
import { $geniusAccessToken, $geniusProxyUrl } from "../../stores.ts";

const geniusLogger = new Logger("Genius Singers");

export interface GeniusSection {
  header: string;
  singer: string | null;
  lines: string[];
}

const GENIUS_CACHE = new Map<string, { sections: GeniusSection[]; timestamp: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const GENIUS_STORAGE_PREFIX = "spicy-lyrics:genius-cache:";

export function clearGeniusCache(): void {
  GENIUS_CACHE.clear();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(GENIUS_STORAGE_PREFIX)) {
        localStorage.removeItem(key);
      }
    }
  } catch {}
}

$geniusProxyUrl.listen(() => clearGeniusCache());
$geniusAccessToken.listen(() => clearGeniusCache());

/** Clean song title to improve Genius search matching rate */
export function cleanSearchTitle(title: string): string {
  return title
    .replace(/\s*-\s*(?:remastered|live|mono|stereo|single version|radio edit).*/i, "")
    .replace(/\s*\((?:feat\.|featuring|with|remastered|live|acoustic|instrumental|bonus track).*\)/i, "")
    .replace(/\s*\[(?:feat\.|featuring|with|remastered|live|acoustic|instrumental|bonus track).*\]/i, "")
    .trim();
}

/** Clean artist name for search */
export function cleanSearchArtist(artist: string): string {
  return artist
    .split(/\s*[,&]\s*|\s+(?:feat\.|featuring|with|ft\.)\s+|\s+\/\s+/i)[0]
    .trim();
}

/** Normalize string for phonetic / text similarity comparison */
function normalizeLine(line: string): string {
  return (line || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compute Jaccard / token similarity between two lyric lines */
function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }
  const wordsA = new Set(a.split(" ").filter(Boolean));
  const wordsB = new Set(b.split(" ").filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Parses raw Genius lyrics text or HTML containing bracketed section/singer tags:
 * e.g. [Verse 1: Jungkook], [Chorus: All], [Jennie], [RM & J-Hope]
 */
export function parseGeniusLyrics(textOrHtml: string): GeniusSection[] {
  let content = textOrHtml;
  // If full HTML is passed, isolate the lyrics container (Dumb or Genius)
  const dumbMatch = /<div id="lyrics"[^>]*>([\s\S]*?)<\/div>/i.exec(content);
  if (dumbMatch) {
    content = dumbMatch[1];
  } else {
    const containerMatches = [
      ...content.matchAll(/<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/gi),
    ];
    if (containerMatches.length > 0) {
      content = containerMatches.map((m) => m[1]).join("\n");
    }
  }

  // Strip HTML tags and entities, translating line breaks
  const text = content
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  const rawLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const sections: GeniusSection[] = [];
  let currentSection: GeniusSection = {
    header: "Intro",
    singer: null,
    lines: [],
  };

  const sectionRegex = /^\[([^\]]+)\]$/;
  const genericHeaders = /^(Intro|Outro|Verse|Chorus|Bridge|Hook|Pre-Chorus|Post-Chorus|Drop|Break|Interlude|Refrain|Instrumental|Solo)/i;

  for (const line of rawLines) {
    const match = sectionRegex.exec(line);
    if (match) {
      if (currentSection.lines.length > 0 || currentSection.singer) {
        sections.push(currentSection);
      }
      const rawHeader = match[1].trim();
      let singer: string | null = null;

      if (rawHeader.includes(":")) {
        const parts = rawHeader.split(":");
        singer = parts.slice(1).join(":").trim();
      } else if (!genericHeaders.test(rawHeader) && !/lyrics|가사|歌詞/i.test(rawHeader)) {
        singer = rawHeader;
      }

      currentSection = {
        header: rawHeader,
        singer: singer && singer.length > 0 ? singer : null,
        lines: [],
      };
    } else {
      // Check for inline singer prefix: e.g. "Jungkook: text"
      const inlineMatch = /^([A-Za-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\s&]+):\s*(.+)$/.exec(
        line
      );
      if (inlineMatch && !line.startsWith("http")) {
        currentSection.lines.push(inlineMatch[2].trim());
      } else {
        currentSection.lines.push(line);
      }
    }
  }

  if (currentSection.lines.length > 0 || currentSection.singer) {
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Searches Genius and fetches the lyrics section breakdown.
 */
export async function fetchGeniusSections(
  title: string,
  artist: string
): Promise<GeniusSection[] | null> {
  const cacheKey = `${artist.toLowerCase()} - ${title.toLowerCase()}`;
  const cached = GENIUS_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.sections;
  }

  // Check persistent storage
  try {
    const raw = Spicetify.LocalStorage.get(GENIUS_STORAGE_PREFIX + cacheKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.sections) && Date.now() - parsed.timestamp < CACHE_TTL_MS) {
        GENIUS_CACHE.set(cacheKey, parsed);
        return parsed.sections;
      }
    }
  } catch {}

  const saveToCache = (sections: GeniusSection[]) => {
    const entry = { sections, timestamp: Date.now() };
    GENIUS_CACHE.set(cacheKey, entry);
    try {
      Spicetify.LocalStorage.set(GENIUS_STORAGE_PREFIX + cacheKey, JSON.stringify(entry));
    } catch {}
  };

  const cleanTitle = cleanSearchTitle(title);
  const cleanArt = cleanSearchArtist(artist);
  const proxyUrl = $geniusProxyUrl.get().trim();
  const token = $geniusAccessToken.get().trim();

  // 1. If custom proxy URL is configured (e.g. Cloudflare Worker or local service), use it
  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      u.searchParams.set("title", cleanTitle);
      u.searchParams.set("artist", cleanArt);
      const headers: Record<string, string> = { Accept: "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      geniusLogger.debug("Fetching from Genius proxy", { url: u.toString() });
      const res = await fetch(u.toString(), { headers });
      if (res.ok) {
        const data = await res.json();
        let sections: GeniusSection[] | null = null;
        if (Array.isArray(data.sections)) {
          sections = data.sections;
        } else if (typeof data.lyrics === "string") {
          sections = parseGeniusLyrics(data.lyrics);
        } else if (typeof data.html === "string") {
          sections = parseGeniusLyrics(data.html);
        }
        if (sections && sections.some((s) => s.singer)) {
          saveToCache(sections);
          return sections;
        }
      } else {
        geniusLogger.warn("Genius proxy returned error", { status: res.status });
      }
    } catch (err) {
      geniusLogger.warn("Failed fetching from Genius proxy", err);
    }
  }

  // 2. If token is provided, query Genius API for the song URL
  if (token) {
    try {
      const query = `${cleanTitle} ${cleanArt}`.trim();
      const searchUrl = `https://api.genius.com/search?q=${encodeURIComponent(query)}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };

      const res = await fetch(searchUrl, { headers });
      if (res.ok) {
        const data = await res.json();
        const hits = data?.response?.hits;
        if (Array.isArray(hits) && hits.length > 0) {
          const hit =
            hits.find(
              (h: any) =>
                h.result?.primary_artist?.name?.toLowerCase().includes(cleanArt.toLowerCase()) ||
                cleanArt.toLowerCase().includes(h.result?.primary_artist?.name?.toLowerCase() || "")
            ) || hits[0];

          const songUrl = hit?.result?.url;
          if (songUrl) {
            geniusLogger.debug("Found Genius song URL", { songUrl });
            try {
              const songRes = await fetch(songUrl);
              if (songRes.ok) {
                const html = await songRes.text();
                const sections = parseGeniusLyrics(html);
                if (sections.some((s) => s.singer)) {
                  saveToCache(sections);
                  return sections;
                }
              } else if (songRes.status === 403) {
                geniusLogger.warn(
                  "Genius web page blocked by Cloudflare (403). Set up a Genius Proxy URL in Settings to scrape lyrics without Cloudflare blocks."
                );
              }
            } catch (scrapeErr) {
              geniusLogger.debug("Failed scraping Genius song page", scrapeErr);
            }
          }
        }
      } else if (res.status === 401) {
        geniusLogger.warn("Genius API returned 401 Unauthorized: invalid client access token.");
      }
    } catch (err) {
      geniusLogger.debug("Genius search API error", err);
    }
  }

  if (!proxyUrl && !token) {
    geniusLogger.debug(
      "No Genius Proxy URL or Access Token configured. (Native TTML tracks still provide native singer attribution)."
    );
  }

  return null;
}

/**
 * Align Genius singer sections with Spotify synced lines.
 */
export function alignGeniusSingers(
  lines: Array<{ Text: string; Singer?: string; OppositeAligned?: boolean }>,
  sections: GeniusSection[]
): boolean {
  if (!sections || sections.length === 0 || !lines || lines.length === 0) return false;

  const hasAnySinger = sections.some((s) => s.singer);
  if (!hasAnySinger) return false;

  let sectionIdx = 0;
  let lineIdx = 0;
  let currentSinger: string | null = null;
  let matchedCount = 0;
  const distinctSingers = new Set<string>();

  for (const line of lines) {
    const normLine = normalizeLine(line.Text);
    if (!normLine) continue;

    let bestMatch: { score: number; sIdx: number; lIdx: number } | null = null;

    // Look ahead in current section and next 3 sections
    for (let s = sectionIdx; s < Math.min(sections.length, sectionIdx + 4); s++) {
      const section = sections[s];
      const startL = s === sectionIdx ? lineIdx : 0;
      for (let l = startL; l < section.lines.length; l++) {
        const normGenius = normalizeLine(section.lines[l]);
        const score = computeSimilarity(normLine, normGenius);
        if (score > 0.48 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { score, sIdx: s, lIdx: l };
          if (score >= 0.82) break;
        }
      }
      if (bestMatch && bestMatch.score >= 0.82) break;
    }

    if (bestMatch) {
      sectionIdx = bestMatch.sIdx;
      lineIdx = bestMatch.lIdx + 1;
      currentSinger = sections[sectionIdx].singer;
      matchedCount++;
    }

    if (currentSinger) {
      line.Singer = currentSinger;
      distinctSingers.add(currentSinger);
    }
  }

  // If this song is a 2-person duet and OppositeAligned was not yet set,
  // align the second singer to the opposite side for a beautiful duet view!
  if (distinctSingers.size === 2) {
    const singerList = Array.from(distinctSingers);
    const secondSinger = singerList[1];
    for (const line of lines) {
      if (line.Singer === secondSinger && line.OppositeAligned === undefined) {
        line.OppositeAligned = true;
      }
    }
  }

  return matchedCount > 0;
}

/**
 * Enriches the entire lyrics object with Genius singer attributions if available.
 */
export async function enrichLyricsWithGeniusSingers(
  lyrics: any,
  title?: string,
  artist?: string,
  artists?: Array<{ name: string }>
): Promise<boolean> {
  if (!isExperimentEnabled("geniusSingerAttribution")) return false;
  if (!lyrics || !title || !artist) return false;

  // 1. If lyrics already carry singer names (e.g. from native Apple Music TTML agents), keep them
  const hasExistingSingers = (data: any): boolean => {
    if (data.Type === "Syllable" && Array.isArray(data.Content)) {
      return data.Content.some((v: any) => !!v.Singer || !!v.Lead?.Singer);
    }
    if (data.Type === "Line" && Array.isArray(data.Content)) {
      return data.Content.some((l: any) => !!l.Singer);
    }
    if (data.Type === "Static" && Array.isArray(data.Lines)) {
      return data.Lines.some((l: any) => !!l.Singer);
    }
    return false;
  };

  if (hasExistingSingers(lyrics)) {
    geniusLogger.debug("Lyrics already carry native singer attributions");
    return true;
  }

  // 2. Fetch Genius sections via proxy or search
  const sections = await fetchGeniusSections(title, artist);
  let matched = false;
  if (sections && sections.some((s) => s.singer)) {
    if (lyrics.Type === "Line" && Array.isArray(lyrics.Content)) {
      matched = alignGeniusSingers(lyrics.Content, sections);
    } else if (lyrics.Type === "Syllable" && Array.isArray(lyrics.Content)) {
      const lineAdapters = lyrics.Content.map((vocalGroup: any) => ({
        Text: (vocalGroup.Lead?.Syllables || []).map((s: any) => s.Text).join(""),
        get Singer() {
          return vocalGroup.Singer || vocalGroup.Lead?.Singer;
        },
        set Singer(val: string | undefined) {
          vocalGroup.Singer = val;
          if (vocalGroup.Lead) vocalGroup.Lead.Singer = val;
          for (const s of vocalGroup.Lead?.Syllables || []) {
            s.Singer = val;
          }
        },
        get OppositeAligned() {
          return vocalGroup.OppositeAligned;
        },
        set OppositeAligned(val: boolean | undefined) {
          vocalGroup.OppositeAligned = val;
          if (vocalGroup.Lead) vocalGroup.Lead.OppositeAligned = val;
        },
      }));
      matched = alignGeniusSingers(lineAdapters, sections);
    } else if (lyrics.Type === "Static" && Array.isArray(lyrics.Lines)) {
      matched = alignGeniusSingers(lyrics.Lines, sections);
    }
  }

  if (matched) return true;

  // 3. Fallback: only if Genius has no singer breakdown AND this is genuinely an opposite-aligned 2-artist duet
  const nonSingerBrands = /^(League of Legends|Various Artists|Original Soundtrack|Soundtrack|Cast|Riot Games Music)$/i;
  if (
    artists &&
    artists.length === 2 &&
    !nonSingerBrands.test(artists[0].name) &&
    !nonSingerBrands.test(artists[1].name)
  ) {
    const artist1 = artists[0].name;
    const artist2 = artists[1].name;
    if (lyrics.Type === "Syllable" && Array.isArray(lyrics.Content)) {
      const hasOpposite = lyrics.Content.some((v: any) => v.OppositeAligned === true);
      if (hasOpposite) {
        for (const v of lyrics.Content) {
          const s = v.OppositeAligned ? artist2 : artist1;
          v.Singer = s;
          if (v.Lead) v.Lead.Singer = s;
          for (const syl of v.Lead?.Syllables || []) {
            syl.Singer = s;
          }
        }
        geniusLogger.debug("Attributed duet singers from OppositeAligned layout and artist list", {
          artist1,
          artist2,
        });
        return true;
      }
    } else if (lyrics.Type === "Line" && Array.isArray(lyrics.Content)) {
      const hasOpposite = lyrics.Content.some((l: any) => l.OppositeAligned === true);
      if (hasOpposite) {
        for (const l of lyrics.Content) {
          l.Singer = l.OppositeAligned ? artist2 : artist1;
        }
        geniusLogger.debug("Attributed duet singers from OppositeAligned layout and artist list", {
          artist1,
          artist2,
        });
        return true;
      }
    }
  }

  return false;
}
