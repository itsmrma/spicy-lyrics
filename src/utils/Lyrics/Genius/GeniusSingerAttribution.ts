import Logger from "../../Logger.ts";
import { isExperimentEnabled } from "../../experiments.ts";

const geniusLogger = new Logger("Genius Singers");

export interface GeniusSection {
  header: string;
  singer: string | null;
  lines: string[];
}

const GENIUS_CACHE = new Map<string, { sections: GeniusSection[]; timestamp: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
    .split(/[,&/]|(?:feat\.|featuring|with)/i)[0]
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
  // Strip HTML tags and entities, translating line breaks
  const text = textOrHtml
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
      } else if (!genericHeaders.test(rawHeader)) {
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

/** Public fallback token for Genius search queries */
const GENIUS_PUBLIC_CLIENT_TOKEN =
  "Z8b6o-8hK0Tz07_eXFmR5t4h1yQ-O-7XbK8Yx_k1d8u5J-Wz0x9e8y-7_h1yQ-O";

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

  const cleanTitle = cleanSearchTitle(title);
  const cleanArt = cleanSearchArtist(artist);
  const query = `${cleanTitle} ${cleanArt}`.trim();

  // Try fetching Genius search API with user/public token or fallback search
  try {
    const searchUrl = `https://api.genius.com/search?q=${encodeURIComponent(query)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${GENIUS_PUBLIC_CLIENT_TOKEN}`,
      Accept: "application/json",
    };

    const res = await fetch(searchUrl, { headers });
    if (res.ok) {
      const data = await res.json();
      const hits = data?.response?.hits;
      if (Array.isArray(hits) && hits.length > 0) {
        // Find best matching hit
        const hit =
          hits.find(
            (h: any) =>
              h.result?.primary_artist?.name?.toLowerCase().includes(cleanArt.toLowerCase()) ||
              cleanArt.toLowerCase().includes(h.result?.primary_artist?.name?.toLowerCase() || "")
          ) || hits[0];

        const songUrl = hit?.result?.url;
        if (songUrl) {
          geniusLogger.debug("Found Genius song URL", { songUrl });
          const songRes = await fetch(songUrl);
          if (songRes.ok) {
            const html = await songRes.text();
            const sections = parseGeniusLyrics(html);
            if (sections.some((s) => s.singer)) {
              GENIUS_CACHE.set(cacheKey, { sections, timestamp: Date.now() });
              return sections;
            }
          }
        }
      }
    }
  } catch (err) {
    geniusLogger.debug("Genius search/scrape attempt error", err);
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
  artist?: string
): Promise<boolean> {
  if (!isExperimentEnabled("geniusSingerAttribution")) return false;
  if (!lyrics || !title || !artist) return false;

  const sections = await fetchGeniusSections(title, artist);
  if (!sections) return false;

  if (lyrics.Type === "Line" && Array.isArray(lyrics.Content)) {
    return alignGeniusSingers(lyrics.Content, sections);
  }

  if (lyrics.Type === "Syllable" && Array.isArray(lyrics.Content)) {
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
    return alignGeniusSingers(lineAdapters, sections);
  }

  if (lyrics.Type === "Static" && Array.isArray(lyrics.Lines)) {
    return alignGeniusSingers(lyrics.Lines, sections);
  }

  return false;
}
