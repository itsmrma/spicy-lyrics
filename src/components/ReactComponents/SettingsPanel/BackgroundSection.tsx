import { useStore } from "@nanostores/react";
import {
  $backgroundBlur,
  $backgroundStyle,
  $showNpvDynamicBg,
  BACKGROUND_STYLES,
  type BackgroundStyle,
} from "../../../utils/stores.ts";
import { $experiment, getExperiment } from "../../../utils/experiments.ts";
import { Select, Slider, Toggle } from "./components.tsx";
import { BackgroundIcon } from "./icons.tsx";
import type { GroupDef, SectionDef } from "./model.ts";

export const BACKGROUND_STYLE_LABELS: Record<BackgroundStyle, string> = {
  dynamic: "Dynamic (Kawarp)",
  "cover-blur": "Cover Art (Blurred)",
  cover: "Cover Art",
  "artist-blur": "Artist Image (Blurred)",
  artist: "Artist Image",
  color: "Cover Colors",
  none: "None (Transparent)",
};

// Built once: the Control components must keep their identity across renders.
const groups: GroupDef[] = [
  {
    title: "Lyrics View",
    settings: [
      {
        id: "backgroundStyle",
        label: "Background",
        description:
          "Dynamic (Kawarp) swirls the cover art in time with the music. Cover Art (Blurred) blurs the album cover across the whole view. Artist Image uses the artist's header photo. None (Transparent) leaves the page see-through.",
        keywords: "static animated kawarp artist header cover art blur color colors image transparent none theme",
        useNote: () => {
          const isPerf = useStore($experiment("performanceMode"));
          if (isPerf) {
            return "Dynamic (Kawarp) is disabled while Performance Mode is active.";
          }
          const style = useStore($backgroundStyle);
          const canvasStage = useStore($experiment("canvasImmersive"));
          return (
            style !== "dynamic" &&
            canvasStage &&
            `${getExperiment("canvasImmersive").label} only plays over Dynamic (Kawarp), so it won't show with ${BACKGROUND_STYLE_LABELS[style] ?? "this background"}.`
          );
        },
        Control: ({ label }) => {
          const isPerf = useStore($experiment("performanceMode"));
          const currentStyle = useStore($backgroundStyle);
          const availableStyles = isPerf
            ? BACKGROUND_STYLES.filter((s) => s !== "dynamic")
            : [...BACKGROUND_STYLES];
          return (
            <Select
              label={label}
              value={isPerf && currentStyle === "dynamic" ? "cover-blur" : currentStyle}
              options={availableStyles}
              labels={availableStyles.map((style) => BACKGROUND_STYLE_LABELS[style])}
              onChange={(v) => {
                if (isPerf && v === "dynamic") return;
                $backgroundStyle.set(v as BackgroundStyle);
              }}
            />
          );
        },
      },
      {
        id: "backgroundBlur",
        label: "Image Blur",
        description: "Softens the Artist Image and Cover Art backgrounds.",
        keywords: "static background blur",
        stacked: true,
        useDisabled: () => {
          const style = useStore($backgroundStyle);
          const isImage =
            style === "artist" ||
            style === "artist-blur" ||
            style === "cover" ||
            style === "cover-blur";
          return !isImage && "Only applies to Artist Image and Cover Art backgrounds.";
        },
        Control: ({ disabled, label }) => (
          <Slider
            label={label}
            value={useStore($backgroundBlur)}
            min={0}
            max={120}
            step={1}
            defaultValue={64}
            unit="px"
            onChange={(v) => $backgroundBlur.set(v)}
            disabled={disabled}
          />
        ),
      },
    ],
  },
  {
    title: "Now Playing Sidebar",
    settings: [
      {
        id: "showNpvDynamicBg",
        label: "Animated Background",
        description: "Show the Dynamic (Kawarp) background behind the Now Playing sidebar.",
        keywords: "dynamic background npv now playing view kawarp",
        useDisabled: () => {
          const isPerf = useStore($experiment("performanceMode"));
          return isPerf ? "Disabled in Performance Mode to reduce resource usage." : undefined;
        },
        Control: ({ disabled, label }) => {
          const isPerf = useStore($experiment("performanceMode"));
          return (
            <Toggle
              label={label}
              disabled={disabled}
              locked={isPerf}
              checked={isPerf ? false : useStore($showNpvDynamicBg)}
              onChange={(v) => {
                if (isPerf) return;
                $showNpvDynamicBg.set(v);
              }}
            />
          );
        },
      },
    ],
  },
];

export const backgroundSection: SectionDef = {
  id: "background",
  title: "Background",
  icon: BackgroundIcon,
  groups: () => groups,
};
