import * as KuromojiAnalyzer from "./KuromojiAnalyzer.ts";

/**
 * Japanese romanization, in line context.
 *
 * Kuromoji reads a kanji from the words around it, so a whole sentence converts
 * far better than a fragment: 輝 alone comes out as "teru" while 輝いて is
 * "kagayaite", and 運命 split in two is "un inochi" instead of "unmei". Spotify
 * hands us word-sized syllables, so romanizing each one on its own — which is
 * what the shared per-script pipeline does for every other language — throws
 * that context away. This module tokenizes the whole line once, normalizes
 * Kuromoji's token splits and dictionary blind spots, converts every token's
 * full reading into per-kana Hepburn romaji slots, and gives each syllable the
 * slice of romaji its characters cover.
 *
 * Text is normalized to NFKC for conversion only. Halfwidth katakana, ㍿ and
 * ① have no reading in the dictionary, so without normalization they came back
 * unchanged and stayed Japanese in the romanized view.
 */

/** Resolves once the dictionary is loaded; conversion awaits it on its own. */
export const JapaneseRomanizerReady: Promise<void> = KuromojiAnalyzer.init();

const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const KANA_OR_MARK = /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
const JAPANESE_CHAR = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}々ゝゞヽヾー]/u;
const LATIN_OR_DIGIT = /[\p{Script=Latin}\p{Nd}]/u;

const LEADING_SMALL_KANA = /^[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ]/;
const LONG_MARK_ONLY = /^ー+$/;
const SOKUON_ONLY = /^[っッ]$/;

const OPEN_BRACKETS = new Set([
  "（",
  "「",
  "『",
  "(",
  "[",
  "{",
  "“",
  "‘",
  "【",
  "〈",
  "《",
  "〔",
  "［",
  "｛",
  "〝",
]);

const TRAILING_PUNCT_RE = /^[）)」』)\]}”’】〉》〕］｝〟、。，．,.!?！？…‥:;：；〜～~%％♪♡★☆]+$/;

const HIRAGANA_TO_KATAKANA_SHIFT = 0x30a1 - 0x3041;
const KATAKANA_TO_HIRAGANA_SHIFT = 0x3041 - 0x30a1;

export type JapaneseSyllableInput = {
  text: string;
  isPartOfWord?: boolean;
};

export type JapaneseSyllableResult = {
  text: string;
  isPartOfWord?: boolean;
};

type QuoteRole = "open" | "close" | "intra";

type NormalizedToken = {
  surface_form: string;
  reading: string;
  pronunciation?: string;
  pos: string;
  pos_detail_1: string;
  pos_detail_2?: string;
  quoteRole?: QuoteRole;
  /** Force attachment to the following token (used by split compound overrides). */
  forceAttachNext?: boolean;
};

type Group = {
  /** Characters this group covers in the line text. */
  surface: string;
  /** The same span as kana, so a syllable boundary inside the group can be re-split. */
  reading: string;
  /** Per-code-point romaji aligned to `reading` (used when slicing kana groups). */
  slots: string[];
  /** The group's romaji as a whole. */
  romaji: string;
  /** Whether the group belongs to a token that contains kanji. */
  fromKanjiToken: boolean;
  /** Underlying normalized Kuromoji token for grammatical part-of-speech attachment. */
  token: NormalizedToken;
};

/** Single-kana Modified Hepburn map (katakana keys; hiragana is shifted to katakana before lookup). */
const SINGLE_KANA: Record<string, string> = {
  ア: "a",
  イ: "i",
  ウ: "u",
  エ: "e",
  オ: "o",
  カ: "ka",
  キ: "ki",
  ク: "ku",
  ケ: "ke",
  コ: "ko",
  サ: "sa",
  シ: "shi",
  ス: "su",
  セ: "se",
  ソ: "so",
  タ: "ta",
  チ: "chi",
  ツ: "tsu",
  テ: "te",
  ト: "to",
  ナ: "na",
  ニ: "ni",
  ヌ: "nu",
  ネ: "ne",
  ノ: "no",
  ハ: "ha",
  ヒ: "hi",
  フ: "fu",
  ヘ: "he",
  ホ: "ho",
  マ: "ma",
  ミ: "mi",
  ム: "mu",
  メ: "me",
  モ: "mo",
  ヤ: "ya",
  ユ: "yu",
  ヨ: "yo",
  ラ: "ra",
  リ: "ri",
  ル: "ru",
  レ: "re",
  ロ: "ro",
  ワ: "wa",
  ヰ: "i",
  ヱ: "e",
  ヲ: "o",
  ガ: "ga",
  ギ: "gi",
  グ: "gu",
  ゲ: "ge",
  ゴ: "go",
  ザ: "za",
  ジ: "ji",
  ズ: "zu",
  ゼ: "ze",
  ゾ: "zo",
  ダ: "da",
  ヂ: "ji",
  ヅ: "zu",
  デ: "de",
  ド: "do",
  バ: "ba",
  ビ: "bi",
  ブ: "bu",
  ベ: "be",
  ボ: "bo",
  パ: "pa",
  ピ: "pi",
  プ: "pu",
  ペ: "pe",
  ポ: "po",
  ヴ: "vu",
  ヷ: "va",
  ヸ: "vi",
  ヹ: "ve",
  ヺ: "vo",
  ァ: "a",
  ィ: "i",
  ゥ: "u",
  ェ: "e",
  ォ: "o",
  ャ: "ya",
  ュ: "yu",
  ョ: "yo",
  ヮ: "wa",
  ヵ: "ka",
  ヶ: "ke",
  ン: "n",
  "　": " ",
  "、": ",",
  "。": ".",
  "・": " ",
  "「": '"',
  "」": '"',
  "『": '"',
  "』": '"',
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
  "〜": "~",
  "～": "~",
  "（": "(",
  "）": ")",
  "【": "[",
  "】": "]",
  "〈": "<",
  "〉": ">",
  "《": "<<",
  "》": ">>",
  "〔": "[",
  "〕": "]",
  "［": "[",
  "］": "]",
  "｛": "{",
  "｝": "}",
  "〝": '"',
  "〟": '"',
};

/**
 * Two-kana digraphs stored as `[firstKanaSlot, secondKanaSlot]` so splitting
 * across syllable boundaries (`き` + `ょう`, `と` + `ぅ`, `ふ` + `ぁ`) keeps both
 * halves accurate and never invents spurious vowels (`kiyou`, `tou`, `fua`).
 */
