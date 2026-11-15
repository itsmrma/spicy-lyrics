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
const SAFE_PATH = /^\/[A-Za-z0-9%_.~'()!*,-]+-lyrics$/;

const isAltPage = (path) => /^\/Genius-(?:romanizations|.*-translations)-/i.test(path);

// Index of the </div> closing the div whose opening tag ends at `from`, or -1.
function findDivEnd(html, from) {
  const re = /<(\/?)div\b[^>]*>/gi;
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      depth--;
      if (depth === 0) return m.index;
    } else {
      depth++;
    }
  }
  return -1;
}

// Keeps only the lyrics (with their <i>/<b> styling and [Section: Singer] headers) and drops
// the other ~99% of the page: CSS, ads, tracking, annotations, credits.
function extractLyrics(html) {
  const open = /<div[^>]*data-lyrics-container="true"[^>]*>/gi;
  const exclude = /<div[^>]*data-exclude-from-selection="true"[^>]*>/i;
  const parts = [];
  let m;
  while ((m = open.exec(html)) !== null) {
    const start = m.index + m[0].length;
    const end = findDivEnd(html, start);
    if (end === -1) break;
    let inner = html.slice(start, end);
    for (let x; (x = exclude.exec(inner)); ) {
      const e = findDivEnd(inner, x.index + x[0].length);
      inner = inner.slice(0, x.index) + (e === -1 ? "" : inner.slice(e + 6));
      if (e === -1) break;
    }
    inner = inner.replace(/<\/?(?:a|span)\b[^>]*>/gi, "");
    if (/[\p{L}\p{N}]/u.test(inner.replace(/<[^>]+>/g, ""))) parts.push(inner);
    open.lastIndex = end;
  }
  return parts.length ? `<div data-lyrics-container="true">${parts.join("<br/>")}</div>` : null;
}

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

    for (const path of new Set(candidates.filter(Boolean))) {
      const html = await fetchPage(path);
      if (html) {
        // Only the lyrics; the full page is sent only if they can't be isolated.
        return new Response(JSON.stringify({ html: extractLyrics(html) ?? html, path }), {
          headers: JSON_HEADERS,
        });
      }
    }

    return json({ error: "Lyrics not found" }, 404);
  },
};
