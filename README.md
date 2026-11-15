# Spicy Lyrics — performance fork

[![CI](https://github.com/itsmrma/spicy-lyrics/actions/workflows/ci.yml/badge.svg)](https://github.com/itsmrma/spicy-lyrics/actions/workflows/ci.yml)

A fork of [Spicy Lyrics](https://github.com/spikerko/spicy-lyrics) maintained by [itsmrma](https://github.com/itsmrma), built around wanting less resource usage and lyrics association.**

Spicy Lyrics replaces Spotify's lyrics view with animated lyrics, dynamic backgrounds, romanization, and customization options. It is an open-source extension for the Spotify desktop client, built on [Spicetify](https://spicetify.app).

![Extension Example](./previews/wide_home.webp)

> [!NOTE]
> **This is a performance fork.** Upstream optimises for the richest possible look; this fork keeps that look one toggle away but makes the cheap path the default. It is not the Marketplace release — installing Spicy Lyrics from the Marketplace installs upstream, not this fork.

## What this fork changes

| Area | Upstream | This fork |
|------|----------|-----------|
| Animation cost | Per-letter springs, glow and text-shadow blurs, distance blurs, backdrop blurs run all the time | **Performance Mode on by default**: letter springs, per-letter glow and shadow writes, line distance blur and container backdrop blurs are bypassed; lines are separated by opacity alone; heavy dynamic/animated backgrounds are locked off and the Bloom renderer is enforced |
| Idle cost | The frame loop keeps animating while playback is paused | Animator and scroll passes are skipped while paused and the position has not moved |
| Cinema Mode & Fullscreen | Playback controls sit on top of artwork; active repeat/shuffle buttons have glow | Controls sit unobstructed; shuffle & repeat use clean indicator dots underneath without heavy drop-shadows |
| Background styles | Solid, Dynamic, Animated NPV, Static Image | Adds **Cover Art (Blurred)** and **Artist Image (Blurred)** full-bleed background modes |
| Romanization | Shipped its own romanization pipeline until 6.5.0 | Upstream 6.5.0's pipeline (Romaji as Written, romanization rows under each line) is kept on by default; this fork no longer carries a separate Japanese romanizer |
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
- the Bloom renderer is locked on to avoid heavy DOM animation layers;
- pausing playback stops the animator and the auto-scroll pass until the position changes again.

### Romanization

The fork used to ship its own dual-line renderer and Japanese romanizer. Upstream 6.5.0
now covers both with the **Romanization → Under each line** setting and the **Romaji as
Written** experiment, so the fork follows upstream's pipeline instead of maintaining a
second one. Both are already the defaults; users who had this fork's Dual-Line
Romanization switched off are migrated to "Replace the line".

### Genius Singer Attribution

For songs performed by groups (e.g. BTS) or collaborations:
- Automatically searches and fetches section-level singer tags from Genius (`[Verse 1: Jungkook]`, `[Chorus: All]`, `[Verse 2: RM & SUGA]`, etc.).
- **Multi-singer breakdown**: recognizes Genius transcription guidelines where multiple vocalists in the same section are distinguished by style (1st vocalist = standard, 2nd vocalist = italic, 3rd vocalist = bold, 4th = bold-italic) to attribute only the active singer singing at that moment.
- **Zero-shift gutter placement**: singer badges sit in the left gutter beside the lyrics without displacing or altering the original lyrics layout and horizontal alignment. In case of multi-singer moments or long names, badges cleanly stack vertically.
- **No guessing**: when a header lists several singers in turn (`[Verse 1: Jungkook, V, Jimin, Jin]`) but nothing on the lines says who sings which, the section is left unattributed instead of stamping every name on every line. In that case the romanized Genius page is fetched too and, if it marks the lines, its per-line attribution fills the section in. Choruses and headers joined with `&` keep showing everyone.
- **Safe alignment**: a bare `[Verse 2]` no longer inherits the singer of `[Verse 1: X]`, lines with no match take the singer of the nearest section by position, and nothing is assigned when too few lines match the Genius page (a different version or language).
- **Persistent Caching**: once fetched, singer breakdowns are saved in persistent storage (`Spicetify.LocalStorage`) for instant 0ms loads on replay.
- Can be toggled in **Settings → Experiments** (`Genius Singer Attribution`).

#### Setting up the Cloudflare Worker Proxy

Because `genius.com` blocks direct automated requests from the Spotify client (CORS and Cloudflare bot challenges), a free Cloudflare Worker fetches the lyrics page for it. The worker looks the song up (through the Genius API when a token is set, otherwise Genius's public search or the predictable `Artist-title-lyrics` address), fetches `genius.com` directly and only falls back to public mirrors, which are often down or behind bot protection. It also accepts `path` so the app can request the romanized page.

1. Create a free worker on [dash.cloudflare.com](https://dash.cloudflare.com/) (**Workers & Pages** → **Create Application** → **Create Worker**).
2. Click **Edit code** and paste the following snippet. For the most reliable lookup also add your Genius client access token as a `GENIUS_TOKEN` secret, or set it in **Settings → Lyrics** so the app sends it:

```javascript
// Cloudflare Worker: returns the HTML of a Genius lyrics page as { html, path }.
//
//   GET /?title=...&artist=...            search the song, return its page
//   GET /?title=...&artist=...&path=/X-lyrics   skip the search, fetch that page
//                                         (Spicy Lyrics asks for the romanized page this way)
//
// Optional: set GENIUS_TOKEN (Worker secret) or send "Authorization: Bearer <token>"
// to search through the official API, which is the most reliable way to find the song.

const CORS = { "Access-Control-Allow-Origin": "*" };
const JSON_HEADERS = { "Content-Type": "application/json", ...CORS };

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// Mirrors are only a fallback: several are behind bot challenges (Anubis) or down.
const MIRRORS = ["https://dumb.bloat.cat", "https://dumb.jeikobu.net", "https://dumb.ducks.party"];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

// A real lyrics page, not a challenge / error page served with a 200.
const isLyricsPage = (html) =>
  /data-lyrics-container="true"|<div id="lyrics"/i.test(html);

// Only plain Genius song slugs: keeps `path` from reaching anything else.
const SAFE_PATH = /^\/[A-Za-z0-9%_.~'()!*,\-]+-lyrics$/;

const isAltPage = (path) => /^\/Genius-(?:romanizations|.*-translations)-/i.test(path);

async function fetchPage(path) {
  const urls = [`https://genius.com${path}`, ...MIRRORS.map((m) => `${m}${path}`)];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      if (!res.ok) continue;
      const html = await res.text();
      if (isLyricsPage(html)) return html;
    } catch {}
  }
  return null;
}

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

function pickHit(hits, title, artist) {
  const t = norm(title);
  const a = norm(artist);
  const songs = hits
    .map((h) => h.result || h)
    .filter((r) => r?.path && SAFE_PATH.test(r.path) && !isAltPage(r.path));
  const score = (r) => {
    const rt = norm(r.title);
    const ra = norm(r.primary_artist?.name || r.artist_names);
    let s = 0;
    if (rt === t) s += 3;
    else if (rt.includes(t) || t.includes(rt)) s += 1;
    if (a && (ra.includes(a) || a.includes(ra))) s += 2;
    return s;
  };
  return songs.sort((x, y) => score(y) - score(x))[0] || null;
}

async function searchWithApi(token, title, artist) {
  const res = await fetch(
    `https://api.genius.com/search?q=${encodeURIComponent(`${title} ${artist}`.trim())}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return pickHit(data?.response?.hits || [], title, artist)?.path || null;
}

async function searchPublic(title, artist) {
  const res = await fetch(
    `https://genius.com/api/search/multi?q=${encodeURIComponent(`${title} ${artist}`.trim())}`,
    { headers: { ...BROWSER_HEADERS, Accept: "application/json" } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const songSection = (data?.response?.sections || []).find((s) => s.type === "song");
  return pickHit(songSection?.hits || [], title, artist)?.path || null;
}

// Genius slugs are predictable: "Artist Title" -> /Artist-title-lyrics.
function guessSlug(title, artist) {
  const combined = `${artist} ${title}`
    .replace(/&/g, " and ")
    .replace(/['’"“”.,!?()[\]{}]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return combined ? `/${combined[0].toUpperCase()}${combined.slice(1).toLowerCase()}-lyrics` : null;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          ...CORS,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const url = new URL(request.url);
    const title = url.searchParams.get("title");
    const artist = url.searchParams.get("artist") || "";
    const forcedPath = url.searchParams.get("path");

    if (!title) return json({ error: "Missing title parameter" }, 400);
    if (forcedPath && !SAFE_PATH.test(forcedPath)) return json({ error: "Invalid path" }, 400);

    const token = request.headers.get("Authorization")?.replace("Bearer ", "") || env.GENIUS_TOKEN || "";
    const cleanTitle = title.replace(/\s*-\s*.*$/g, "").trim();

    const candidates = [];
    if (forcedPath) {
      candidates.push(forcedPath);
    } else {
      try {
        if (token) candidates.push(await searchWithApi(token, cleanTitle, artist));
      } catch {}
      try {
        candidates.push(await searchPublic(cleanTitle, artist));
      } catch {}
      candidates.push(guessSlug(cleanTitle, artist));
    }

    for (const path of [...new Set(candidates.filter(Boolean))]) {
      const html = await fetchPage(path);
      if (html) {
        return new Response(JSON.stringify({ html, path }), { headers: JSON_HEADERS });
      }
    }

    return json({ error: "Lyrics not found" }, 404);
  },
};
```

3. Click **Deploy**.
4. Test in your browser: `https://<your-worker>.workers.dev/?title=NORMAL&artist=BTS` (returns JSON lyrics).
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
