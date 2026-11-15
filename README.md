# Spicy Lyrics — performance fork

[![CI](https://github.com/itsmrma/spicy-lyrics/actions/workflows/ci.yml/badge.svg)](https://github.com/itsmrma/spicy-lyrics/actions/workflows/ci.yml)

A fork of [Spicy Lyrics](https://github.com/spikerko/spicy-lyrics) maintained by [itsmrma](https://github.com/itsmrma), built around two goals: **using as few CPU and GPU resources as possible while the lyrics still feel alive, and attributing every line to the right singer.**

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
| Singer attribution | Anonymous TTML agent IDs (`v1`, `v2`) or none | **Genius Singer Attribution**: a badge with the singer's name on each line of group songs and collaborations, plus duet side-alignment. It never delays the lyrics and looks up your queued songs ahead of time |

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

For group songs and collaborations (e.g. BTS), each lyric line gets a badge with the name of the singer, and duets are aligned to opposite sides. The attribution comes from the section headers that Genius transcribers write above the lyrics (`[Verse 1: Jungkook]`, `[Chorus: All]`, `[Verse 2: RM & SUGA]`). Native Apple Music TTML singer tags are kept when a track already has them. It is an experiment: turn it on or off in **Settings → Experiments → Genius Singer Attribution**.

#### How a line gets its singer

- **Styled headers.** When a header lists several singers, Genius marks their lines with formatting: the first singer is plain, the second *italic*, the third **bold**, the fourth ***bold italic***. The badge shows only the singer of that line.
- **No guessing.** If a header lists several singers in turn (`[Verse 1: Jungkook, V, Jimin, Jin]`) and nothing on the lines says who sings which, the section is left without a badge instead of stamping every name on every line. The romanized Genius page of the song is then fetched too, and if it marks the lines, its attribution fills the section in. Choruses and headers joined with `&` still show everyone.
- **Safe alignment.** A bare `[Verse 2]` does not inherit the singer of `[Verse 1: X]`. Lines that have no counterpart on the Genius page take the singer of the nearest section, and nothing is assigned at all when too few lines match (a different version or language of the song).
- **Layout.** Badges sit in the left gutter without moving the lyrics, and stack vertically for several singers or long names.

#### Speed

- **Lyrics never wait for Genius.** They are shown as soon as they are ready. If the singer lookup is still running after about a second, the badges are added the moment it finishes.
- **Started early.** The lookup begins together with the lyrics request instead of after it.
- **Queue prefetch.** A few seconds after a song starts, the next three songs in your queue are looked up one at a time, so they already have their badges when they come on.
- **Cached.** Results are kept for 30 days in persistent storage, so a replayed song gets its badges in about half a second.

All of these values (wait time, request timeout, queue depth) are tunable from the remote config under `singers`.

#### Setting up the Cloudflare Worker

`genius.com` cannot be fetched directly from the Spotify client (CORS and bot challenges), so the extension asks a small free Cloudflare Worker that you own. The worker finds the song, fetches its Genius page and returns **only the lyrics** as `{ html, path }`: a few KB instead of the whole ~400 KB page. It accepts `?path=` so the app can also request the romanized page.

1. Create a free worker on [dash.cloudflare.com](https://dash.cloudflare.com/) (**Workers & Pages** → **Create Application** → **Create Worker**).
2. Click **Edit code** and paste the contents of [`workers/genius-proxy.js`](./workers/genius-proxy.js).
3. For the most reliable lookup, add your Genius client access token as a `GENIUS_TOKEN` secret on the worker, or enter it in **Settings → Lyrics** so the app sends it with each request.
4. Click **Deploy**, then test it in your browser: `https://<your-worker>.workers.dev/?title=NORMAL&artist=BTS` should return JSON with a short `html` field.
5. In Spotify, paste the worker URL into **Settings → Lyrics → Genius Proxy URL**.

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
