# Spicy Lyrics — performance fork

[![CI](https://github.com/itsmrma/spicy-lyrics/actions/workflows/ci.yml/badge.svg)](https://github.com/itsmrma/spicy-lyrics/actions/workflows/ci.yml)

A fork of [Spicy Lyrics](https://github.com/spikerko/spicy-lyrics) maintained by [itsmrma](https://github.com/itsmrma), built around one question: **how little CPU and GPU can the animated lyrics view get away with while still feeling alive?**

Spicy Lyrics replaces Spotify's lyrics view with animated lyrics, dynamic backgrounds, romanization, and customization options. It is an open-source extension for the Spotify desktop client, built on [Spicetify](https://spicetify.app).

![Extension Example](./previews/wide_home.webp)

> [!NOTE]
> **This is a performance fork.** Upstream optimises for the richest possible look; this fork keeps that look one toggle away but makes the cheap path the default. It is not the Marketplace release — installing Spicy Lyrics from the Marketplace installs upstream, not this fork.

## What this fork changes

| Area | Upstream | This fork |
|------|----------|-----------|
| Animation cost | Per-letter springs, glow and text-shadow blurs, distance blurs, backdrop blurs run all the time | **Performance Mode on by default**: letter springs, per-letter glow and shadow writes, line distance blur and container backdrop blurs are bypassed; lines are separated by opacity alone; heavy dynamic/animated backgrounds are locked off and Simple Lyrics Mode is enforced |
| Idle cost | The frame loop keeps animating while playback is paused | Animator and scroll passes are skipped while paused and the position has not moved |
| Cinema Mode & Fullscreen | Playback controls sit on top of artwork; active repeat/shuffle buttons have glow | Controls sit unobstructed; shuffle & repeat use clean indicator dots underneath without heavy drop-shadows |
| Background styles | Solid, Dynamic, Animated NPV, Static Image | Adds **Cover Art (Blurred)** and **Artist Image (Blurred)** full-bleed background modes |
| Romanization | Single-line replacement; Japanese words squished together without spacing and with spelling particle misreadings | **Natural word-spaced Japanese romaji** with phonetic particles (`wa`, `o`, `e`); **Dual-Line Romanization (YouTube Music style)** showing original script in small font above the romanized text |
| Singer attribution | Anonymous TTML agent IDs (`v1`, `v2`) or none | **Genius Singer Attribution**: automatically identifies and tags who sings which part in group songs and collaborations with singer badges and duet side-alignment |

Everything else — lyrics fetching, word-synced TTML, dynamic backgrounds, themes, settings — comes from upstream unchanged.

### Performance Mode

Performance Mode is an experiment, so it lives in **Settings → Experiments**. It is enabled by default. Turning it off restores the original spring physics and blurs in full; nothing is deleted, so you can A/B the two whenever you like.

While it is on:

- letters no longer bounce, glow or write per-frame shadow styles — the gradient sweep still follows the audio smoothly and continuously, including on sustained/held words;
- surrounding lines keep their distance without a blur, using `opacity: 1` for the active line, `0.55` for unsung and `0.35` for sung;
- smooth, linear line scrolling without bouncing ripple cascades, keeping background vocal lines and duets centered without layout stutter;
- glass surfaces become flat dark panels instead of `backdrop-filter` blurs;
- dynamic background animations (Kawarp dynamic canvas & animated NPV video) are disabled to protect CPU/GPU;
- Simple Lyrics Mode is locked on to avoid heavy DOM animation layers;
- pausing playback stops the animator and the auto-scroll pass until the position changes again.

### Dual-Line Romanization (YouTube Music style)

When romanization is enabled, lines display the **original script in small font above** (e.g. Japanese Kanji/Kana, Korean Hangul, Chinese Hanzi, Cyrillic) and the **romanized text below** as the main singing line.
- Both the romanized text and the original script animate synchronously with the karaoke gradient sweep.
- Click-to-seek works across the entire line.
- Can be toggled in **Settings → Experiments** (`Dual-Line Romanization`).

### High-Precision Japanese Romanization

Upstream Japanese romanization concatenated words into continuous unspaced strings and misread grammatical particles. This fork features:
- **Intelligent word spacing**: uses Kuromoji morphological tokens and Hepburn word boundaries to format romaji naturally (`watashi wa utau` instead of `watashiwautau`).
- **Phonetic particle readings**: particles は, へ, を correctly romanize to `wa`, `e`, `o`.
- **Special greetings**: `konnichiwa` and `konbanwa` properly handled.
- Word-synced syllable boundaries preserve natural word separation.

### Genius Singer Attribution

For songs performed by groups (e.g. BTS) or collaborations:
- Automatically searches and fetches section-level singer tags from Genius (`[Verse 1: Jungkook]`, `[Chorus: All]`, `[Verse 2: RM & SUGA]`, etc.).
- **Multi-singer breakdown**: recognizes Genius transcription guidelines where multiple vocalists in the same section are distinguished by style (1st vocalist = standard, 2nd vocalist = italic, 3rd vocalist = bold, 4th = bold-italic) to attribute only the active singer singing at that moment.
- **Zero-shift gutter placement**: singer badges sit in the left gutter beside the lyrics without displacing or altering the original lyrics layout and horizontal alignment. In case of multi-singer moments or long names, badges cleanly stack vertically.
- **Persistent Caching**: once fetched, singer breakdowns are saved in persistent storage (`Spicetify.LocalStorage`) for instant 0ms loads on replay.
- Can be toggled in **Settings → Experiments** (`Genius Singer Attribution`).

#### Setting up the Cloudflare Worker Proxy

Because `genius.com` blocks direct automated scraper requests with Cloudflare bot challenges (`403 Forbidden`), a free Cloudflare Worker fetches the lyrics through clean mirror instances without anti-bot blocks:

1. Create a free worker on [dash.cloudflare.com](https://dash.cloudflare.com/) (**Workers & Pages** → **Create Application** → **Create Worker**).
2. Click **Edit code** and paste the following snippet:

```javascript
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const url = new URL(request.url);
    const title = url.searchParams.get("title");
    const artist = url.searchParams.get("artist");

    if (!title) {
      return new Response(JSON.stringify({ error: "Missing title parameter" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const token =
      request.headers.get("Authorization")?.replace("Bearer ", "") ||
      env.GENIUS_TOKEN ||
      "";

    let songPath = null;

    if (token) {
      try {
        const searchRes = await fetch(
          `https://api.genius.com/search?q=${encodeURIComponent(title + " " + (artist || ""))}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (searchRes.ok) {
          const data = await searchRes.json();
          const hits = data?.response?.hits;
          if (hits && hits.length > 0) {
            const hit =
              hits.find(
                (h) =>
                  h.result?.primary_artist?.name?.toLowerCase().includes((artist || "").toLowerCase())
              ) || hits[0];
            songPath = hit?.result?.path;
          }
        }
      } catch (e) {}
    }

    const mirrors = [
      "https://dumb.bloat.cat",
      "https://dumb.jeikobu.net",
      "https://dumb.ducks.party",
    ];

    const cleanTitle = title.replace(/\s*-\s*.*$/g, "").trim();
    const query = encodeURIComponent(`${cleanTitle} ${artist || ""}`.trim());

    for (const mirror of mirrors) {
      try {
        let path = songPath;
        if (!path) {
          const searchRes = await fetch(`${mirror}/search?q=${query}`, {
            headers: { "User-Agent": "Mozilla/5.0" },
          });
          if (!searchRes.ok) continue;
          const searchHtml = await searchRes.text();
          const match = /<a id="search-item" href="(\/[^"]+-lyrics)"/i.exec(searchHtml);
          if (!match) continue;
          path = match[1];
        }

        const pageRes = await fetch(`${mirror}${path}`, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        if (!pageRes.ok) continue;
        const pageHtml = await pageRes.text();

        return new Response(JSON.stringify({ html: pageHtml, path }), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (err) {}
    }

    return new Response(JSON.stringify({ error: "Lyrics not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  },
};
```

3. Click **Deploy**.
4. Test in your browser: `https://<your-worker>.workers.dev/?title=Butter&artist=BTS` (returns JSON lyrics).
5. In Spotify, paste your Worker URL (`https://<your-worker>.workers.dev`) into **Settings → Lyrics → Genius Proxy URL**.

## Installation

Spicy Lyrics runs only in the Spotify **desktop** client, through Spicetify. It does not need Spotify Premium. This fork is not distributed through the Marketplace, so install it from source or from a CI build.

### 1. Install Spicetify

**Windows** (PowerShell):

```powershell
iwr -useb https://raw.githubusercontent.com/spicetify/cli/main/install.ps1 | iex
```

**macOS / Linux** (Terminal):

```bash
curl -fsSL https://raw.githubusercontent.com/spicetify/cli/main/install.sh | sh
```

> [!WARNING]
> Spicetify cannot modify a Snap-based Spotify installation on Linux. See the [official Spicetify guide](https://spicetify.app/docs/getting-started) for other setups.

### 2. Build the extension

Requires [Bun](https://bun.sh):

```bash
git clone https://github.com/itsmrma/spicy-lyrics.git
cd spicy-lyrics
bun install
bun run build
```

The build writes `dist/spicy-lyrics.js`. Every green CI run also uploads that file as the `spicy-lyrics-extension` artifact on the [Actions page](https://github.com/itsmrma/spicy-lyrics/actions/workflows/ci.yml), if you would rather not build it yourself.

### 3. Install it into Spotify

1. Copy `dist/spicy-lyrics.js` into your Spicetify Extensions folder. [Find the folder for your OS](https://spicetify.app/docs/customization/extensions#manual-installation).
2. Run:

```bash
spicetify config extensions spicy-lyrics.js
spicetify apply
```

Play a song and open the lyrics view to confirm it loaded. Manual installs do not update automatically; rebuild and re-run `spicetify apply` after pulling changes.

## Development

```bash
bun install      # install dependencies
bun run dev      # watch mode, builds and syncs to Spicetify
bun run build    # production build (dist/spicy-lyrics.js)
bun run lint     # oxlint
bun run lint:fix # oxlint with auto-fix
bun run fmt      # oxfmt
```

CI runs lint, a TypeScript check (with the two known vendored-file errors excluded), and a production build on every push and pull request. A build in CI sets `CI=true`, which makes spicetify-creator skip Spicetify operations and only emit `dist/`.

## Troubleshooting

If Spicy Lyrics disappears after a Spotify update or fails to load, try these in order:

```bash
spicetify apply
spicetify backup apply
spicetify update
spicetify restore backup apply
```

**High CPU or memory use?** This fork is the answer to that question, but other extensions, dynamic backgrounds, themes and custom CSS still add load. Make sure **Performance Mode** is on, restart Spotify, and test without other extensions or snippets.

**Lyrics missing, outdated, or wrong?**

1. Make sure you opened the song version you meant to. Singles, albums, deluxe, clean, and remastered releases can have different lyrics or timing.
2. Try another release of the same recording.
3. Clear the lyrics cache in Spicy Lyrics' settings, then reopen the song.
4. Check the [upstream status page](https://status.spicylyrics.org/).

### Reporting a bug

Include your operating system, Spotify, Spicetify and Spicy Lyrics versions, exact steps to reproduce, what you expected versus what happened, and the affected song link. Never share account tokens, cookies, authorization headers, or other secrets in a bug report. Security issues go through [SECURITY.md](./SECURITY.md).

## FAQ

<details>
<summary><strong>What types of lyrics are supported?</strong></summary>

| Type | What it does |
|------|--------------|
| Word-synced | Highlights individual words, or timed parts of words, as they're sung. |
| Line-synced | Advances one timed line at a time. |
| Static | Shows lyrics without timing. |

The sync type depends on the lyric data available for that exact track. There's no setting to turn line-synced lyrics into word-synced ones.

</details>

<details>
<summary><strong>Where do the lyrics come from?</strong></summary>

Community-uploaded TTML lyrics first, then other supported sources, including Apple Music and Spotify. What you see depends on availability, matching, and source priority.

</details>

<details>
<summary><strong>Can I use it on mobile?</strong></summary>

No. The extension runs in Spotify's desktop client only.

</details>

<details>
<summary><strong>Can I use it offline?</strong></summary>

Online lyric lookup needs an internet connection. Lyrics you import into the **Lyrics Manager's** persistent local library stay on your device until you remove them.

</details>

<details>
<summary><strong>Why is the timing off?</strong></summary>

If one song is off, the lyric file may have been timed against a different release. If every song is off on your device, use the playback-offset setting in Spicy Lyrics.

</details>

<details>
<summary><strong>Can I change the lyrics font?</strong></summary>

Install the font on your computer, then open **Marketplace → Snippets → Add CSS**, add:

```css
* {
  font-family: "Your Font Name" !important;
}
```

Name and save the snippet, then enable **Use System Font** under **Appearance** in Spicy Lyrics settings. This changes Spotify's whole interface font, not only the lyrics.

</details>

<details>
<summary><strong>Where can I get help or report issues?</strong></summary>

Use this repository's [issues](https://github.com/itsmrma/spicy-lyrics/issues) for problems with the fork, especially anything related to Performance Mode, Cinema Mode controls, or the Now Playing card. Upstream has a [Discord](https://discord.gg/lyrc) and [guides](https://guides.spicylyrics.org/s/guides); lyrics content itself comes from upstream's community.

</details>

## Credits and license

This project is a fork of [Spicy Lyrics](https://github.com/spikerko/spicy-lyrics) by [Spikerko](https://github.com/Spikerko), and the vast majority of the code, lyrics data and design are upstream's work. The fork adds the performance work, the Cinema Mode control placement and the Now Playing card romanization described above.

The extension is licensed under [AGPL-3.0](./LICENSE). The hosted services, databases, and websites behind Spicy Lyrics are separate and aren't covered by this license.