const DIGRAPH_KANA: Record<string, [string, string]> = {
  // Yōon (palatalized)
  キャ: ["k", "ya"],
  キュ: ["k", "yu"],
  キョ: ["k", "yo"],
  シャ: ["sh", "a"],
  シュ: ["sh", "u"],
  ショ: ["sh", "o"],
  チャ: ["ch", "a"],
  チュ: ["ch", "u"],
  チョ: ["ch", "o"],
  ニャ: ["n", "ya"],
  ニュ: ["n", "yu"],
  ニョ: ["n", "yo"],
  ヒャ: ["h", "ya"],
  ヒュ: ["h", "yu"],
  ヒョ: ["h", "yo"],
  ミャ: ["m", "ya"],
  ミュ: ["m", "yu"],
  ミョ: ["m", "yo"],
  リャ: ["r", "ya"],
  リュ: ["r", "yu"],
  リョ: ["r", "yo"],
  ギャ: ["g", "ya"],
  ギュ: ["g", "yu"],
  ギョ: ["g", "yo"],
  ジャ: ["j", "a"],
  ジュ: ["j", "u"],
  ジョ: ["j", "o"],
  ヂャ: ["j", "a"],
  ヂュ: ["j", "u"],
  ヂョ: ["j", "o"],
  ビャ: ["b", "ya"],
  ビュ: ["b", "yu"],
  ビョ: ["b", "yo"],
  ピャ: ["p", "ya"],
  ピュ: ["p", "yu"],
  ピョ: ["p", "yo"],
  クヮ: ["k", "wa"],
  グヮ: ["g", "wa"],

  // Extended / foreign-sound digraphs (gairaigo & stylized lyrics)
  イェ: ["y", "e"],
  ウァ: ["w", "a"],
  ウィ: ["w", "i"],
  ウェ: ["w", "e"],
  ウォ: ["w", "o"],
  ウャ: ["w", "ya"],
  ウュ: ["w", "yu"],
  ウョ: ["w", "yo"],
  ヴァ: ["v", "a"],
  ヴィ: ["v", "i"],
  ヴュ: ["v", "yu"],
  ヴェ: ["v", "e"],
  ヴォ: ["v", "o"],
  ヴャ: ["v", "ya"],
  ヴョ: ["v", "yo"],
  キェ: ["k", "ye"],
  ギェ: ["g", "ye"],
  クァ: ["k", "wa"],
  クィ: ["k", "wi"],
  クェ: ["k", "we"],
  クォ: ["k", "wo"],
  グァ: ["g", "wa"],
  グィ: ["g", "wi"],
  グェ: ["g", "we"],
  グォ: ["g", "wo"],
  シェ: ["sh", "e"],
  ジェ: ["j", "e"],
  スァ: ["s", "wa"],
  スィ: ["s", "i"],
  スェ: ["s", "we"],
  スォ: ["s", "wo"],
  ズィ: ["z", "i"],
  チェ: ["ch", "e"],
  ヂェ: ["j", "e"],
  ツァ: ["ts", "a"],
  ツィ: ["ts", "i"],
  ツェ: ["ts", "e"],
  ツォ: ["ts", "o"],
  ツュ: ["ts", "yu"],
  テャ: ["t", "ya"],
  ティ: ["t", "i"],
  テュ: ["t", "yu"],
  テェ: ["t", "ye"],
  テョ: ["t", "yo"],
  デャ: ["d", "ya"],
  ディ: ["d", "i"],
  デュ: ["d", "yu"],
  デェ: ["d", "ye"],
  デョ: ["d", "yo"],
  トァ: ["t", "wa"],
  トィ: ["t", "wi"],
  トゥ: ["t", "u"],
  トェ: ["t", "we"],
  トォ: ["t", "wo"],
  ドァ: ["d", "wa"],
  ドィ: ["d", "wi"],
  ドゥ: ["d", "u"],
  ドェ: ["d", "we"],
  ドォ: ["d", "wo"],
  ニェ: ["n", "ye"],
  ヒェ: ["h", "ye"],
  ビェ: ["b", "ye"],
  ピェ: ["p", "ye"],
  ミェ: ["m", "ye"],
  リェ: ["r", "ye"],
  ファ: ["f", "a"],
  フィ: ["f", "i"],
  フェ: ["f", "e"],
  フォ: ["f", "o"],
  フャ: ["f", "ya"],
  フュ: ["f", "yu"],
  フョ: ["f", "yo"],
  ホゥ: ["h", "u"],
};

/**
 * Common kanji words / compounds that Kuromoji's 2007 IPAdic splits or misreads.
 * Checked as consecutive token surface sequences when no whitespace separates them.
 */
const COMPOUND_OVERRIDES: ReadonlyArray<{
  surfaces: readonly string[];
  /** Single merged reading (merges tokens) OR per-token readings (keeps tokens aligned to syllables). */
  reading?: string;
  readings?: readonly string[];
  pos: string;
  pos_detail_1: string;
  notFollowedBy?: readonly string[];
}> = [
  {
    surfaces: ["意味", "深"],
    readings: ["イミ", "シン"],
    pos: "名詞",
    pos_detail_1: "形容動詞語幹",
  },
  { surfaces: ["彪", "変"], readings: ["ヒョウ", "ヘン"], pos: "名詞", pos_detail_1: "サ変接続" },
  { surfaces: ["豹", "変"], readings: ["ヒョウ", "ヘン"], pos: "名詞", pos_detail_1: "サ変接続" },
  { surfaces: ["ネタ", "バレ"], readings: ["ネタ", "バレ"], pos: "名詞", pos_detail_1: "サ変接続" },
  {
    surfaces: ["一", "人"],
    readings: ["ヒト", "リ"],
    pos: "名詞",
    pos_detail_1: "一般",
    notFollowedBy: ["称", "前", "役", "あたり", "当たり"],
  },
  {
    surfaces: ["二", "人"],
    readings: ["フタ", "リ"],
    pos: "名詞",
    pos_detail_1: "一般",
    notFollowedBy: ["三脚", "羽織"],
  },
  { surfaces: ["二", "十", "歳"], reading: "ハタチ", pos: "名詞", pos_detail_1: "一般" },
  {
    surfaces: ["大", "っ", "嫌い"],
    readings: ["ダイ", "ッ", "キライ"],
    pos: "名詞",
    pos_detail_1: "形容動詞語幹",
  },
  {
    surfaces: ["一", "日", "中"],
    readings: ["イチ", "ニチ", "ジュウ"],
    pos: "名詞",
    pos_detail_1: "副詞可能",
  },
  { surfaces: ["何", "故"], reading: "ナゼ", pos: "副詞", pos_detail_1: "一般" },
  { surfaces: ["1", "つ"], reading: "ヒトツ", pos: "名詞", pos_detail_1: "一般" },
  { surfaces: ["2", "つ"], reading: "フタツ", pos: "名詞", pos_detail_1: "一般" },
  { surfaces: ["3", "つ"], reading: "ミッツ", pos: "名詞", pos_detail_1: "一般" },
  { surfaces: ["4", "つ"], reading: "ヨッツ", pos: "名詞", pos_detail_1: "一般" },
  { surfaces: ["5", "つ"], reading: "イツツ", pos: "名詞", pos_detail_1: "一般" },
  { surfaces: ["6", "つ"], reading: "ムッツ", pos: "名詞", pos_detail_1: "一般" },
  { surfaces: ["7", "つ"], reading: "ナナツ", pos: "名詞", pos_detail_1: "一般" },
  { surfaces: ["8", "つ"], reading: "ヤッツ", pos: "名詞", pos_detail_1: "一般" },
  { surfaces: ["9", "つ"], reading: "ココノツ", pos: "名詞", pos_detail_1: "一般" },
  {
    surfaces: ["1", "人"],
    reading: "ヒトリ",
    pos: "名詞",
    pos_detail_1: "一般",
    notFollowedBy: ["称", "前", "役"],
  },
  {
    surfaces: ["2", "人"],
    reading: "フタリ",
    pos: "名詞",
    pos_detail_1: "一般",
    notFollowedBy: ["三脚", "羽織"],
  },
];

