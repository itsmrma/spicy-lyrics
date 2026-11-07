import Logger from "../../Logger.ts";
import { isExperimentEnabled } from "../../experiments.ts";
import { $geniusAccessToken, $geniusProxyUrl } from "../../stores.ts";

const geniusLogger = new Logger("Genius Singers");

export type SingerStyle =
  | "normal"
  | "italic"
  | "bold"
  | "bold-italic"
  | "asterisk"
  | "paren";

export interface GeniusLine {
  text: string;
  mainText?: string;
  parenText?: string;
  singer: string | null;
  parenSinger?: string | null;
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
const GENIUS_STORAGE_PREFIX = "spicy-lyrics:genius-cache:v3:";
const LEGACY_STORAGE_PREFIX = "spicy-lyrics:genius-cache:";

function purgeLegacyStorageCache(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key &&
        key.startsWith(LEGACY_STORAGE_PREFIX) &&
        !key.startsWith(GENIUS_STORAGE_PREFIX)
      ) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {}
}

purgeLegacyStorageCache();

export function clearGeniusCache(): void {
  GENIUS_CACHE.clear();
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LEGACY_STORAGE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {}
}

$geniusProxyUrl.listen(() => clearGeniusCache());
$geniusAccessToken.listen(() => clearGeniusCache());

function decodeHtmlEntities(str: string): string {
  if (!str) return "";
  return str
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#34;|&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : _;
    })
    .replace(/[\u2005\u205f\u00a0]/g, " ");
}

