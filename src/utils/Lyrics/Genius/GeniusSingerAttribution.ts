import Logger from "../../Logger.ts";
import { isExperimentEnabled } from "../../experiments.ts";
import { $geniusAccessToken, $geniusProxyUrl } from "../../stores.ts";

const geniusLogger = new Logger("Genius Singers");

export type SingerStyle = "normal" | "italic" | "bold" | "bold-italic";

export interface GeniusLine {
  text: string;
  singer: string | null;
  style: SingerStyle;
}

export interface GeniusSection {
  header: string;
  singer: string | null;
  lines: GeniusLine[];
  styleMap?: Map<SingerStyle, string>;
}

const GENIUS_CACHE = new Map<string, { sections: GeniusSection[]; timestamp: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const GENIUS_STORAGE_PREFIX = "spicy-lyrics:genius-cache:v2:";
const LEGACY_STORAGE_PREFIX = "spicy-lyrics:genius-cache:";

export function clearGeniusCache(): void {
  GENIUS_CACHE.clear();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith(GENIUS_STORAGE_PREFIX) || key.startsWith(LEGACY_STORAGE_PREFIX))) {
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

const genericHeaders =
  /^(Intro|Outro|Verse|Chorus|Bridge|Hook|Pre-Chorus|Post-Chorus|Drop|Break|Interlude|Refrain|Instrumental|Solo|Part\s+[0-9IVXLCDM]+)/i;

function cleanName(n: string): string {
  return n
    .replace(/<[^>]+>/g, "")
    .replace(/[*_~`]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/^[,\s&+/-]+|[,\s&+/-]+$/g, "")
    .trim();
}

/**
 * Extracts singers and associates styles (normal, italic, bold) from section headers.
 * Following Genius convention:
 * 1st artist -> normal, 2nd artist -> italic, 3rd artist -> bold, 4th -> bold-italic
 */
export function parseSingerHeader(rawHeader: string): {
  sectionSinger: string | null;
  styleMap: Map<SingerStyle, string>;
  singers: string[];
} {
  const styleMap = new Map<SingerStyle, string>();
  let singerString = "";

  if (rawHeader.includes(":")) {
    singerString = rawHeader.slice(rawHeader.indexOf(":") + 1).trim();
  } else {
    const cleanH = cleanName(rawHeader);
    if (!genericHeaders.test(cleanH) && !/lyrics|가사|歌詞/i.test(cleanH)) {
      singerString = rawHeader.trim();
    }
  }

  if (!singerString) {
    return { sectionSinger: null, styleMap, singers: [] };
  }

  const hasHtml = /<\/?(?:i|em|b|strong)\b/i.test(singerString);
  const hasMd = /(?:\*{1,3}|_{1,3})[^*_]+(?:\*{1,3}|_{1,3})/.test(singerString);

  if (hasHtml || hasMd) {
    // 1. Extract bold-italic
    const biMatches = [
      ...singerString.matchAll(/<(?:b|strong)>\s*<(?:i|em)>([\s\S]*?)<\/(?:i|em)>\s*<\/(?:b|strong)>/gi),
      ...singerString.matchAll(/<(?:i|em)>\s*<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>\s*<\/(?:i|em)>/gi),
      ...singerString.matchAll(/\*{3}([^*]+)\*{3}/g),
    ];
    for (const m of biMatches) {
      const name = cleanName(m[1]);
      if (name && !styleMap.has("bold-italic")) styleMap.set("bold-italic", name);
    }

    // 2. Extract bold
    const boldMatches = [
      ...singerString.matchAll(/<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi),
      ...singerString.matchAll(/\*{2}([^*]+)\*{2}/g),
    ];
    for (const m of boldMatches) {
      const name = cleanName(m[1]);
      if (name && !styleMap.has("bold") && styleMap.get("bold-italic") !== name) {
        styleMap.set("bold", name);
      }
    }

    // 3. Extract italic
    const italicMatches = [
      ...singerString.matchAll(/<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>/gi),
      ...singerString.matchAll(/(?<!\*)\*([^*]+)\*(?!\*)/g),
    ];
    for (const m of italicMatches) {
      const name = cleanName(m[1]);
      if (name && !styleMap.has("italic") && styleMap.get("bold-italic") !== name) {
        styleMap.set("italic", name);
      }
    }

    // 4. Remaining normal text
    const stripped = singerString
      .replace(/<(?:b|strong)>\s*<(?:i|em)>[\s\S]*?<\/(?:i|em)>\s*<\/(?:b|strong)>/gi, "")
      .replace(/<(?:i|em)>\s*<(?:b|strong)>[\s\S]*?<\/(?:b|strong)>\s*<\/(?:i|em)>/gi, "")
      .replace(/<(?:b|strong)\b[^>]*>[\s\S]*?<\/(?:b|strong)>/gi, "")
      .replace(/<(?:i|em)\b[^>]*>[\s\S]*?<\/(?:i|em)>/gi, "")
      .replace(/\*{1,3}[^*]+\*{1,3}/g, "");

    const normalCandidates = stripped
      .split(/\s*[,&+/]\s*|\s+(?:feat\.|ft\.|with|and)\s+/i)
      .map(cleanName)
      .filter((n) => n.length > 0 && !/^(and|with|feat|ft|all|both)$/i.test(n));

    if (normalCandidates.length > 0 && !styleMap.has("normal")) {
      styleMap.set("normal", normalCandidates[0]);
    }
  }

  // Positional fallback according to Genius multi-singer convention:
  // 1st artist -> normal, 2nd artist -> italic, 3rd artist -> bold, 4th artist -> bold-italic
  const cleanList = singerString
    .replace(/<[^>]+>/g, "")
    .replace(/[*_~`]/g, "")
    .split(/\s*[,&+/]\s*|\s+(?:feat\.|ft\.|with|and)\s+/i)
    .map(cleanName)
    .filter((n) => n.length > 0 && !/^(and|with|feat|ft)$/i.test(n));

  const stylesOrder: SingerStyle[] = ["normal", "italic", "bold", "bold-italic"];
  cleanList.forEach((artist, idx) => {
    const styleKey = stylesOrder[idx] || "normal";
    if (!styleMap.has(styleKey)) {
      styleMap.set(styleKey, artist);
    }
  });

  const sectionSinger = cleanList.length > 0 ? cleanList.join(" & ") : cleanName(singerString);
  return { sectionSinger: sectionSinger || null, styleMap, singers: cleanList };
}

/**
 * Parses raw Genius lyrics text or HTML containing bracketed section/singer tags:
 * e.g. [Verse 1: Drake, <i>21 Savage</i> & <b>Travis Scott</b>], [Chorus: All]
 * Retains formatting styles (normal, italic, bold) to attribute individual vocalists per line.
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
      content = containerMatches.map((m) => m[1]).join("\n<br/>\n");
    }
  }

  interface Segment {
    text: string;
    isItalic: boolean;
    isBold: boolean;
  }

  let inItalic = 0;
  let inBold = 0;
  let currentSegments: Segment[] = [];
  const rawLineObjects: Array<{ segments: Segment[]; fullText: string }> = [];

  const tokenRegex = /(<br\s*\/?>|\r?\n)|(<\/?(?:i|em|b|strong)\b[^>]*>)|(<[^>]+>)|([^<>\r\n]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(content)) !== null) {
    if (match[1]) {
      if (currentSegments.length > 0) {
        const fullText = currentSegments.map((s) => s.text).join("").trim();
        if (fullText.length > 0) {
          rawLineObjects.push({ segments: [...currentSegments], fullText });
        }
        currentSegments = [];
      }
    } else if (match[2]) {
      const tag = match[2].toLowerCase();
      if (tag.startsWith("<i") || tag.startsWith("<em")) {
        inItalic++;
      } else if (tag.startsWith("</i") || tag.startsWith("</em")) {
        inItalic = Math.max(0, inItalic - 1);
      } else if (tag.startsWith("<b") || tag.startsWith("<strong")) {
        inBold++;
      } else if (tag.startsWith("</b") || tag.startsWith("</strong")) {
        inBold = Math.max(0, inBold - 1);
      }
    } else if (match[4]) {
      const textChunk = match[4]
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ");

      if (textChunk.length > 0) {
        currentSegments.push({
          text: textChunk,
          isItalic: inItalic > 0,
          isBold: inBold > 0,
        });
      }
    }
  }

  if (currentSegments.length > 0) {
    const fullText = currentSegments.map((s) => s.text).join("").trim();
    if (fullText.length > 0) {
      rawLineObjects.push({ segments: [...currentSegments], fullText });
    }
  }

  const sections: GeniusSection[] = [];
  let currentSection: GeniusSection = {
    header: "Intro",
    singer: null,
    lines: [],
    styleMap: new Map(),
  };

  const sectionRegex = /^\[([^\]]+)\]$/;

  for (const { segments, fullText } of rawLineObjects) {
    const headerMatch = sectionRegex.exec(fullText);
    if (headerMatch) {
      if (currentSection.lines.length > 0 || currentSection.singer) {
        sections.push(currentSection);
      }
      const rawHeader = headerMatch[1].trim();
      const { sectionSinger, styleMap } = parseSingerHeader(rawHeader);

      currentSection = {
        header: cleanName(rawHeader),
        singer: sectionSinger,
        lines: [],
        styleMap,
      };
    } else {
      let lineStyle: SingerStyle = "normal";
      let cleanText = fullText;

      if (/^\*{3}[^*]+\*{3}$/.test(fullText)) {
        lineStyle = "bold-italic";
        cleanText = fullText.slice(3, -3).trim();
      } else if (/^\*{2}[^*]+\*{2}$/.test(fullText)) {
        lineStyle = "bold";
        cleanText = fullText.slice(2, -2).trim();
      } else if (/^\*[^*]+\*$/.test(fullText)) {
        lineStyle = "italic";
        cleanText = fullText.slice(1, -1).trim();
      } else {
        let italicChars = 0;
        let boldChars = 0;
        let boldItalicChars = 0;
        let normalChars = 0;

        const nonParenSegments = segments.filter((s) => !/^\([^)]*\)$/.test(s.text.trim()));
        const targetSegments = nonParenSegments.length > 0 ? nonParenSegments : segments;

        for (const s of targetSegments) {
          const len = s.text.trim().length;
          if (len === 0) continue;
          if (s.isBold && s.isItalic) boldItalicChars += len;
          else if (s.isBold) boldChars += len;
          else if (s.isItalic) italicChars += len;
          else normalChars += len;
        }

        if (boldItalicChars > 0 && boldItalicChars >= boldChars && boldItalicChars >= italicChars) {
          lineStyle = "bold-italic";
        } else if (boldChars > italicChars && boldChars > normalChars) {
          lineStyle = "bold";
        } else if (italicChars > boldChars && italicChars > normalChars) {
          lineStyle = "italic";
        } else {
          lineStyle = "normal";
        }
      }

      let lineSinger: string | null = null;
      const inlineMatch = /^([A-Za-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\s&]+):\s*(.+)$/.exec(
        cleanText
      );
      if (inlineMatch && !cleanText.startsWith("http")) {
        const prefix = inlineMatch[1].trim();
        if (!/^(http|https|verse|chorus|bridge|hook)/i.test(prefix)) {
          lineSinger = prefix;
          cleanText = inlineMatch[2].trim();
        }
      }

      if (!lineSinger && currentSection.styleMap && currentSection.styleMap.size > 0) {
        lineSinger =
          currentSection.styleMap.get(lineStyle) ||
          currentSection.styleMap.get("normal") ||
          currentSection.singer;
      } else if (!lineSinger) {
        lineSinger = currentSection.singer;
      }

      currentSection.lines.push({
        text: cleanText,
        singer: lineSinger,
        style: lineStyle,
      });
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
      if (
        parsed &&
        Array.isArray(parsed.sections) &&
        Date.now() - parsed.timestamp < CACHE_TTL_MS &&
        parsed.sections.every(
          (s: any) => !s.lines || s.lines.length === 0 || typeof s.lines[0] !== "string"
        )
      ) {
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
  lines: Array<{
    Text: string;
    Singer?: string;
    SingerStyle?: SingerStyle;
    OppositeAligned?: boolean;
  }>,
  sections: GeniusSection[]
): boolean {
  if (!sections || sections.length === 0 || !lines || lines.length === 0) return false;

  const hasAnySinger = sections.some((s) => s.singer || s.lines.some((l) => l.singer));
  if (!hasAnySinger) return false;

  let sectionIdx = 0;
  let lineIdx = 0;
  let currentSinger: string | null = null;
  let currentStyle: SingerStyle = "normal";
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
        const normGenius = normalizeLine(section.lines[l].text);
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
      const matchedLine = sections[sectionIdx].lines[bestMatch.lIdx];
      currentSinger = matchedLine.singer || sections[sectionIdx].singer;
      currentStyle = matchedLine.style || "normal";
      matchedCount++;
    }

    if (currentSinger) {
      line.Singer = currentSinger;
      line.SingerStyle = currentStyle;
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
  if (sections && sections.some((s) => s.singer || s.lines.some((l) => l.singer))) {
    if (lyrics.Type === "Line" && Array.isArray(lyrics.Content)) {
      matched = alignGeniusSingers(lyrics.Content, sections);
    } else if (lyrics.Type === "Syllable" && Array.isArray(lyrics.Content)) {
      const lineAdapters: any[] = [];
      for (const vocalGroup of lyrics.Content) {
        lineAdapters.push({
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
          get SingerStyle() {
            return vocalGroup.SingerStyle || vocalGroup.Lead?.SingerStyle;
          },
          set SingerStyle(val: SingerStyle | undefined) {
            vocalGroup.SingerStyle = val;
            if (vocalGroup.Lead) vocalGroup.Lead.SingerStyle = val;
            for (const s of vocalGroup.Lead?.Syllables || []) {
              s.SingerStyle = val;
            }
          },
          get OppositeAligned() {
            return vocalGroup.OppositeAligned;
          },
          set OppositeAligned(val: boolean | undefined) {
            vocalGroup.OppositeAligned = val;
            if (vocalGroup.Lead) vocalGroup.Lead.OppositeAligned = val;
          },
        });

        if (Array.isArray(vocalGroup.Background)) {
          for (const bg of vocalGroup.Background) {
            lineAdapters.push({
              Text: (bg.Syllables || []).map((s: any) => s.Text).join(""),
              get Singer() {
                return bg.Singer;
              },
              set Singer(val: string | undefined) {
                bg.Singer = val;
                for (const s of bg.Syllables || []) {
                  s.Singer = val;
                }
              },
              get SingerStyle() {
                return bg.SingerStyle;
              },
              set SingerStyle(val: SingerStyle | undefined) {
                bg.SingerStyle = val;
                for (const s of bg.Syllables || []) {
                  s.SingerStyle = val;
                }
              },
              get OppositeAligned() {
                return bg.OppositeAligned;
              },
              set OppositeAligned(val: boolean | undefined) {
                bg.OppositeAligned = val;
              },
            });
          }
        }
      }
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