/** Rendaku readings for common single-kanji + 々 pairs Kuromoji leaves as `々`. */
const ODORIJI_RENDAKU: Record<string, string> = {
  星: "ボシ",
  花: "バナ",
  島: "ジマ",
  国: "グニ",
  木: "ギ",
  人: "ビト",
  日: "ビ",
  時: "ドキ",
  度: "タビ",
  品: "ジナ",
  方: "ガタ",
  声: "ゴエ",
  手: "デ",
  先: "ザキ",
  知: "ジ",
  近: "ジカ",
  常: "ヅネ",
  深: "ブカ",
  隅: "ズミ",
  端: "バシ",
  節: "ブシ",
  所: "ドコロ",
  口: "グチ",
  中: "ジュウ",
  事: "ゴト",
  神: "ガミ",
};

/** Last-resort fallback readings for kanji IPAdic occasionally leaves unresolved. */
const FALLBACK_KANJI_READINGS: Record<string, string> = {
  鬱: "ウツ",
  唱: "ショウ",
  嗤: "ワラ",
  踠: "モガ",
  煌: "キラ",
  眩: "マブ",
  儚: "ハカナ",
  紡: "ツム",
  凛: "リン",
  凜: "リン",
  澪: "ミオ",
  焔: "ホノオ",
  絆: "キズナ",
  刹: "セツ",
  醒: "サ",
  褪: "ア",
  零: "コボ",
  溢: "アフ",
  滲: "ニジ",
  霞: "カスミ",
  閃: "ヒラメ",
  轟: "トドロ",
  囁: "ササヤ",
  呟: "ツブヤ",
  嘲: "アザ",
  跪: "ヒザマズ",
  躓: "ツマズ",
  縋: "スガ",
  抗: "アラガ",
  俯: "ウツム",
  仰: "アオ",
  蕩: "トロ",
  苛: "イラ",
  曖: "アイ",
  昧: "マイ",
  薔: "バ",
  薇: "ラ",
  呪: "ノロ",
  棘: "トゲ",
  檻: "オリ",
  蝶: "チョウ",
  鴉: "カラス",
  狼: "オオカミ",
  狐: "キツネ",
  雫: "シズク",
  蕾: "ツボミ",
  廻: "メグ",
  辿: "タド",
  繋: "ツナ",
  祈: "イノ",
  誓: "チカ",
  叫: "サケ",
  咽: "ムセ",
  慟: "ドウ",
  哭: "コク",
  躊: "チュウ",
  躇: "チョ",
  翠: "スイ",
  碧: "ヘキ",
  蒼: "アオ",
  紅: "クレナイ",
  朱: "アケ",
  茜: "アカネ",
  藍: "アイ",
  漆: "ウルシ",
  翳: "カゲ",
  謳: "ウタ",
  翔: "カケ",
  遙: "ハル",
  遥: "ハル",
  栞: "シオリ",
  凪: "ナギ",
};

