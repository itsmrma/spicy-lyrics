import Kuroshiro from "kuroshiro";
import { kanaToRomaji, patchTokens, toRawHiragana } from "kuroshiro/lib/util";
import * as KuromojiAnalyzer from "./KuromojiAnalyzer.ts";

/**
 * Japanese romanization, in line context.
 *
 * Kuromoji reads a kanji from the words around it, so a whole sentence converts
 * far better than a fragment: 輝 alone comes out as "teru" while 輝いて is
 * "kagayaite", and 運命 split in two is "un inochi" instead of "unmei". Spotify
 * hands us word-sized syllables, so romanizing each one on its own — which is
 * what the shared per-script pipeline does for every other language — throws
 * that context away. This module tokenizes the whole line once, converts every
 * token with its reading in place, and then gives each syllable the slice of
 * romaji its characters cover.
 *
 * Text is normalized to NFKC for conversion only. Halfwidth katakana, ㍿ and
 * ① have no reading in the dictionary, so without normalization they came back
 * unchanged and stayed Japanese in the romanized view.
 */

const converter = new Kuroshiro();

/** Resolves once the dictionary is loaded; conversion awaits it on its own. */
export const JapaneseRomanizerReady: Promise<void> = converter.init(KuromojiAnalyzer);

const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const LATIN_OR_DIGIT = /[\p{Script=Latin}\p{Nd}]/u;

const MACRON: Record<string, string> = {
  a: "ā",
  e: "ē",
  i: "ī",
  o: "ō",
  u: "ū",
};