function cleanName(n: string): string {
  return decodeHtmlEntities(n)
    .replace(/<[^>]+>/g, "")
    .replace(/[*_~`]/g, "")
    .replace(/^[,\s&+/()-]+|[,\s&+/()-]+$/g, "")
    .trim();
}

function cleanHeaderTitle(n: string): string {
  return decodeHtmlEntities(n)
    .replace(/<[^>]+>/g, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Merge singer names while preserving order and deduplicating case-insensitively */
export function mergeSingerNames(names: Array<string | null | undefined>): string | null {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of names) {
    if (!raw) continue;
    const parts = raw.split(/\s*[,&+/]\s*|\s+(?:and|with|feat\.?|ft\.?)\s+/i);
    for (const p of parts) {
      const c = cleanName(p);
      if (!c || /^(and|with|feat|ft)$/i.test(c)) continue;
      const key = c.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(c);
      }
    }
  }
  return result.length > 0 ? result.join(" & ") : null;
}

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

function stripParensText(line: string): string {
  const stripped = (line || "")
    .replace(/\([^)]*\)|（[^）]*）/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || line;
}

function bigramDice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    counts.set(bg, (counts.get(bg) || 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const c = counts.get(bg) || 0;
    if (c > 0) {
      shared++;
      counts.set(bg, c - 1);
    }
  }
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/** Compute similarity between two lyric lines (handles clauses, CJK spacing, and word tokens) */
export function computeSimilarity(aRaw: string, bRaw: string): number {
  const a = normalizeLine(aRaw);
  const b = normalizeLine(bRaw);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aCompact = a.replace(/\s+/g, "");
  const bCompact = b.replace(/\s+/g, "");
  if (aCompact === bCompact) return 1;

  const minLen = Math.min(aCompact.length, bCompact.length);
  const maxLen = Math.max(aCompact.length, bCompact.length);

  // Substring / clause containment check
  let subScore = 0;
  if (aCompact.includes(bCompact) || bCompact.includes(aCompact)) {
    const ratio = minLen / maxLen;
    const minWords = Math.min(a.split(" ").length, b.split(" ").length);
    if (minLen >= 5 || (minLen >= 4 && minWords >= 2)) {
      subScore = 0.72 + 0.28 * ratio;
    } else {
      subScore = ratio;
    }
  }

  // Word-level Jaccard & containment
  const wordsA = a.split(" ").filter(Boolean);
  const wordsB = b.split(" ").filter(Boolean);
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let inter = 0;
  for (const w of setA) {
    if (setB.has(w)) inter++;
  }
  const union = new Set([...setA, ...setB]).size;
  const jaccard = union > 0 ? inter / union : 0;

  const minSet = Math.min(setA.size, setB.size);
  const wordOverlap = minSet >= 2 ? inter / minSet : jaccard;
  const wordScore =
    minSet >= 2 && wordOverlap >= 0.8
      ? Math.max(jaccard, 0.7 * wordOverlap + 0.3 * jaccard)
      : jaccard;

  // Bigram Dice on compact string (handles CJK spacing differences & contractions)
  const dice = bigramDice(aCompact, bCompact);

  return Math.max(subScore, wordScore, dice * 0.95);
}

const genericHeaders =
  /^(Intro|Outro|Verse|Chorus|Bridge|Hook|Pre-Chorus|Post-Chorus|Post-Bridge|Drop|Break|Interlude|Refrain|Instrumental|Solo|Skit|Part\s+[0-9IVXLCDM]+)/i;

function getBaseSectionType(header: string): string | null {
  const clean = cleanHeaderTitle(header);
  const m = genericHeaders.exec(clean);
  return m ? m[1].toLowerCase() : null;
}

function isMetadataHeader(header: string): boolean {
  const clean = cleanHeaderTitle(header);
  return (
    /가사|歌詞|lyrics|romanized|english translation|traduzione|traducción|paroles/i.test(clean) ||
    /^(produced|written|composed|arranged|mixed|mastered)\s+by/i.test(clean)
  );
}

/**
 * Extracts singers and associates styles (normal, italic, bold, bold-italic, asterisk, paren)
 * from Genius section headers.
 */
export function parseSingerHeader(rawHeader: string): {
  sectionSinger: string | null;
  styleMap: Map<SingerStyle, string>;
  singers: string[];
  hasExplicitStyles: boolean;
} {
  const styleMap = new Map<SingerStyle, string>();
  if (isMetadataHeader(rawHeader)) {
    return { sectionSinger: null, styleMap, singers: [], hasExplicitStyles: false };
  }

  let singerString = "";
  const plainHeader = rawHeader.replace(/<[^>]+>/g, "").trim();

  if (plainHeader.includes(":")) {
    let colonIdx = -1;
    let inTag = false;
    for (let i = 0; i < rawHeader.length; i++) {
      if (rawHeader[i] === "<") inTag = true;
      else if (rawHeader[i] === ">") inTag = false;
      else if (!inTag && rawHeader[i] === ":") {
        colonIdx = i;
        break;
      }
    }
    if (colonIdx !== -1) {
      singerString = rawHeader.slice(colonIdx + 1).trim();
    }
  } else if (!genericHeaders.test(cleanHeaderTitle(rawHeader))) {
    singerString = rawHeader.trim();
  }

  if (!singerString) {
    return { sectionSinger: null, styleMap, singers: [], hasExplicitStyles: false };
  }

  const addStyleSinger = (style: SingerStyle, rawName: string) => {
    const merged = mergeSingerNames([styleMap.get(style), rawName]);
    if (merged) styleMap.set(style, merged);
  };

  const hasHtml = /<\/?(?:i|em|b|strong)\b/i.test(singerString);
  const hasAsterisk = /\*[^*]+\*/.test(singerString);
  const hasParen = /\([^)]+\)/.test(singerString);
  const hasExplicitStyles = hasHtml || hasAsterisk || hasParen;

  if (hasExplicitStyles) {
    let working = singerString;

    // 1. Extract bold-italic HTML or ***...***
    working = working.replace(
      /<(?:b|strong)\b[^>]*>\s*<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>\s*<\/(?:b|strong)>/gi,
      (_, inner) => {
        addStyleSinger("bold-italic", inner);
        return " ";
      }
    );
    working = working.replace(
      /<(?:i|em)\b[^>]*>\s*<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>\s*<\/(?:i|em)>/gi,
      (_, inner) => {
        addStyleSinger("bold-italic", inner);
        return " ";
      }
    );
    working = working.replace(/\*{3}([^*]+)\*{3}/g, (_, inner) => {
      addStyleSinger("bold-italic", inner);
      return " ";
    });

    // 2. Extract bold HTML or **...**
    working = working.replace(/<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, (_, inner) => {
      addStyleSinger("bold", inner);
      return " ";
    });
    working = working.replace(/\*{2}([^*]+)\*{2}/g, (_, inner) => {
      addStyleSinger("bold", inner);
      return " ";
    });

    // 3. Extract italic HTML
    working = working.replace(/<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, (_, inner) => {
      addStyleSinger("italic", inner);
      return " ";
    });

    // 4. Extract single *...* (asterisk style if HTML is also used, otherwise italic)
    working = working.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, inner) => {
      addStyleSinger(hasHtml ? "asterisk" : "italic", inner);
      return " ";
    });

    // 5. Extract parenthetical (Artist) in header
    working = working.replace(/\(([^)]+)\)/g, (_, inner) => {
      addStyleSinger("paren", inner);
      return " ";
    });

    // 6. Remaining normal text
    const normalMerged = mergeSingerNames([working]);
    if (normalMerged) {
      addStyleSinger("normal", normalMerged);
    }
  }

  const allSingersMerged = mergeSingerNames([
    singerString.replace(/<[^>]+>/g, " ").replace(/[*()]/g, " "),
  ]);
  const cleanList = allSingersMerged ? allSingersMerged.split(" & ") : [];

  if (!hasExplicitStyles && cleanList.length > 0) {
    styleMap.set("normal", cleanList.join(" & "));
  }

  return {
    sectionSinger: allSingersMerged,
    styleMap,
    singers: cleanList,
    hasExplicitStyles,
  };
}

/**
 * Parses raw Genius lyrics text or HTML containing bracketed section/singer tags:
 * e.g. [Verse 1: Drake, <i>21 Savage</i> & <b>Travis Scott</b>], [Chorus: All]
 * Retains formatting styles (normal, italic, bold, bold-italic, asterisk, paren)
 * to attribute individual vocalists per line.
 */
export function parseGeniusLyrics(textOrHtml: string): GeniusSection[] {
  let content = textOrHtml;
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

  const docHasHtmlFormatting = /<\/?(?:i|em|b|strong)\b/i.test(content);

  interface Segment {
    text: string;
    isItalic: boolean;
    isBold: boolean;
  }

  let inItalic = 0;
  let inBold = 0;
  let currentSegments: Segment[] = [];
  const rawLineObjects: Array<{ segments: Segment[]; fullText: string; styledHtml: string }> = [];

  const flushCurrentLine = () => {
    if (currentSegments.length === 0) return;
    const fullText = currentSegments.map((s) => s.text).join("").trim();
    if (fullText.length > 0) {
      const isBracketed = /^\[([^\]]+)\]$/.test(fullText);
      const nonEmptySegs = currentSegments.filter((s) => s.text.trim().length > 0);
      const allBold = isBracketed && nonEmptySegs.length > 0 && nonEmptySegs.every((s) => s.isBold);
      const allItalic =
        isBracketed && nonEmptySegs.length > 0 && nonEmptySegs.every((s) => s.isItalic);

      const styledHtml = currentSegments
        .map((s) => {
          const b = s.isBold && !allBold;
          const it = s.isItalic && !allItalic;
          if (b && it) return `<b><i>${s.text}</i></b>`;
          if (b) return `<b>${s.text}</b>`;
          if (it) return `<i>${s.text}</i>`;
          return s.text;
        })
        .join("")
        .trim();

      rawLineObjects.push({ segments: [...currentSegments], fullText, styledHtml });
      if (isBracketed) {
        inItalic = 0;
        inBold = 0;
      }
    }
    currentSegments = [];
  };

  const tokenRegex = /(<br\s*\/?>|\r?\n)|(<\/?(?:i|em|b|strong)\b[^>]*>)|(<[^>]+>)|([^<>\r\n]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(content)) !== null) {
    if (match[1]) {
      flushCurrentLine();
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
      const textChunk = decodeHtmlEntities(match[4]);
      if (textChunk.length > 0) {
        currentSegments.push({
          text: textChunk,
          isItalic: inItalic > 0,
          isBold: inBold > 0,
        });
      }
    }
  }
  flushCurrentLine();

  interface RawSection {
    header: string;
    singer: string | null;
    styleMap: Map<SingerStyle, string>;
    singers: string[];
    hasExplicitStyles: boolean;
    rawLines: Array<{ segments: Segment[]; fullText: string }>;
  }

  const rawSections: RawSection[] = [];
  let currentRawSection: RawSection = {
    header: "Intro",
    singer: null,
    styleMap: new Map(),
    singers: [],
    hasExplicitStyles: false,
    rawLines: [],
  };

  const sectionRegex = /^\[([^\]]+)\]$/;

  for (const { segments, fullText, styledHtml } of rawLineObjects) {
    const headerMatch = sectionRegex.exec(fullText);
    if (headerMatch) {
      const innerPlain = headerMatch[1].trim();
      if (isMetadataHeader(innerPlain)) {
        continue;
      }
      if (currentRawSection.rawLines.length > 0 || currentRawSection.singer) {
        rawSections.push(currentRawSection);
      }
      const openIdx = styledHtml.indexOf("[");
      const closeIdx = styledHtml.lastIndexOf("]");
      const innerStyled =
        openIdx !== -1 && closeIdx > openIdx
          ? styledHtml.slice(openIdx + 1, closeIdx).trim()
          : innerPlain;

      const { sectionSinger, styleMap, singers, hasExplicitStyles } =
        parseSingerHeader(innerStyled);
      currentRawSection = {
        header: cleanHeaderTitle(innerPlain),
        singer: sectionSinger,
        styleMap,
        singers,
        hasExplicitStyles,
        rawLines: [],
      };
    } else {
      currentRawSection.rawLines.push({ segments, fullText });
    }
  }

  if (currentRawSection.rawLines.length > 0 || currentRawSection.singer) {
    rawSections.push(currentRawSection);
  }

  // Inherit section singers for generic repeated headers without colons (e.g., [Chorus] after [Chorus: Jin])
  const sectionTypeMemory = new Map<
    string,
    {
      singer: string;
      styleMap: Map<SingerStyle, string>;
      singers: string[];
      hasExplicitStyles: boolean;
    }
  >();
  for (const sec of rawSections) {
    const baseType = getBaseSectionType(sec.header);
    if (sec.singer && baseType) {
      if (!sectionTypeMemory.has(baseType)) {
        sectionTypeMemory.set(baseType, {
          singer: sec.singer,
          styleMap: new Map(sec.styleMap),
          singers: [...sec.singers],
          hasExplicitStyles: sec.hasExplicitStyles,
        });
      }
    } else if (!sec.singer && baseType && sectionTypeMemory.has(baseType)) {
      const mem = sectionTypeMemory.get(baseType)!;
      sec.singer = mem.singer;
      sec.styleMap = new Map(mem.styleMap);
      sec.singers = [...mem.singers];
      sec.hasExplicitStyles = mem.hasExplicitStyles;
    }
  }

  const sections: GeniusSection[] = [];

  for (const sec of rawSections) {
    const sectionHasStyledLines = sec.rawLines.some(
      ({ segments, fullText }) =>
        segments.some((s) => (s.isItalic || s.isBold) && /[\p{L}\p{N}]/u.test(s.text)) ||
        /\*{1,3}[^*]+\*{1,3}/.test(fullText)
    );

    if (!sec.hasExplicitStyles && sectionHasStyledLines && sec.singers.length > 1) {
      const stylesOrder: SingerStyle[] = ["normal", "italic", "bold", "bold-italic"];
      sec.styleMap.clear();
      sec.singers.forEach((artist, idx) => {
        const key = stylesOrder[idx] || "normal";
        if (!sec.styleMap.has(key)) sec.styleMap.set(key, artist);
      });
    }

    const parsedLines: GeniusLine[] = [];

    for (const { segments, fullText } of sec.rawLines) {
      interface StyledRun {
        text: string;
        style: SingerStyle;
        inParen: boolean;
      }

      const runs: StyledRun[] = [];
      let parenDepth = 0;

      const pushCharsWithParens = (str: string, baseStyle: SingerStyle) => {
        let buf = "";
        let curParen = parenDepth > 0;
        for (const ch of str) {
          if (ch === "(" || ch === "（") {
            if (buf) {
              runs.push({ text: buf, style: baseStyle, inParen: curParen });
              buf = "";
            }
            parenDepth++;
            curParen = true;
          } else if (ch === ")" || ch === "）") {
            if (buf) {
              runs.push({ text: buf, style: baseStyle, inParen: curParen });
              buf = "";
            }
            parenDepth = Math.max(0, parenDepth - 1);
            curParen = parenDepth > 0;
          } else {
            buf += ch;
          }
        }
        if (buf) {
          runs.push({ text: buf, style: baseStyle, inParen: curParen });
        }
      };

      for (const seg of segments) {
        let segStyle: SingerStyle = "normal";
        if (seg.isBold && seg.isItalic) segStyle = "bold-italic";
        else if (seg.isBold) segStyle = "bold";
        else if (seg.isItalic) segStyle = "italic";

        const mdRegex = /(\*{3}[^*]+\*{3}|\*{2}[^*]+\*{2}|\*[^*]+\*)/g;
        let lastIdx = 0;
        let m: RegExpExecArray | null;
        while ((m = mdRegex.exec(seg.text)) !== null) {
          if (m.index > lastIdx) {
            pushCharsWithParens(seg.text.slice(lastIdx, m.index), segStyle);
          }
          const tok = m[1];
          if (tok.startsWith("***")) {
            pushCharsWithParens(tok.slice(3, -3), "bold-italic");
          } else if (tok.startsWith("**")) {
            pushCharsWithParens(tok.slice(2, -2), "bold");
          } else {
            pushCharsWithParens(
              tok.slice(1, -1),
              docHasHtmlFormatting ? "asterisk" : "italic"
            );
          }
          lastIdx = m.index + tok.length;
        }
        if (lastIdx < seg.text.length) {
          pushCharsWithParens(seg.text.slice(lastIdx), segStyle);
        }
      }

      const mainRuns = runs.filter((r) => !r.inParen);
      const parenRuns = runs.filter((r) => r.inParen);

      const mainTextRaw = mainRuns.map((r) => r.text).join("").replace(/\s+/g, " ").trim();
      const parenTextRaw = parenRuns.map((r) => r.text).join(" ").replace(/\s+/g, " ").trim();
      const cleanFullText = fullText.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1").trim();

      let cleanText = cleanFullText;
      let explicitLineSinger: string | null = null;
      const inlineMatch =
        /^([A-Za-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\s&]+):\s*(.+)$/.exec(
          cleanText
        );
      if (inlineMatch && !cleanText.startsWith("http")) {
        const prefix = inlineMatch[1].trim();
        if (
          !/^(http|https|verse|chorus|bridge|hook|intro|outro|pre-chorus|post-chorus|refrain)/i.test(
            prefix
          )
        ) {
          explicitLineSinger = prefix;
          cleanText = inlineMatch[2].trim();
        }
      }

      const resolveRunsSinger = (
        targetRuns: StyledRun[],
        isParenGroup: boolean
      ): { singer: string | null; primaryStyle: SingerStyle } => {
        const activeStyles: SingerStyle[] = [];
        for (const r of targetRuns) {
          if (!/[\p{L}\p{N}]/u.test(r.text)) continue;
          if (!activeStyles.includes(r.style)) {
            activeStyles.push(r.style);
          }
        }

        if (activeStyles.length === 0) {
          return { singer: null, primaryStyle: "normal" };
        }

        const primaryStyle = activeStyles[0];
        if (!sec.styleMap || sec.styleMap.size === 0) {
          return { singer: sec.singer, primaryStyle };
        }

        const resolvedNames: string[] = [];
        for (const st of activeStyles) {
          if (isParenGroup && st === "normal" && sec.styleMap.has("paren")) {
            resolvedNames.push(sec.styleMap.get("paren")!);
          } else if (sec.styleMap.has(st)) {
            resolvedNames.push(sec.styleMap.get(st)!);
          } else if (st === "bold-italic") {
            const b = sec.styleMap.get("bold");
            const it = sec.styleMap.get("italic");
            if (b && it) {
              resolvedNames.push(`${b} & ${it}`);
            } else if (b || it) {
              resolvedNames.push((b || it)!);
            }
          }
        }

        const merged = mergeSingerNames(resolvedNames);
        if (merged) {
          return { singer: merged, primaryStyle };
        }

        return {
          singer: sec.styleMap.get("normal") || sec.singer,
          primaryStyle,
        };
      };

      let lineSinger: string | null = explicitLineSinger;
      let lineStyle: SingerStyle = "normal";

      const mainResolved = resolveRunsSinger(mainRuns, false);
      const parenResolved = resolveRunsSinger(parenRuns, true);

      if (!lineSinger) {
        if (mainResolved.singer) {
          lineSinger = mainResolved.singer;
          lineStyle = mainResolved.primaryStyle;
        } else if (parenResolved.singer) {
          lineSinger = parenResolved.singer;
          lineStyle = parenResolved.primaryStyle;
        } else {
          lineSinger = sec.singer;
        }
      }
      const parenSinger = parenResolved.singer || lineSinger;

      parsedLines.push({
        text: cleanText,
        mainText: mainTextRaw || parenTextRaw || cleanText,
        parenText: parenTextRaw || undefined,
        singer: lineSinger,
        parenSinger,
        style: lineStyle,
      });
    }

    sections.push({
      header: sec.header,
      singer: sec.singer,
      lines: parsedLines,
      styleMap: sec.styleMap,
    });
  }

  return sections;
}

function buildGeniusSlugPath(artist: string, title: string): string | null {
  const combined = `${artist} ${title}`
    .replace(/&/g, " and ")
    .replace(/['’"“”.,!?()[\]{}]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (!combined) return null;
  return `/${combined.charAt(0).toUpperCase()}${combined.slice(1)}-lyrics`;
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
        if (typeof data.html === "string") {
          sections = parseGeniusLyrics(data.html);
        } else if (typeof data.lyrics === "string") {
          sections = parseGeniusLyrics(data.lyrics);
        } else if (Array.isArray(data.sections)) {
          sections = data.sections;
        }
        if (sections && sections.some((s) => s.singer || s.lines.some((l) => l.singer))) {
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

  const tryScrapeSongPath = async (songUrlOrPath: string): Promise<GeniusSection[] | null> => {
    let pathPart = songUrlOrPath;
    try {
      if (songUrlOrPath.startsWith("http")) {
        pathPart = new URL(songUrlOrPath).pathname;
      }
    } catch {}

    const candidateUrls = songUrlOrPath.startsWith("http")
      ? [songUrlOrPath, `https://dumb.bloat.cat${pathPart}`]
      : [`https://genius.com${pathPart}`, `https://dumb.bloat.cat${pathPart}`];

    for (const url of candidateUrls) {
      try {
        const songRes = await fetch(url);
        if (songRes.ok) {
          const html = await songRes.text();
          const sections = parseGeniusLyrics(html);
          if (sections.some((s) => s.singer || s.lines.some((l) => l.singer))) {
            return sections;
          }
        }
      } catch {}
    }
    return null;
  };

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
                cleanArt
                  .toLowerCase()
                  .includes(h.result?.primary_artist?.name?.toLowerCase() || "")
            ) || hits[0];

          const songUrl = hit?.result?.url;
          if (songUrl) {
            geniusLogger.debug("Found Genius song URL", { songUrl });
            const sections = await tryScrapeSongPath(songUrl);
            if (sections) {
              saveToCache(sections);
              return sections;
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

  // 3. Direct slug lookup fallback (works for standard artist-title slugs without token)
  const slugPath = buildGeniusSlugPath(cleanArt, cleanTitle);
  if (slugPath) {
    const sections = await tryScrapeSongPath(slugPath);
    if (sections) {
      saveToCache(sections);
      return sections;
    }
  }

  if (!proxyUrl && !token) {
    geniusLogger.debug(
      "No Genius Proxy URL or Access Token configured. (Native TTML tracks still provide native singer attribution)."
    );
  }

  return null;
}

function pairSimilarity(spotifyText: string, gMain: string, gFull: string): number {
  const sFull = normalizeLine(spotifyText);
  const sMain = normalizeLine(stripParensText(spotifyText));
  if (!sFull) return 0;

  return Math.max(
    computeSimilarity(sFull, gFull),
    computeSimilarity(sFull, gMain),
    computeSimilarity(sMain, gMain)
  );
}

/**
 * Align Genius singer sections with Spotify synced lines using global monotonic
 * Dynamic Programming (handles 1-to-1 match, 1-to-2 split, and 2-to-1 merge).
 */
export function alignGeniusSingers(
  lines: Array<{
    Text: string;
    Singer?: string;
    SingerStyle?: SingerStyle;
    OppositeAligned?: boolean;
    Background?: Array<{ Text: string; Singer?: string; SingerStyle?: SingerStyle }>;
  }>,
  sections: GeniusSection[]
): boolean {
  if (!sections || sections.length === 0 || !lines || lines.length === 0) return false;

  interface FlatGeniusLine {
    sectionIdx: number;
    lineIdx: number;
    text: string;
    mainText: string;
    parenText?: string;
    singer: string | null;
    parenSinger: string | null;
    style: SingerStyle;
  }

  const flatG: FlatGeniusLine[] = [];
  sections.forEach((sec, sIdx) => {
    sec.lines.forEach((l, lIdx) => {
      flatG.push({
        sectionIdx: sIdx,
        lineIdx: lIdx,
        text: l.text,
        mainText: l.mainText || l.text,
        parenText: l.parenText,
        singer: l.singer || sec.singer,
        parenSinger: l.parenSinger || l.singer || sec.singer,
        style: l.style || "normal",
      });
    });
  });

  if (flatG.length === 0 || !flatG.some((g) => g.singer)) return false;

  // Fill any null singers in flatG (e.g. Intro without explicit singer) from nearest neighbor
  const firstValidSinger = flatG.find((g) => g.singer)?.singer ?? null;
  let runningSinger = firstValidSinger;
  for (const g of flatG) {
    if (g.singer) runningSinger = g.singer;
    else g.singer = runningSinger;
    if (!g.parenSinger) g.parenSinger = g.singer;
  }

  const validIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (normalizeLine(lines[i].Text).length > 0) {
      validIndices.push(i);
    }
  }

  const N = validIndices.length;
  const M = flatG.length;
  if (N === 0) return false;

  const sim1 = new Float32Array(N * M);
  const sim2 = new Float32Array(N * M);

  for (let i = 0; i < N; i++) {
    const sText = lines[validIndices[i]].Text;
    for (let j = 0; j < M; j++) {
      const g = flatG[j];
      sim1[i * M + j] = pairSimilarity(sText, g.mainText, g.text);
      if (j > 0 && flatG[j - 1].sectionIdx === g.sectionIdx) {
        const gPrev = flatG[j - 1];
        const mergedMain = `${gPrev.mainText} ${g.mainText}`;
        const mergedFull = `${gPrev.text} ${g.text}`;
        sim2[i * M + j] = pairSimilarity(sText, mergedMain, mergedFull);
      }
    }
  }

  const cols = M + 1;
  const dp = new Float32Array((N + 1) * cols);
  // Action codes:
  // 1 = skip Spotify line (i-1, j)
  // 2 = skip Genius line (i, j-1)
  // 3 = 1-to-1 match S[i-1] <-> G[j-1] from (i-1, j-1)
  // 4 = 1-to-2 split S[i-1] <-> G[j-1] from (i-1, j)
  // 5 = 2-to-1 merge S[i-1] <-> G[j-2..j-1] from (i-1, j-2)
  const back = new Uint8Array((N + 1) * cols);

  const SKIP_S_PENALTY = -0.06;
  const SKIP_G_PENALTY = -0.03;
  const MIN_MATCH_SCORE = 0.42;

  for (let i = 1; i <= N; i++) {
    dp[i * cols] = dp[(i - 1) * cols] + SKIP_S_PENALTY;
    back[i * cols] = 1;
  }
  for (let j = 1; j <= M; j++) {
    dp[j] = dp[j - 1] + SKIP_G_PENALTY;
    back[j] = 2;
  }

  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      const idx = i * cols + j;

      let bestScore = dp[(i - 1) * cols + j] + SKIP_S_PENALTY;
      let bestAct = 1;

      const skipG = dp[i * cols + (j - 1)] + SKIP_G_PENALTY;
      if (skipG > bestScore) {
        bestScore = skipG;
        bestAct = 2;
      }

      const s1 = sim1[(i - 1) * M + (j - 1)];
      if (s1 >= MIN_MATCH_SCORE) {
        const score3 = dp[(i - 1) * cols + (j - 1)] + s1;
        if (score3 >= bestScore) {
          bestScore = score3;
          bestAct = 3;
        }

        if (i >= 2) {
          const prevAct = back[(i - 1) * cols + j];
          if (prevAct === 3 || prevAct === 4) {
            const score4 = dp[(i - 1) * cols + j] + s1 * 0.92;
            if (score4 > bestScore) {
              bestScore = score4;
              bestAct = 4;
            }
          }
        }
      }

      if (j >= 2) {
        const s2 = sim2[(i - 1) * M + (j - 1)];
        if (s2 >= MIN_MATCH_SCORE + 0.05 && s2 > s1 + 0.04) {
          const score5 = dp[(i - 1) * cols + (j - 2)] + s2 * 1.05;
          if (score5 > bestScore) {
            bestScore = score5;
            bestAct = 5;
          }
        }
      }

      dp[idx] = bestScore;
      back[idx] = bestAct;
    }
  }

  interface MatchAssignment {
    singer: string | null;
    parenSinger: string | null;
    style: SingerStyle;
    sectionIdx: number;
  }

  const assigned: Array<MatchAssignment | null> = Array.from({ length: N }, () => null);
  let ci = N;
  let cj = M;
  let matchedCount = 0;

  while (ci > 0 || cj > 0) {
    const act = back[ci * cols + cj];
    if (ci > 0 && (act === 3 || act === 4)) {
      const g = flatG[cj - 1];
      assigned[ci - 1] = {
        singer: g.singer,
        parenSinger: g.parenSinger,
        style: g.style,
        sectionIdx: g.sectionIdx,
      };
      matchedCount++;
      if (act === 3) {
        ci--;
        cj--;
      } else {
        ci--;
      }
    } else if (ci > 0 && act === 5 && cj >= 2) {
      const g1 = flatG[cj - 2];
      const g2 = flatG[cj - 1];
      assigned[ci - 1] = {
        singer: mergeSingerNames([g1.singer, g2.singer]),
        parenSinger: mergeSingerNames([g1.parenSinger, g2.parenSinger]),
        style: g1.style,
        sectionIdx: g2.sectionIdx,
      };
      matchedCount++;
      ci--;
      cj -= 2;
    } else if (ci > 0 && (act === 1 || cj === 0)) {
      ci--;
    } else {
      cj--;
    }
  }

  if (matchedCount === 0) return false;

  // Fill any unmatched Spotify lines from nearest matched neighbor
  let lastMatch: MatchAssignment | null = null;
  for (let i = 0; i < N; i++) {
    if (assigned[i]) {
      lastMatch = assigned[i];
    } else if (lastMatch) {
      assigned[i] = { ...lastMatch };
    }
  }
  let nextMatch: MatchAssignment | null = null;
  for (let i = N - 1; i >= 0; i--) {
    if (assigned[i]) {
      nextMatch = assigned[i];
    } else if (nextMatch) {
      assigned[i] = { ...nextMatch };
    }
  }

  const distinctSingers = new Set<string>();
  for (let i = 0; i < N; i++) {
    const m = assigned[i];
    if (!m || !m.singer) continue;
    const targetLine = lines[validIndices[i]];
    targetLine.Singer = m.singer;
    targetLine.SingerStyle = m.style;
    distinctSingers.add(m.singer);

    if (Array.isArray(targetLine.Background)) {
      for (const bg of targetLine.Background) {
        bg.Singer = m.parenSinger || m.singer;
      }
    }
  }

  // If this song is a 2-person duet and OppositeAligned was not yet set,
  // align the second singer to the opposite side for a duet view.
  if (distinctSingers.size === 2) {
    const singerList = Array.from(distinctSingers);
    const secondSinger = singerList[1];
    for (const line of lines) {
      if (line.Singer === secondSinger && line.OppositeAligned === undefined) {
        line.OppositeAligned = true;
      }
    }
  }

  return true;
}