const DAKUTEN_MAP: Record<string, string> = {
  カ: "ガ",
  キ: "ギ",
  ク: "グ",
  ケ: "ゲ",
  コ: "ゴ",
  サ: "ザ",
  シ: "ジ",
  ス: "ズ",
  セ: "ゼ",
  ソ: "ゾ",
  タ: "ダ",
  チ: "ヂ",
  ツ: "ヅ",
  テ: "デ",
  ト: "ド",
  ハ: "バ",
  ヒ: "ビ",
  フ: "ブ",
  ヘ: "ベ",
  ホ: "ボ",
  ウ: "ヴ",
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function toRawHiragana(str: string): string {
  return [...str]
    .map((ch) => {
      if (ch > "\u30a0" && ch < "\u30f7") {
        return String.fromCharCode(ch.charCodeAt(0) + KATAKANA_TO_HIRAGANA_SHIFT);
      }
      return ch;
    })
    .join("");
}

export function toRawKatakana(str: string): string {
  return [...str]
    .map((ch) => {
      if (ch > "\u3040" && ch < "\u3097") {
        return String.fromCharCode(ch.charCodeAt(0) + HIRAGANA_TO_KATAKANA_SHIFT);
      }
      return ch;
    })
    .join("");
}

function isPureKanaOrMark(str: string): boolean {
  if (!str) return false;
  for (const ch of str) {
    if (!KANA_OR_MARK.test(ch)) return false;
  }
  return true;
}

function isWhitespaceToken(token: Pick<NormalizedToken, "surface_form" | "pos_detail_1">): boolean {
  return token.pos_detail_1 === "空白" || /^\s+$/.test(token.surface_form);
}

function isPunctuationSurface(surface: string): boolean {
  return OPEN_BRACKETS.has(surface) || TRAILING_PUNCT_RE.test(surface);
}

function isVowel(ch: string | undefined): boolean {
  return ch === "a" || ch === "i" || ch === "u" || ch === "e" || ch === "o";
}

function isAsciiLetterOrDigit(ch: string | undefined): boolean {
  return ch !== undefined && LATIN_OR_DIGIT.test(ch);
}

/**
 * Convert a kana string into per-character Modified Hepburn romaji slots.
 *
 * `slots.length === [...kana].length` always holds so syllable cuts inside a
 * kana token never re-interpret `っ`, `ー`, `ん`, or digraphs (`とぅ`, `きょう`)
 * in isolation.
 */
export function kanaToSlots(
  kana: string,
  nextRomajiHint?: string,
  prevVowelHint?: string
): string[] {
  const rawChars = [...kana];
  const kataChars = [...toRawKatakana(kana)];
  const slots = Array.from({ length: rawChars.length }, () => "");

  // First pass: resolve regular kana and two-kana digraphs, leaving っ / ー / ン
  // for pass 2 once neighbouring romaji onsets and preceding vowels are known.
  let i = 0;
  while (i < kataChars.length) {
    const ch = kataChars[i];
    if (ch === "ッ" || ch === "ン" || ch === "ー") {
      i += 1;
      continue;
    }

    if (i + 1 < kataChars.length) {
      const pair = ch + kataChars[i + 1];
      const digraph = DIGRAPH_KANA[pair];
      if (digraph) {
        slots[i] = digraph[0];
        slots[i + 1] = digraph[1];
        i += 2;
        continue;
      }
    }

    slots[i] = SINGLE_KANA[ch] ?? rawChars[i];
    i += 1;
  }

  // Second pass (left-to-right for ー): resolve prolonged sound marks so chained
  // marks (あーー -> aaa) inherit the vowel immediately before them.
  let lastVowel = prevVowelHint;
  for (let idx = 0; idx < kataChars.length; idx += 1) {
    const ch = kataChars[idx];
    if (ch === "ー") {
      if (lastVowel && isVowel(lastVowel)) {
        slots[idx] = lastVowel;
      } else {
        slots[idx] = "";
      }
      continue;
    }

    if (ch === "ッ" || ch === "ン") {
      lastVowel = undefined;
      continue;
    }

    const piece = slots[idx];
    const tail = piece.slice(-1);
    lastVowel = isVowel(tail) ? tail : undefined;
  }

  // Third pass (right-to-left for ッ and ン): geminate against the next onset
  // and insert apostrophes before vowels / y after ん.
  let nextOnset = nextRomajiHint ?? "";
  for (let idx = kataChars.length - 1; idx >= 0; idx -= 1) {
    const ch = kataChars[idx];
    if (ch === "ッ") {
      const first = nextOnset[0];
      if (nextOnset.startsWith("ch")) {
        slots[idx] = "t";
      } else if (first && /^[bcdfghjklmnpqrstvwxyz]$/.test(first)) {
        slots[idx] = first;
      } else if (first === "'") {
        // Repeated trailing っっ -> single glottal stop at the end.
        slots[idx] = "";
      } else {
        slots[idx] = "'";
      }
      nextOnset = slots[idx] || nextOnset;
      continue;
    }

    if (ch === "ン") {
      const first = nextOnset[0];
      slots[idx] = first && (isVowel(first) || first === "y") ? "n'" : "n";
      nextOnset = slots[idx];
      continue;
    }

    const piece = slots[idx];
    if (piece !== "") {
      nextOnset = piece;
    }
  }

  return slots;
}

export function kanaToRomaji(
  kana: string,
  nextRomajiHint?: string,
  prevVowelHint?: string
): string {
  return kanaToSlots(kana, nextRomajiHint, prevVowelHint).join("");
}

/**
 * Normalize Kuromoji tokens: fill readings, fix particles and compound blind
 * spots, merge split small-kana digraphs / standalone っ / ー, and annotate
 * ASCII quote parity. Never drops or reorders characters so surface concatenation
 * stays identical to `line`.
 */
function normalizeTokens(rawTokens: readonly any[]): NormalizedToken[] {
  // 1. Clone and initialize clean katakana readings
  const initial: NormalizedToken[] = rawTokens.map((t) => {
    const surface: string = t.surface_form ?? "";
    const pos: string = t.pos ?? "名詞";
    const pos_detail_1: string = t.pos_detail_1 ?? "*";
    const pos_detail_2: string | undefined = t.pos_detail_2;
    const pron: string | undefined = t.pronunciation;
    let reading: string = t.reading ?? "";

    if (JAPANESE_CHAR.test(surface)) {
      if (!reading) {
        reading = isPureKanaOrMark(surface) ? toRawKatakana(surface) : surface;
      } else {
        reading = toRawKatakana(reading);
      }

      // Preserve phonetic trailing ハ->ワ from pronunciation (e.g. では, それでは,
      // こんにちは, こんばんは) without adopting macron pronunciations like トーキョー.
      if (pron && pron.endsWith("ワ") && reading.endsWith("ハ") && reading.length === pron.length) {
        reading = `${reading.slice(0, -1)}ワ`;
      }

      if (pos === "助詞") {
        if (surface === "は") reading = "ワ";
        else if (surface === "へ") reading = "エ";
        else if (surface === "を") reading = "オ";
      }
    } else {
      reading = surface;
    }

    return {
      surface_form: surface,
      reading,
      pronunciation: pron,
      pos,
      pos_detail_1,
      pos_detail_2,
    };
  });

  // 2. Compound & contextual reading overrides (exact surface sequences)
  const compounded: NormalizedToken[] = [];
  for (let i = 0; i < initial.length; i += 1) {
    const curr = initial[i];
    let matched = false;

    for (const rule of COMPOUND_OVERRIDES) {
      const len = rule.surfaces.length;
      if (i + len > initial.length) continue;

      let ok = true;
      for (let k = 0; k < len; k += 1) {
        if (initial[i + k].surface_form !== rule.surfaces[k]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      if (rule.notFollowedBy && i + len < initial.length) {
        const nextSurf = initial[i + len].surface_form;
        if (rule.notFollowedBy.some((prefix) => nextSurf.startsWith(prefix))) {
          continue;
        }
      }

      if (rule.readings && rule.readings.length === len) {
        for (let k = 0; k < len; k += 1) {
          compounded.push({
            surface_form: rule.surfaces[k],
            reading: rule.readings[k],
            pos: rule.pos,
            pos_detail_1: rule.pos_detail_1,
            forceAttachNext: k < len - 1,
          });
        }
      } else {
        compounded.push({
          surface_form: rule.surfaces.join(""),
          reading: rule.reading ?? "",
          pos: rule.pos,
          pos_detail_1: rule.pos_detail_1,
        });
      }
      i += len - 1;
      matched = true;
      break;
    }
    if (matched) continue;

    // 藻掻く / 藻掻い / 藻掻き / 藻掻け
    if (
      curr.surface_form === "藻" &&
      i + 1 < initial.length &&
      /^掻[くいけこき]/.test(initial[i + 1].surface_form)
    ) {
      const next = initial[i + 1];
      compounded.push({
        surface_form: curr.surface_form + next.surface_form,
        reading: `モガ${next.reading.slice(1)}`,
        pos: "動詞",
        pos_detail_1: "自立",
      });
      i += 1;
      continue;
    }

    // 彷徨う / 彷徨い / 彷徨っ... (Kuromoji reads 彷徨 as ホウコウ)
    if (
      curr.surface_form === "彷徨" &&
      i + 1 < initial.length &&
      /^[ういえわおっ]/.test(initial[i + 1].surface_form)
    ) {
      const next = initial[i + 1];
      if (/^[ういえわおっ]$/.test(next.surface_form)) {
        compounded.push({
          surface_form: curr.surface_form + next.surface_form,
          reading: `サマヨ${next.reading}`,
          pos: "動詞",
          pos_detail_1: "自立",
        });
        i += 1;
        continue;
      }
      curr.reading = "サマヨ";
      curr.pos = "動詞";
      curr.pos_detail_1 = "自立";
    }

    // Unknown kanji verb stems resolved via fallback (e.g. 嗤う, 踠く)
    if (
      (curr.surface_form === "嗤" || curr.surface_form === "踠") &&
      curr.reading === curr.surface_form &&
      i + 1 < initial.length &&
      /^[うくぐすつぬぶむるいえわっ]/.test(initial[i + 1].surface_form)
    ) {
      curr.reading = FALLBACK_KANJI_READINGS[curr.surface_form] ?? curr.reading;
      curr.pos = "動詞";
      curr.pos_detail_1 = "自立";
    }

    // 愛してる / 愛してた (context sometimes flips 愛し to イトシ)
    if (
      curr.surface_form === "愛し" &&
      curr.reading === "イトシ" &&
      i + 1 < initial.length &&
      /^[てた]/.test(initial[i + 1].surface_form)
    ) {
      curr.reading = "アイシ";
    }

    compounded.push(curr);
  }

  // 3. Phonetic merging: fix Kuromoji splitting small kana, ー, standalone っ,
  // 動詞+う, and iteration marks (々/ゝ/ゞ/ヽ/ヾ). Never merge across whitespace or punct.
  const merged: NormalizedToken[] = [];
  for (let i = 0; i < compounded.length; i += 1) {
    const curr = compounded[i];
    const prev = merged.length > 0 ? merged[merged.length - 1] : null;

    if (prev && !isWhitespaceToken(prev) && !isWhitespaceToken(curr)) {
      const prevIsPunct = isPunctuationSurface(prev.surface_form);
      const currIsPunct = isPunctuationSurface(curr.surface_form);

      // 3a. Leading small kana (と+ぅ, て+ぃ, ふ+ぁ, ヴ+ぁ, う+ぉ, うっせ+ぇわ)
      if (
        !prevIsPunct &&
        !currIsPunct &&
        LEADING_SMALL_KANA.test(curr.surface_form) &&
        KANA_OR_MARK.test(prev.reading.slice(-1)) &&
        !/[ンッ]/.test(prev.reading.slice(-1))
      ) {
        prev.surface_form += curr.surface_form;
        prev.reading += curr.reading;
        // If the merged tail is a particle/ending (e.g. うっせ + ぇわ), update POS
        if (curr.pos === "助詞" || curr.pos === "助動詞") {
          prev.pos = curr.pos;
          prev.pos_detail_1 = curr.pos_detail_1;
        }
        continue;
      }

      // 3b. Standalone prolonged sound mark ー (てぃ+ー, うぉ+ー, ふぁんたじ+ー)
      if (
        !prevIsPunct &&
        LONG_MARK_ONLY.test(curr.surface_form) &&
        KANA_OR_MARK.test(prev.reading.slice(-1))
      ) {
        prev.surface_form += curr.surface_form;
        prev.reading += curr.surface_form;
        continue;
      }

      // 3c. Standalone "い" after an interjection ending in ー (うぇー+い -> うぇーい)
      if (
        !prevIsPunct &&
        curr.surface_form === "い" &&
        (curr.pos === "動詞" || curr.pos === "感動詞" || curr.pos === "名詞") &&
        prev.reading.endsWith("ー") &&
        prev.pos !== "名詞"
      ) {
        prev.surface_form += curr.surface_form;
        prev.reading += curr.reading;
        continue;
      }

      // 3d. Standalone っ / ッ token (大+っ, 飛んじゃ+っ, くそ+っ), unless part of a split compound override
      if (
        !prevIsPunct &&
        !prev.forceAttachNext &&
        SOKUON_ONLY.test(curr.surface_form) &&
        JAPANESE_CHAR.test(prev.surface_form)
      ) {
        prev.surface_form += curr.surface_form;
        prev.reading += "ッ";
        continue;
      }

      // 3e. Volitional う after verb/auxiliary ending in -o or -a (行こ+う, ましょ+う, じゃ+う)
      if (
        (curr.surface_form === "う" || curr.surface_form === "ウ") &&
        (curr.pos === "助動詞" || curr.pos === "感動詞") &&
        (prev.pos === "動詞" ||
          prev.pos === "助動詞" ||
          (prev.pos === "助詞" && /^(ちゃ|じゃ)$/.test(prev.surface_form))) &&
        /[オコソトノホモヨロゴゾドボポョャ]$/.test(prev.reading)
      ) {
        prev.surface_form += curr.surface_form;
        prev.reading += "ウ";
        if (prev.pos === "助詞") {
          prev.pos = "動詞";
          prev.pos_detail_1 = "非自立";
        }
        continue;
      }

      // 3f. Verb/Adj ending in っ followed immediately by non-punct/non-space token (patchTokens safe equivalent)
      if (
        (prev.pos === "動詞" || prev.pos === "形容詞") &&
        prev.surface_form.length > 1 &&
        /[っッ]$/.test(prev.surface_form) &&
        !currIsPunct &&
        (curr.pos === "助詞" ||
          curr.pos === "助動詞" ||
          curr.pos_detail_1 === "接尾" ||
          curr.pos_detail_1 === "非自立")
      ) {
        prev.surface_form += curr.surface_form;
        prev.reading += curr.reading;
        prev.pos = curr.pos;
        prev.pos_detail_1 = curr.pos_detail_1;
        continue;
      }

      // 3g. Ideographic iteration mark 々 (星々 -> 星 + 々 -> ホシボシ)
      if (curr.surface_form === "々" && HAN.test(prev.surface_form.slice(-1))) {
        const lastKanji = prev.surface_form.slice(-1);
        const repReading =
          ODORIJI_RENDAKU[lastKanji] ??
          ([...prev.surface_form].length === 1
            ? prev.reading
            : (FALLBACK_KANJI_READINGS[lastKanji] ?? prev.reading));
        prev.surface_form += "々";
        prev.reading += repReading;
        continue;
      }

      // 3h. Kana iteration marks ゝ/ゞ/ヽ/ヾ
      if (/^[ゝゞヽヾ]$/.test(curr.surface_form) && KANA.test(prev.reading.slice(-1))) {
        const baseKana = prev.reading.slice(-1);
        const voiced = curr.surface_form === "ゞ" || curr.surface_form === "ヾ";
        const rep = voiced ? (DAKUTEN_MAP[baseKana] ?? baseKana) : baseKana;
        prev.surface_form += curr.surface_form;
        prev.reading += rep;
        continue;
      }
    }

    merged.push(curr);
  }

  // 4. Fallback kanji replacement if Kuromoji left any Han character in reading
  for (const token of merged) {
    if (HAN.test(token.reading)) {
      token.reading = [...token.reading].map((ch) => FALLBACK_KANJI_READINGS[ch] ?? ch).join("");
    }
  }

  // 5. Annotate quote parity and intra-word apostrophes/hyphens
  let inDoubleQuote = false;
  let inSingleQuote = false;
  for (let i = 0; i < merged.length; i += 1) {
    const curr = merged[i];
    const prev = i > 0 ? merged[i - 1] : null;
    const next = i + 1 < merged.length ? merged[i + 1] : null;

    if (/^"+$/.test(curr.surface_form)) {
      const prevBoundary =
        prev === null || isWhitespaceToken(prev) || OPEN_BRACKETS.has(prev.surface_form);
      if (!inDoubleQuote && prevBoundary) {
        curr.quoteRole = "open";
        inDoubleQuote = true;
      } else {
        curr.quoteRole = "close";
        inDoubleQuote = false;
      }
    } else if (/^['’]+$/.test(curr.surface_form)) {
      const prevLatin = prev !== null && isAsciiLetterOrDigit(prev.surface_form.slice(-1));
      const nextLatin = next !== null && isAsciiLetterOrDigit(next.surface_form[0]);
      if (prevLatin && nextLatin) {
        curr.quoteRole = "intra";
      } else {
        const prevBoundary =
          prev === null || isWhitespaceToken(prev) || OPEN_BRACKETS.has(prev.surface_form);
        if (!inSingleQuote && prevBoundary) {
          curr.quoteRole = "open";
          inSingleQuote = true;
        } else {
          curr.quoteRole = "close";
          inSingleQuote = false;
        }
      }
    } else if (/^[-‐]+$/.test(curr.surface_form)) {
      const prevLatin = prev !== null && isAsciiLetterOrDigit(prev.surface_form.slice(-1));
      const nextLatin = next !== null && isAsciiLetterOrDigit(next.surface_form[0]);
      if (prevLatin && nextLatin) {
        curr.quoteRole = "intra";
      }
    }
  }

  return merged;
}

const VERB_ADJ_INFLECTIONS = new Set([
  "た",
  "だ",
  "て",
  "で",
  "ない",
  "なかっ",
  "なく",
  "なけれ",
  "な",
  "ぬ",
  "ん",
  "ず",
  "ざる",
  "まい",
  "ます",
  "まし",
  "ませ",
  "ましょ",
  "たい",
  "たかっ",
  "たく",
  "たけれ",
  "たがる",
  "たがっ",
  "れる",
  "られ",
  "れ",
  "せる",
  "させ",
  "せ",
  "う",
  "よう",
  "そう",
]);

const CONTRACTED_SUBSIDIARY_RE =
  /^(てる|てた|てて|てく|てっ|てみ|てお|とく|とっ|どく|どっ|でる|でた|でて|でく|でっ|ちゃう|ちゃっ|ちゃお|ちゃえ|じゃう|じゃっ|じゃお|じゃえ|ちまう|ちまっ|じまう|じまっ|すぎる|すぎ|すぎた|すぎれ|やすい|にくい|づらい|て$)/;

/**
 * Checks whether the current token attaches directly to the previous token without a space.
 */
function shouldAttach(
  prevToken: NormalizedToken | null,
  currToken: NormalizedToken | null
): boolean {
  if (!prevToken || !currToken) return false;
  if (isWhitespaceToken(prevToken) || isWhitespaceToken(currToken)) return false;
  if (prevToken.forceAttachNext) return true;

  // Quotes and intra-word apostrophes/hyphens
  if (currToken.quoteRole === "open") return false;
  if (currToken.quoteRole === "close" || currToken.quoteRole === "intra") return true;
  if (prevToken.quoteRole === "open" || prevToken.quoteRole === "intra") return true;
  if (prevToken.quoteRole === "close") {
    return TRAILING_PUNCT_RE.test(currToken.surface_form);
  }

  // Opening and closing brackets / punctuation (covers both 記号 and ASCII punct tagged 名詞)
  if (OPEN_BRACKETS.has(currToken.surface_form)) return false;
  if (OPEN_BRACKETS.has(prevToken.surface_form)) {
    return !TRAILING_PUNCT_RE.test(currToken.surface_form);
  }
  if (TRAILING_PUNCT_RE.test(currToken.surface_form)) return true;
  if (TRAILING_PUNCT_RE.test(prevToken.surface_form)) return false;

  // Suffixes attach to previous word (e.g. 達, 集, 様, さん, ちゃん, っぽい, れ, られ)
  if (currToken.pos_detail_1 === "接尾") return true;

  // Prefixes attach to next word (e.g. お-, ご-, 超-, 新-)
  if (prevToken.pos === "接頭詞") return true;

  // Contracted moraic nasal ん (e.g. 踊ってんだ -> odotten da, 飽きっぽいんだ -> akippoin da, 好きなんだ -> suki nan da)
  if (
    currToken.surface_form === "ん" &&
    currToken.pos === "名詞" &&
    currToken.pos_detail_1 === "非自立"
  ) {
    if (
      prevToken.pos === "動詞" ||
      prevToken.pos === "形容詞" ||
      prevToken.pos === "助動詞" ||
      prevToken.pos_detail_1 === "接尾" ||
      (prevToken.pos === "助詞" && prevToken.pos_detail_1 === "接続助詞")
    ) {
      return true;
    }
  }

  // Sentence-ending particle っけ (誰だっけ -> dare dakke, かっけぇ -> kakkee)
  if (
    currToken.pos === "助詞" &&
    currToken.pos_detail_1 === "終助詞" &&
    currToken.surface_form.startsWith("っけ")
  ) {
    return true;
  }

  // Contracted auxiliary / subsidiary verbs & adjectives (てる, ちゃう, とく, すぎる, やすい, づらい)
  if (
    (currToken.pos === "動詞" || currToken.pos === "形容詞") &&
    currToken.pos_detail_1 === "非自立"
  ) {
    if (
      (prevToken.pos === "動詞" ||
        prevToken.pos === "形容詞" ||
        prevToken.pos === "助動詞" ||
        (prevToken.pos === "助詞" && prevToken.pos_detail_1 === "接続助詞")) &&
      CONTRACTED_SUBSIDIARY_RE.test(currToken.surface_form)
    ) {
      return true;
    }
  }

  // Conjunctive particles て/で/ちゃ/じゃ/ば attaching to verb, adjective, or auxiliary
  if (
    currToken.pos === "助詞" &&
    currToken.pos_detail_1 === "接続助詞" &&
    ["て", "で", "ちゃ", "じゃ", "ば"].includes(currToken.surface_form)
  ) {
    if (prevToken.pos === "動詞" || prevToken.pos === "形容詞" || prevToken.pos === "助動詞") {
      return true;
    }
  }

  // Auxiliary verbs (助動詞)
  if (currToken.pos === "助動詞") {
    if (prevToken.pos === "助動詞") return true;
    if (
      prevToken.pos === "助詞" &&
      prevToken.surface_form === "じゃ" &&
      ["ない", "なかっ", "なく", "なけれ"].includes(currToken.surface_form)
    ) {
      return true;
    }
    if (prevToken.pos === "動詞" || prevToken.pos === "形容詞") {
      if (VERB_ADJ_INFLECTIONS.has(currToken.surface_form)) {
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
 * own reading (歩いてる -> 歩=ある, いてる=いてる). Importantly, the whole token
 * reading is converted to per-kana slots BEFORE slicing so sokuon (`真っ白`,
 * `言っちゃった`) and digraphs never convert in isolation.
 */
function tokenGroups(
  token: NormalizedToken,
  nextCharRomajiHint?: string,
  prevVowelHint?: string
): Group[] {
  const surface = token.surface_form;
  const reading = token.reading || surface;
  const fromKanjiToken = HAN.test(surface);
  const fullSlots = kanaToSlots(reading, nextCharRomajiHint, prevVowelHint);

  if (!fromKanjiToken) {
    return [
      {
        surface,
        reading,
        slots: fullSlots,
        romaji: fullSlots.join(""),
        fromKanjiToken: false,
        token,
      },
    ];
  }

  const runs: { kanji: boolean; surface: string }[] = [];
  let pattern = "";
  let kanjiRun = "";
  let kanaRun = "";

  const flushKanji = () => {
    if (kanjiRun === "") return;
    runs.push({ kanji: true, surface: kanjiRun });
    pattern += "(.+?)";
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
  const readingChars = [...reading];
  const match = new RegExp(`^${pattern}$`).exec(toRawHiragana(reading));
  if (!match || fullSlots.length !== readingChars.length) {
    return [
      {
        surface,
        reading,
        slots: fullSlots,
        romaji: fullSlots.join(""),
        fromKanjiToken: true,
        token,
      },
    ];
  }

  const groups: Group[] = [];
  let pick = 1;
  let offset = 0;
  for (const run of runs) {
    const length = run.kanji
      ? [...(match[pick++] ?? "")].length
      : [...toRawHiragana(run.surface)].length;
    const read = readingChars.slice(offset, offset + length).join("");
    const runSlots = fullSlots.slice(offset, offset + length);
    offset += length;
    groups.push({
      surface: run.surface,
      reading: read,
      slots: runSlots,
      romaji: runSlots.join(""),
      fromKanjiToken: true,
      token,
    });
  }

  if (offset !== readingChars.length) {
    return [
      {
        surface,
        reading,
        slots: fullSlots,
        romaji: fullSlots.join(""),
        fromKanjiToken: true,
        token,
      },
    ];
  }
  return groups;
}

/**
 * Join the line's syllables the way it is actually written.
 *
 * When `isPartOfWord === false` (explicit space in the source lyrics, such as
 * `とぅ とぅる` or `踊ってんだ 失敬`), we preserve that space in `line` so
 * Kuromoji does not fuse separate words into unknown tokens, and record it in
 * `explicitSpaceAfter` so `distribute` keeps `isPartOfWord = false`.
 */
function buildLine(items: readonly JapaneseSyllableInput[]): {
  line: string;
  ranges: [number, number][];
  explicitSpaceAfter: boolean[];
} {
  let line = "";
  const ranges: [number, number][] = [];
  const explicitSpaceAfter = Array.from({ length: items.length }, () => false);

  items.forEach((item, index) => {
    const text = item.text;
    if (index > 0 && text !== "") {
      const prevItem = items[index - 1];
      const prevText = prevItem.text;
      if (prevText !== "") {
        const needsExplicitSpace =
          prevItem.isPartOfWord === false && !/\s$/.test(prevText) && !/^\s/.test(text);
        const needsImplicitLatinSpace =
          prevItem.isPartOfWord === undefined &&
          LATIN_OR_DIGIT.test(prevText.slice(-1)) &&
          LATIN_OR_DIGIT.test(text[0]);

        if (needsExplicitSpace || needsImplicitLatinSpace) {
          line += " ";
          if (prevItem.isPartOfWord === false) {
            explicitSpaceAfter[index - 1] = true;
          }
        }
      }
    }

    const start = line.length;
    line += text;
    ranges.push([start, line.length]);
  });

  return { line, ranges, explicitSpaceAfter };
}

/** Turn the normalized token stream into aligned groups with cross-token phonetic context. */
function groupLine(tokens: readonly NormalizedToken[]): {
  groups: Group[];
  attachedToNext: boolean[];
} {
  const attachedToNext = tokens.map((token, i) =>
    i + 1 < tokens.length ? shouldAttach(token, tokens[i + 1]) : false
  );

  // First pass: compute base slots without cross-token hints so we can read each
  // attached neighbor's initial romaji onset and trailing vowel cleanly.
  const baseOnsets = tokens.map((token) => {
    const r = token.reading || token.surface_form;
    return r ? kanaToRomaji(r) : "";
  });

  const groups: Group[] = [];
  let prevTailVowel: string | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const nextHint = attachedToNext[i] ? baseOnsets[i + 1] : undefined;
    const prevHint = i > 0 && attachedToNext[i - 1] ? prevTailVowel : undefined;

    const tokenGroupList = tokenGroups(token, nextHint, prevHint);
    groups.push(...tokenGroupList);

    const lastGroup = tokenGroupList[tokenGroupList.length - 1];
    const lastChar = lastGroup?.romaji.slice(-1);
    prevTailVowel = isVowel(lastChar) ? lastChar : undefined;
  }

  return { groups, attachedToNext };
}

/** Hand each range the slice of its groups' romaji it covers. */
function distribute(
  groups: readonly Group[],
  ranges: readonly [number, number][],
  explicitSpaceAfter: readonly boolean[],
  items: readonly JapaneseSyllableInput[]
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
        } else if (!group.fromKanjiToken && group.slots.length > 0) {
          if (group.slots.length === group.surface.length) {
            piece = group.slots.slice(from, to).join("");
          } else {
            const slotFrom = Math.floor((group.slots.length * from) / group.surface.length);
            const slotTo = Math.floor((group.slots.length * to) / group.surface.length);
            piece = group.slots.slice(slotFrom, slotTo).join("");
          }
        } else {
          // A split inside a kanji run has no reading boundary to cut at; keep
          // the romaji proportional to the characters on each side.
          const romajiFrom = Math.floor((group.romaji.length * from) / group.surface.length);
          const romajiTo = Math.floor((group.romaji.length * to) / group.surface.length);
          piece = group.romaji.slice(romajiFrom, romajiTo);
        }

        if (
          lastGroup &&
          lastGroup.token !== group.token &&
          !shouldAttach(lastGroup.token, group.token)
        ) {
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

    // Determine whether this syllable range continues into the next range as part of the same word.
    // An explicit space in the source lyrics (isPartOfWord === false) is always preserved.
    let isPartOfWord = false;
    if (
      rangeIdx < ranges.length - 1 &&
      !explicitSpaceAfter[rangeIdx] &&
      items[rangeIdx].isPartOfWord !== false
    ) {
      if (endsInsideGroup) {
        isPartOfWord = true;
      } else if (endingGroupIndex >= 0 && endingGroupIndex + 1 < groups.length) {
        const nextRangeStart = ranges[rangeIdx + 1][0];
        if (nextRangeStart > end) {
          // Synthetic space exists between ranges
          isPartOfWord = false;
        } else {
          const currGroup = groups[endingGroupIndex];
          const nextGroup = groups[endingGroupIndex + 1];
          isPartOfWord =
            currGroup.token === nextGroup.token || shouldAttach(currGroup.token, nextGroup.token);
        }
      }
    }

    const isWhitespaceOnlyInput = items[rangeIdx].text.trim() === "";
    let cleaned = result
      .replace(/\s+([」』）\]}”’】〉》〕］｝〟、。，．,.!?！？…‥:;：；%％])/g, "$1")
      .replace(/([「『（[{“‘【〈《〔［｛〝])\s+/g, "$1")
      .replace(/ +/g, " ");

    if (!isWhitespaceOnlyInput) {
      cleaned = cleaned.trim();
    }

    return {
      text: cleaned,
      isPartOfWord,
    };
  });
}

/** Per-text fallback for the rare line the token stream can't be aligned to. */
async function romanizeEach(
  items: readonly JapaneseSyllableInput[],
  tokenize: (text: string) => Promise<any[]> | any[]
): Promise<JapaneseSyllableResult[]> {
  return Promise.all(
    items.map(async (item) => {
      if (item.text.trim() === "") {
        return { text: item.text, isPartOfWord: item.isPartOfWord ?? false };
      }
      const rawTokens = await tokenize(item.text);
      const tokens = normalizeTokens(rawTokens);
      if (tokens.map((t) => t.surface_form).join("") === item.text) {
        const { groups } = groupLine(tokens);
        const [single] = distribute(groups, [[0, item.text.length]], [false], [item]);
        return { text: single.text, isPartOfWord: item.isPartOfWord ?? false };
      }
      return { text: kanaToRomaji(item.text), isPartOfWord: item.isPartOfWord ?? false };
    })
  );
}

/**
 * Pure core pipeline accepting an arbitrary Kuromoji-compatible tokenizer.
 * Exported for unit testing without loading the remote dictionary.
 */
export async function romanizeJapaneseWithTokenizer(
  texts: readonly (string | JapaneseSyllableInput)[],
  tokenize: (text: string) => Promise<any[]> | any[]
): Promise<JapaneseSyllableResult[]> {
  const items: JapaneseSyllableInput[] = texts.map((entry) =>
    typeof entry === "string"
      ? { text: entry.normalize("NFKC") }
      : { text: entry.text.normalize("NFKC"), isPartOfWord: entry.isPartOfWord }
  );

  const { line, ranges, explicitSpaceAfter } = buildLine(items);

  if (line.trim() === "") {
    return items.map((item) => ({ text: item.text, isPartOfWord: item.isPartOfWord ?? false }));
  }

  const rawTokens = await tokenize(line);
  const tokens = normalizeTokens(rawTokens);
  const { groups } = groupLine(tokens);

  // The token stream should tile the line exactly. If it doesn't, something in
  // the dictionary surprised us; convert syllable by syllable rather than
  // shifting every later syllable's romaji by one.
  const tiled = groups.length > 0 && groups.map((group) => group.surface).join("") === line;
  if (!tiled) return romanizeEach(items, tokenize);

  return distribute(groups, ranges, explicitSpaceAfter, items);
}

/**
 * Romanize one line's syllables, returning one result per input syllable/line.
 *
 * `texts` are the line's syllables in order (either strings or `{ text, isPartOfWord }`).
 * Empty or punctuation-only entries stay in the line so the tokenizer sees the whole
 * sentence, and their slice comes back as the matching punctuation.
 */
export async function RomanizeJapaneseSyllables(
  texts: readonly (string | JapaneseSyllableInput)[]
): Promise<JapaneseSyllableResult[]> {
  await JapaneseRomanizerReady;
  return romanizeJapaneseWithTokenizer(texts, (line) => KuromojiAnalyzer.parse(line));
}
