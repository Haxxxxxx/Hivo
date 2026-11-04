// The mini player on the note screen (docs/GUARDRAILS.md, Digger exception:
// the official YouTube embed on the nocookie host, play only, framed through
// the website's embed.html; nothing is ever downloaded). Pure helpers: the
// video id, the player address, what the WebView may load, and the messages
// the player page sends back. `youtubeId` and `canonicalUrl` are ports of the
// desktop's src/lib/digger.ts (same rules; src/lib/digger.test.ts checks
// that both give the same answers).

/**
 * The video ID of a YouTube link (watch?v=, youtu.be/, /shorts/), or null for
 * anything else. Only an ID ever reaches the embedded player.
 */
export function youtubeId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\.|^m\./, "");
  let id: string | null = null;
  if (host === "youtube.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else if (u.pathname.startsWith("/shorts/")) id = u.pathname.slice("/shorts/".length).split("/")[0];
  } else if (host === "youtu.be") {
    id = u.pathname.slice(1).split("/")[0];
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** One address per YouTube video (`https://www.youtube.com/watch?v=<id>`),
 * anything else trimmed: what "Open in YouTube" opens. */
export function canonicalUrl(url: string): string {
  const id = youtubeId(url.trim());
  return id ? `https://www.youtube.com/watch?v=${id}` : url.trim();
}

/** The website page that wraps the player (web/public/embed.html), same as
 * the desktop's EMBED_PAGE. Loaded as the WebView's own page, so the inner
 * YouTube frame gets an https referrer (a WebView page loaded from inline
 * HTML or a custom origin sends none, and YouTube then refuses the embed with
 * error 153). */
export const EMBED_ORIGIN = "https://www.hi-vo.fr";
export const EMBED_PAGE = `${EMBED_ORIGIN}/embed.html`;

/** The player page for a video id, in the app's language, or null for anything that isn't an id. */
export function playerUrl(id: string, lang: "en" | "fr", key?: string): string | null {
  if (!VIDEO_ID.test(id)) return null;
  return `${EMBED_PAGE}?v=${id}&hl=${lang}${key && PLAYER_KEY.test(key) ? `#k=${key}` : ""}`;
}

const PLAYER_KEY = /^[0-9a-f]{32}$/;

/** A new player's key (16 random bytes, hex), put in the page's fragment by
 * `playerUrl`: embed.js signs its messages with it. The bridge reaches every
 * frame (Android) and the message's url is the top page's whatever frame
 * sent it, so a frame that can't read the top page's address (YouTube's,
 * cross-origin) can't make a message the app takes. Review #18. */
export function playerKey(random: (n: number) => Uint8Array): string {
  return Array.from(random(16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** How long the player page gets to load before the "didn't load" card (with Retry) shows. */
export const PLAYER_LOAD_TIMEOUT_MS = 15_000;

/** The same page as `page`: origin, path and query compared, not the raw
 * text (a fragment or the browser's own normalising doesn't make it another
 * page; another path or video does). Review #11. */
export function samePage(url: string, page: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(page);
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

/** The hosts the player's frames may navigate to inside the WebView. */
const FRAME_HOSTS = ["www.youtube-nocookie.com"];
const FRAME_HOST_SUFFIXES = [".ytimg.com", ".googlevideo.com"];
/** YouTube addresses a tap inside the player may hand to the YouTube app or the browser. */
const EXTERNAL_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"];

export type NavDecision = "allow" | "external" | "block";

/**
 * What the WebView does with a navigation. The top frame only ever shows
 * the player page it was given; the inner frames stay on YouTube's player
 * hosts. A tap on a YouTube link ("Watch on YouTube", the title, the logo)
 * opens outside the app; anything else is dropped.
 */
export function navDecision(url: string, isTopFrame: boolean, page: string): NavDecision {
  if (url === "about:blank" || url === "about:srcdoc") return "allow";
  if (isTopFrame && samePage(url, page)) return "allow";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "block";
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return "block";
  const host = u.hostname.toLowerCase();
  if (!isTopFrame) {
    if (FRAME_HOSTS.includes(host) || FRAME_HOST_SUFFIXES.some((s) => host.endsWith(s))) return "allow";
  }
  return EXTERNAL_HOSTS.includes(host) ? "external" : "block";
}

/** The address to open outside the app for a navigation the player let out
 * (`navDecision` said "external"): a video becomes its plain watch address,
 * so an embed URL never reaches the browser. */
export function externalUrl(url: string): string {
  try {
    const u = new URL(url);
    const m = /^\/embed\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(u.pathname);
    if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
  } catch {
    return url;
  }
  return canonicalUrl(url);
}

export type PlayerMessage = { type: "ready" } | { type: "state"; state: number } | { type: "error"; code: number };

/** A message from the player page (web/public/embed.js) carrying this
 * player's `key`, or null for anything else. Only checked fields of small
 * integers get through. */
export function parsePlayerMessage(data: string, key: string): PlayerMessage | null {
  if (typeof data !== "string" || data.length > 200) return null;
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  const r = m as Record<string, unknown>;
  if (r.hivo !== 1 || !PLAYER_KEY.test(key) || r.k !== key) return null;
  const int = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= -1 && v < 1000;
  if (r.type === "ready") return { type: "ready" };
  if (r.type === "state" && int(r.state)) return { type: "state", state: r.state as number };
  if (r.type === "error" && int(r.code)) return { type: "error", code: r.code as number };
  return null;
}

export type PlayerProblem = "offline" | "blocked" | "unavailable" | "refused" | "failed";

/** What a YouTube player error means for the user. 101 and 150 (and 152):
 * the owner disallows embedding; 100: removed or private; 153: YouTube
 * refused the player (no referrer); anything else: it stopped. */
export function problemFor(code: number): PlayerProblem {
  if (code === 101 || code === 150 || code === 152) return "blocked";
  if (code === 100) return "unavailable";
  if (code === 153) return "refused";
  return "failed";
}

/** The message's origin is the player page itself (not a page it navigated to). */
export function fromPlayerPage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === EMBED_ORIGIN && u.pathname === "/embed.html";
  } catch {
    return false;
  }
}
