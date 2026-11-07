import { useStore } from "@nanostores/react";
import {
  ClearGeniusCache,
  useLyricsCacheStats,
} from "../../../utils/LyricsCacheTools.ts";
import {
  $creditsFollowLastLine,
  $duetLinePadding,
  $geniusAccessToken,
  $geniusProxyUrl,
  $joinSplitWords,
  $lineHoverBackground,
  $minimalLyricsMode,
  $simpleLyricsMode,
} from "../../../utils/stores.ts";
import { $experiment } from "../../../utils/experiments.ts";
import { TextInput, Toggle } from "./components.tsx";
import { LyricsIcon } from "./icons.tsx";
import type { GroupDef, SectionDef } from "./model.ts";

// Built once: the Control components must keep their identity across renders.
const groups: GroupDef[] = [
  {
    title: "Style",
    settings: [
      {
        id: "simpleLyricsMode",
        label: "Simple Lyrics Mode",
        description: "Drop the extra visual effects from the lyrics.",
        keywords: "effects plain",
        useNote: () => {
          const isPerf = useStore($experiment("performanceMode"));
          return isPerf ? "Forced on while Performance Mode is active." : undefined;
        },
        useDisabled: () => {
          const isPerf = useStore($experiment("performanceMode"));
          return isPerf ? "Forced on in Performance Mode for maximum responsiveness." : undefined;
        },
        Control: ({ disabled, label }) => {
          const isPerf = useStore($experiment("performanceMode"));
          return (
            <Toggle
              label={label}
              disabled={disabled}
              locked={isPerf}
              checked={isPerf ? true : useStore($simpleLyricsMode)}
              onChange={(v) => {
                if (isPerf) return;
                $simpleLyricsMode.set(v);
              }}
            />
          );
        },
      },
      {
        id: "minimalLyricsMode",
        label: "Minimal Lyrics Mode",
        description: "Hide lines that have already been sung in Fullscreen and Cinema View.",
        Control: ({ label }) => (
          <Toggle
            label={label}
            checked={useStore($minimalLyricsMode)}
            onChange={(v) => $minimalLyricsMode.set(v)}
          />
        ),
      },
      {
        id: "joinSplitWords",
        label: "Join Split Words",
        description: "Show a word that's sung in syllables as one word, when its parts line up evenly.",
        keywords: "syllables merge",
        Control: ({ label }) => (
          <Toggle
            label={label}
            checked={useStore($joinSplitWords)}
            onChange={(v) => $joinSplitWords.set(v)}
          />
        ),
      },
    ],
  },
  {
    title: "Lines",
    settings: [
      {
        id: "lineHoverBackground",
        label: "Highlight on Hover",
        description: "Show a soft box behind a line when you point at it.",
        keywords: "line hover background",
        Control: ({ label }) => (
          <Toggle
            label={label}
            checked={useStore($lineHoverBackground)}
            onChange={(v) => $lineHoverBackground.set(v)}
          />
        ),
      },
      {
        id: "duetLinePadding",
        label: "Duet Line Padding",
        description: "Indent each singer's lines toward their side, so duets read as two columns.",
        keywords: "indent voices",
        Control: ({ label }) => (
          <Toggle
            label={label}
            checked={useStore($duetLinePadding)}
            onChange={(v) => $duetLinePadding.set(v)}
          />
        ),
      },
      {
        id: "creditsFollowLastLine",
        label: "Credits Follow the Last Singer",
        description:
          "When a song ends on a duet line on the right, show the songwriter and provider lines on the right too.",
        keywords: "duet credits written by songwriters provided by provider align side",
        Control: ({ label }) => (
          <Toggle
            label={label}
            checked={useStore($creditsFollowLastLine)}
            onChange={(v) => $creditsFollowLastLine.set(v)}
          />
        ),
      },
    ],
  },
  {
    title: "Singer Attribution",
    settings: [
      {
        id: "geniusProxyUrl",
        label: "Genius Proxy URL",
        description:
          "URL of a CORS proxy or Cloudflare Worker that fetches Genius lyrics without Cloudflare bot protection blocking the request.",
        keywords: "genius proxy worker cloudflare singer attribution",
        Control: ({ label }) => (
          <TextInput
            label={label}
            placeholder="e.g. https://my-worker.workers.dev"
            value={useStore($geniusProxyUrl)}
            onChange={(v) => $geniusProxyUrl.set(v)}
          />
        ),
      },
      {
        id: "geniusAccessToken",
        label: "Genius Client Access Token",
        description:
          "Optional Genius API client token (from genius.com/api-clients). Used if your proxy requires it, or for metadata search.",
        keywords: "genius token api client key",
        Control: ({ label }) => (
          <TextInput
            type="password"
            label={label}
            placeholder="Genius Access Token"
            value={useStore($geniusAccessToken)}
            onChange={(v) => $geniusAccessToken.set(v)}
          />
        ),
      },
      {
        id: "clearGeniusSingerCache",
        label: "Clear Singer Attribution Cache",
        description:
          "Delete all cached Genius singer attributions. They are normally persisted for up to 30 days.",
        keywords: "clear genius singer cache storage size",
        useNote: () => {
          const { formattedGenius, geniusCount } = useLyricsCacheStats();
          return `Occupying ${formattedGenius} (${geniusCount} ${geniusCount === 1 ? "song" : "songs"} cached).`;
        },
        Control: () => {
          const { formattedGenius } = useLyricsCacheStats();
          return (
            <button
              type="button"
              className="sl-sp-btn"
              onClick={() => ClearGeniusCache(true)}
            >
              Clear ({formattedGenius})
            </button>
          );
        },
      },
    ],
  },
];

export const lyricsSection: SectionDef = {
  id: "lyrics",
  title: "Lyrics",
  icon: LyricsIcon,
  groups: () => groups,
};