type Group = {
  /** Characters this group covers in the line text. */
  surface: string;
  /** The same span as kana, so a syllable boundary inside the group can be re-split. */
  reading: string;
  /** The group's romaji as a whole. */
  romaji: string;
  /** Whether the group belongs to a token that contains kanji. */
  fromKanjiToken: boolean;
  /** Underlying Kuromoji token for grammatical part-of-speech attachment */
  token: any;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Checks whether the current token attaches directly to the previous token without a space.
 */
function shouldAttach(prevToken: any, currToken: any): boolean {
  if (!prevToken || !currToken) return false;

  // Symbols / Punctuation
  if (currToken.pos === "記号") {
    const openBrackets = ["（", "「", "『", "(", "[", "{", "“", "‘"];
    if (openBrackets.includes(currToken.surface_form)) return false;
    return true; // attach closing brackets, commas, periods, exclamation, etc.
  }
  if (prevToken.pos === "記号") {
    const openBrackets = ["（", "「", "『", "(", "[", "{", "“", "‘"];
    if (openBrackets.includes(prevToken.surface_form)) return true;
  }

  // Suffixes attach to previous word (e.g. 達, 等, 様, さん, くん, ちゃん, さ)
  if (currToken.pos_detail_1 === "接尾") return true;
  // Prefixes attach to next word (e.g. お-, ご-)
  if (prevToken.pos === "接頭詞") return true;

  // Contracted auxiliary verbs / subsidiary verbs like てる, ちゃう, とく
  if (currToken.pos === "動詞" && currToken.pos_detail_1 === "非自立") {
    if (prevToken.pos === "動詞" && /^[てでちゃじゃと]/.test(currToken.surface_form)) {
      return true;
    }
  }

  // Conjunctive particle て/で attaching to verb/adjective
  if (
    currToken.pos === "助詞" &&
    currToken.pos_detail_1 === "接続助詞" &&
    ["て", "で"].includes(currToken.surface_form)
  ) {
    if (prevToken.pos === "動詞" || prevToken.pos === "形容詞") return true;
  }

  // Auxiliary verbs (助動詞)
  if (currToken.pos === "助動詞") {
    if (prevToken.pos === "助動詞") return true;
    if (prevToken.pos === "動詞" || prevToken.pos === "形容詞") {
      const inflections = [
        "た", "だ", "ない", "なかっ", "ます", "まし", "ませ",
        "たい", "たかっ", "れる", "られ", "せる", "させ", "う", "よう", "ず"
      ];
      if (inflections.includes(currToken.surface_form)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Split one token into the runs a syllable boundary can fall between. A token
 * with kanji is aligned against its reading the way okurigana is: the surface's
 * kana runs are literal in the reading, so each kanji run can be matched to its
 * own reading (歩いてる -> 歩=ある, いてる=いてる). A token without kanji is one
 * group, converted as a whole so long vowels and gemination stay right.
 */
function tokenGroups(token: any, base: string, fromKanjiToken: boolean): Group[] {
  const surface: string = token.surface_form;
  const reading: string = token.reading || surface;

  if (!HAN.test(surface)) {
    return [{ surface, reading, romaji: kanaToRomaji(base), fromKanjiToken, token }];
  }

  const runs: { kanji: boolean; surface: string }[] = [];
  let pattern = "";
  let kanjiRun = "";
  let kanaRun = "";

  const flushKanji = () => {
    if (kanjiRun === "") return;
    runs.push({ kanji: true, surface: kanjiRun });
    pattern += "(.+)";
    kanjiRun = "";
  };
  const flushKana = () => {
    if (kanaRun === "") return;
    runs.push({ kanji: false, surface: kanaRun });
    pattern += escapeRegExp(toRawHiragana(kanaRun));
    kanaRun = "";
  };

  for (const char of surface) {
    if (HAN.test(char)) {
      flushKana();
      kanjiRun += char;
    } else {
      flushKanji();
      kanaRun += char;
    }
  }
  flushKana();
  flushKanji();

  // A reading whose kana don't match the surface (irregular readings) can't be
  // cut per run; the whole token still converts, just without internal splits.
  const match = new RegExp(`^${pattern}$`).exec(toRawHiragana(reading));
  if (!match || reading.length !== base.length) {
    return [{ surface, reading, romaji: kanaToRomaji(base), fromKanjiToken: true, token }];
  }

  const groups: Group[] = [];
  let pick = 1;
  let offset = 0;
  for (const run of runs) {
    const length = run.kanji ? (match[pick++] ?? "").length : toRawHiragana(run.surface).length;
    const read = reading.slice(offset, offset + length);
    const spoken = base.slice(offset, offset + length);
    offset += length;
    groups.push({
      surface: run.surface,
      reading: read,
      romaji: kanaToRomaji(spoken),
      fromKanjiToken: true,
      token,
    });
  }

  if (offset !== reading.length) {
    return [{ surface, reading, romaji: kanaToRomaji(base), fromKanjiToken: true, token }];
  }
  return groups;
}

/**
 * Join the line's texts the way it is actually written. Japanese has no spaces,
 * and inserting one would make kuromoji read the neighbouring characters as
 * separate words — the exact context loss this pass exists to avoid. Latin runs
 * keep their spaces so mixed-language lines still tokenize.
 */
function buildLine(texts: readonly string[]): {
  line: string;
  ranges: [number, number][];
} {
  let line = "";
  const ranges: [number, number][] = [];
  texts.forEach((text, index) => {
    const previous = index > 0 ? texts[index - 1] : "";
    if (
      previous !== "" &&
      text !== "" &&
      LATIN_OR_DIGIT.test(previous.slice(-1)) &&
      LATIN_OR_DIGIT.test(text[0])
    ) {
      line += " ";
    }
    const start = line.length;
    line += text;
    ranges.push([start, line.length]);
  });
  return { line, ranges };
}

/** Tokenize the line and turn the token stream into aligned groups. */
function groupLine(tokens: any[], ranges: readonly [number, number][]): Group[] {
  const groups: Group[] = [];
  let cursor = 0;

  for (const token of tokens) {
    const start = cursor;
    const end = start + token.surface_form.length;
    cursor = end;

    let touched = 0;
    for (const [rangeStart, rangeEnd] of ranges) {
      if (rangeStart < end && rangeEnd > start) touched += 1;
    }

    let base: string;
    if (token.pos === "助詞") {
      if (token.surface_form === "は") base = "ワ";
      else if (token.surface_form === "へ") base = "エ";
      else if (token.surface_form === "を") base = "オ";
      else base = token.pronunciation || token.reading || token.surface_form;
    } else if (token.surface_form === "こんにちは" || token.surface_form === "今日は") {
      base = "コンニチワ";
    } else if (token.surface_form === "こんばんは" || token.surface_form === "今晩は") {
      base = "コンバンワ";
    } else if (touched > 1) {
      // A token spanning syllables is read from its kana reading rather than its
      // pronunciation: each syllable then shows plain kana romanization ("kou")
      // instead of half a macron ("k" + "ō").
      base = token.reading || token.surface_form;
    } else {
      base = token.pronunciation || token.reading || token.surface_form;
    }

    groups.push(...tokenGroups(token, base, HAN.test(token.surface_form)));
  }

  return groups;
}

export type JapaneseSyllableResult = {
  text: string;
  isPartOfWord?: boolean;
};

/** Hand each range the slice of its groups' romaji it covers. */
function distribute(
  groups: readonly Group[],
  ranges: readonly [number, number][]
): JapaneseSyllableResult[] {
  let groupIndex = 0;
  let groupStart = 0;

  return ranges.map(([start, end], rangeIdx) => {
    let result = "";
    let lastGroup: Group | null = null;

    while (groupIndex < groups.length && groupStart + groups[groupIndex].surface.length <= start) {
      groupStart += groups[groupIndex].surface.length;
      groupIndex += 1;
    }

    let index = groupIndex;
    let cursor = groupStart;
    let endsInsideGroup = false;
    let endingGroupIndex = -1;

    while (index < groups.length && cursor < end) {
      const group = groups[index];
      const groupEnd = cursor + group.surface.length;
      const from = Math.max(start, cursor) - cursor;
      const to = Math.min(end, groupEnd) - cursor;

      if (to > from) {
        let piece = "";
        if (from === 0 && to === group.surface.length) {
          piece = group.romaji;
        } else if (group.fromKanjiToken) {
          // A split inside a kanji run has no reading boundary to cut at; keep
          // the romaji proportional to the characters on each side.
          const romajiFrom = Math.floor((group.romaji.length * from) / group.surface.length);
          const romajiTo = Math.floor((group.romaji.length * to) / group.surface.length);
          piece = group.romaji.slice(romajiFrom, romajiTo);
        } else {
          // Kana can be cut at the syllable boundary and converted on its own.
          const readingFrom = Math.floor((group.reading.length * from) / group.surface.length);
          const readingTo = Math.floor((group.reading.length * to) / group.surface.length);
          piece = kanaToRomaji(group.reading.slice(readingFrom, readingTo));
        }

        if (lastGroup && lastGroup.token !== group.token && !shouldAttach(lastGroup.token, group.token)) {
          if (result.length > 0 && !result.endsWith(" ") && !piece.startsWith(" ")) {
            result += " ";
          }
        }
        result += piece;
        lastGroup = group;
      }

      if (end < groupEnd) {
        endsInsideGroup = true;
      }
      endingGroupIndex = index;

      cursor = groupEnd;
      index += 1;
    }

    // Determine whether this syllable range continues into the next range as part of the same word
    let isPartOfWord = false;
    if (rangeIdx < ranges.length - 1) {
      if (endsInsideGroup) {
        isPartOfWord = true;
      } else if (endingGroupIndex >= 0 && endingGroupIndex + 1 < groups.length) {
        const nextGroup = groups[endingGroupIndex + 1];
        isPartOfWord =
          groups[endingGroupIndex].token === nextGroup.token ||
          shouldAttach(groups[endingGroupIndex].token, nextGroup.token);
      }
    }

    const cleaned = cleanRomaji(result)
      .replace(/\s+([、。，．,\.!?！？])/g, "$1")
      .replace(/ +/g, " ");

    return {
      text: cleaned,
      isPartOfWord,
    };
  });
}

/**
 * Remove what the dictionary left behind. Kana that survived conversion is
 * converted on its own; a long-vowel mark with nothing to lengthen (んー) is
 * dropped, otherwise it becomes the macron of the vowel before it.
 */
function cleanRomaji(text: string): string {
  let result = "";
  for (const char of text) {
    if (char === "ー") {
      const previous = result.slice(-1);
      const macron = MACRON[previous];
      result = macron ? result.slice(0, -1) + macron : result;
      continue;
    }
    result += KANA.test(char) ? kanaToRomaji(char) : char;
  }
  return result;
}

/** Per-text fallback for the rare line the token stream can't be aligned to. */
async function romanizeEach(texts: readonly string[]): Promise<JapaneseSyllableResult[]> {
  const list = await Promise.all(
    texts.map(async (text) =>
      cleanRomaji(await converter.convert(text, { to: "romaji", mode: "normal" }))
    )
  );
  return list.map((text) => ({ text, isPartOfWord: false }));
}

/**
 * Romanize one line's syllables, returning one string per input text.
 *
 * `texts` are the line's syllables in order. Empty or punctuation-only entries
 * are fine: they stay in the line so the tokenizer sees the whole sentence, and
 * their slice comes back as the matching punctuation.
 */
export async function RomanizeJapaneseSyllables(
  texts: readonly string[]
): Promise<JapaneseSyllableResult[]> {
  const normalized = texts.map((text) => text.normalize("NFKC"));
  const { line, ranges } = buildLine(normalized);

  if (line.trim() === "") return normalized.map((text) => ({ text, isPartOfWord: false }));

  await JapaneseRomanizerReady;

  const tokens = patchTokens((await KuromojiAnalyzer.parse(line)) as any[]);
  const groups = groupLine(tokens, ranges);

  // The token stream should tile the line exactly. If it doesn't, something in
  // the dictionary surprised us; convert syllable by syllable rather than
  // shifting every later syllable's romaji by one.
  const tiled = groups.map((group) => group.surface).join("") === line;
  if (!tiled) return romanizeEach(normalized);

  return distribute(groups, ranges);
}
