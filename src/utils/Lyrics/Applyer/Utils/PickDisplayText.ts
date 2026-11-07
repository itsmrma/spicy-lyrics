// deno-lint-ignore-file no-explicit-any

import { HasLyricsText } from "../../EmptyLines.ts";
import { StripZeroWidth } from "./StripZeroWidth.ts";

// Matches any Unicode letter that is NOT in the Latin script (e.g. Hangul,
// Hiragana, Katakana, Han/Kanji, Cyrillic, Greek, Arabic, Hebrew, Thai, etc.).
// Purely English/Latin lines contain no such characters and should never show
// a duplicate `.OriginalScript` header above the line.
const NonLatinLetterRe = /[^\P{L}\p{Script=Latin}]/u;

export function HasOriginalScriptDiff(
  entry:
    | {
        Text?: string;
        TransliteratedText?: string;
      }
    | null
    | undefined
): boolean {
  if (!entry?.Text || !entry?.TransliteratedText) return false;
  const orig = StripZeroWidth(entry.Text).trim();
  const rom = StripZeroWidth(entry.TransliteratedText).trim();
  if (!orig || !rom || orig === rom) return false;
  return NonLatinLetterRe.test(orig);
}

// Which of an entry's two texts to render.
//
// Normally that is simply the romanization when the romanized view is on and
// the original otherwise, but either one can be missing: TTML lines carrying
// only an `x-roman` span have no source text at all, and most lines have no
// romanization. Whichever side is absent falls back to the other so a line we
// kept because it has *some* text never renders blank.
export function PickDisplayText(entry: any, useRomanized: boolean): string {
  const original = entry?.Text;
  const romanized = entry?.TransliteratedText;

  if (useRomanized && romanized !== undefined) return romanized;
  if (HasLyricsText(original)) return original;
  return HasLyricsText(romanized) ? romanized : (original ?? "");
}

export default PickDisplayText;