/**
 * Reconstructs plain text from a Syllable array while preserving word boundaries
 * marked by `!s.IsPartOfWord`.
 */
export function joinSyllablesText(
  syllables: Array<{ Text?: string; IsPartOfWord?: boolean }> | undefined
): string {
  if (!Array.isArray(syllables) || syllables.length === 0) return "";
  let out = "";
  for (let i = 0; i < syllables.length; i++) {
    const s = syllables[i];
    const t = s?.Text ?? "";
    if (!t) continue;
    out += t;
    if (!s.IsPartOfWord && i < syllables.length - 1 && !/\s$/.test(out)) {
      out += " ";
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Builds the `.SingerBadgeContainer` DOM element for a line's singer(s).
 * Single singers render as a single horizontal pill; multiple singers stack
 * vertically in compact horizontal pills without overflowing the line height.
 */
export function createSingerBadgeContainer(
  singerName: string | undefined
): HTMLElement | null {
  if (!singerName) return null;
  const rawParts = singerName
    .split(/\s*(?:,|&|\+|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (rawParts.length === 0) return null;

  const seen = new Set<string>();
  const uniqueSingers: string[] = [];
  for (const part of rawParts) {
    const key = part.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueSingers.push(part);
    }
  }
  if (uniqueSingers.length === 0) return null;

  // Cap at most 3 vertical pills so multi-singer badges never exceed line height
  let badgeLabels: string[];
  if (uniqueSingers.length <= 3) {
    badgeLabels = uniqueSingers;
  } else {
    badgeLabels = [];
    for (let i = 0; i < uniqueSingers.length; i += 2) {
      badgeLabels.push(uniqueSingers.slice(i, i + 2).join(" · "));
    }
    if (badgeLabels.length > 3) {
      badgeLabels = [
        badgeLabels[0],
        badgeLabels[1],
        badgeLabels.slice(2).join(" · "),
      ];
    }
  }

  const container = document.createElement("div");
  container.classList.add("SingerBadgeContainer");
  if (badgeLabels.length > 1) {
    container.classList.add("MultiSinger");
    if (badgeLabels.length >= 3) {
      container.classList.add("ThreeSingers");
    }
  }

  for (const label of badgeLabels) {
    const badge = document.createElement("span");
    badge.classList.add("SingerBadge");
    badge.textContent = label;
    container.appendChild(badge);
  }

  return container;
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

  // 1. Fetch Genius sections via proxy, API, or direct slug
  const sections = await fetchGeniusSections(title, artist);
  let matched = false;
  if (sections && sections.some((s) => s.singer || s.lines.some((l) => l.singer))) {
    if (lyrics.Type === "Line" && Array.isArray(lyrics.Content)) {
      matched = alignGeniusSingers(lyrics.Content, sections);
    } else if (lyrics.Type === "Syllable" && Array.isArray(lyrics.Content)) {
      const lineAdapters: any[] = [];
      for (const vocalGroup of lyrics.Content) {
        const bgAdapters = Array.isArray(vocalGroup.Background)
          ? vocalGroup.Background.map((bg: any) => ({
              Text: joinSyllablesText(bg.Syllables),
              get Singer() {
                return bg.Singer;
              },
              set Singer(val: string | undefined) {
                bg.Singer = val;
                for (const s of bg.Syllables || []) {
                  s.Singer = val;
                }
              },
            }))
          : undefined;

        lineAdapters.push({
          Text: joinSyllablesText(vocalGroup.Lead?.Syllables),
          Background: bgAdapters,
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
      }
      matched = alignGeniusSingers(lineAdapters, sections);
    } else if (lyrics.Type === "Static" && Array.isArray(lyrics.Lines)) {
      matched = alignGeniusSingers(lyrics.Lines, sections);
    }
  }

  if (matched) return true;

  // 2. If Genius didn't match, keep native Apple Music TTML singer attributions if present
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

  // 3. Fallback: only if Genius has no singer breakdown AND this is genuinely an opposite-aligned 2-artist duet
  const nonSingerBrands =
    /^(League of Legends|Various Artists|Original Soundtrack|Soundtrack|Cast|Riot Games Music)$/i;
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
