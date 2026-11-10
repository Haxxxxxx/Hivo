// Pure helpers for the Digger: search links and starter queries from beat
// file names, leads (text files) and the user's converter link. Links only:
// the Digger never downloads anything.

import type { BeatFacts, BeatFile, BeatMove, DigResult, Lead, WebLink, YoutubeVideo } from "../types";

/** Same limit as `MAX_QUERY_CHARS` in src-tauri/src/youtube.rs. */
export const MAX_QUERY_CHARS = 120;

/** A YouTube search page for `query` (opened in the browser, no key needed). */
export function youtubeSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query.trim().replace(/\s+/g, " "))}`;
}

/** A Google search page for `query` (the searches behind the dig's web links). */
export function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query.trim().replace(/\s+/g, " "))}`;
}

/** Same limit as `MAX_EXCLUDE` in src-tauri/src/digger.rs. */
export const MAX_EXCLUDE = 50;

/** Same limit as `MAX_KEY_CHARS` in src-tauri/src/digger.rs. */
const MAX_KEY_CHARS = 120;

/** How a found beat is remembered between rounds: "title | site", lowercased;
 * "url | site" when the link has no text, so untitled links never share one
 * key (same as `found_key` in Rust; links reach the webview resolved to
 * their final address, which is stable across rounds). */
export function foundKey(link: { text: string; site: string; url?: string }): string {
  const text = link.text.trim();
  const head = text || (link.url ?? "").trim();
  // Cut on code points, then lowercase: the same as `cut_key` in Rust (no ellipsis).
  return Array.from(`${head} | ${link.site.trim()}`).slice(0, MAX_KEY_CHARS).join("").toLowerCase();
}

type Keyed = { text: string; site: string; url?: string };

/** The beats a "Go deeper" round must skip: the first dig's, then every round's, deduplicated. */
export function deeperExclude(first: Keyed[], rounds: Keyed[][]): string[] {
  return [...new Set([first, ...rounds].flat().map(foundKey))].slice(0, MAX_EXCLUDE);
}

/** Same limit as `MAX_SEARCHES_DONE` in src-tauri/src/digger.rs. */
export const MAX_SEARCHES_DONE = 50;

/** Every search the rounds ran so far (the seed's go separately), once each, capped. */
export function searchesDone(rounds: { queries: string[] }[]): string[] {
  return [...new Set(rounds.flatMap((r) => r.queries).map((q) => q.trim()).filter(Boolean))].slice(0, MAX_SEARCHES_DONE);
}

/** Same limits as `MAX_FOUND_TITLES` / `MAX_TITLE_CHARS` in src-tauri/src/digger.rs. */
export const MAX_FOUND_TITLES = 50;
export const MAX_TITLE_CHARS = 120;

/** `title` the way the prompts get it: trimmed, one space between words, clipped. */
function cleanTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_CHARS);
}

/** `titles` cleaned, blanks and repeats (any case) dropped, at most `max`. */
function cleanTitles(titles: string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of titles) {
    const t = cleanTitle(raw);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** The titles already shown, for a "Go deeper" round without Google Search:
 * trimmed, clipped, blanks and repeats (any case) dropped, capped. */
export function foundTitles(titles: string[]): string[] {
  return cleanTitles(titles, MAX_FOUND_TITLES);
}

/** Same limit as `MAX_LIKED` in src-tauri/src/digger.rs. */
export const MAX_LIKED = 20;

/** A result picked for the next round to go closer to ("Use for next dig"):
 * a YouTube video id or a web link url, and the title the prompt will see. */
export interface Liked {
  id: string;
  title: string;
}

/** `liked` with `id` toggled: dropped when there, added (title cleaned)
 * unless the list is full. */
export function toggleLiked(liked: Liked[], id: string, title: string): Liked[] {
  if (liked.some((l) => l.id === id)) return liked.filter((l) => l.id !== id);
  if (liked.length >= MAX_LIKED) return liked;
  return [...liked, { id, title: cleanTitle(title) || id }];
}

/** The picks' titles for a "Go deeper" round: same cleaning as `foundTitles`, capped at MAX_LIKED. */
export function likedTitles(liked: Liked[]): string[] {
  return cleanTitles(liked.map((l) => l.title), MAX_LIKED);
}

/** The picks a round was seeded from, short enough for a tooltip: the first 3, then "+n". */
export function seedList(seeds: string[]): string {
  const rest = seeds.length - 3;
  return seeds.slice(0, 3).join(", ") + (rest > 0 ? ` +${rest}` : "");
}

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
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/**
 * The website page that wraps the YouTube player (web/public/embed.html). The
 * app frames it instead of YouTube because the webview's tauri:// origin sends
 * no referrer and YouTube refuses an embed without one (error 153). Must stay
 * in `frame-src` of both CSPs in tauri.conf.json.
 */
export const EMBED_PAGE = "https://www.hi-vo.fr/embed.html";

/** The player URL for a video id from `youtubeId()`, or null for anything else. */
export function embedUrl(id: string): string | null {
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? `${EMBED_PAGE}?v=${id}` : null;
}

/** Letters and digits only, lowercased, single spaces: what a title and a
 * file name share once a converter or a download has mangled punctuation.
 * NFC first: a macOS file name is often decomposed ("E" + accent), and the
 * accent alone isn't a letter. */
export function titleKey(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Containment only counts when the shorter name is at least this share of
 * the longer one (a converter's " (128 kbps)" suffix, not "dark trap type
 * beat" inside every dark trap title). */
const MIN_CONTAIN_RATIO = 0.75;

/** The beat in the user's folders that is this lead, if one is. `manual`
 * (the user's own link, `Workspace.leadBeats`) wins: a beat path, or null
 * for "not in your prods"; a linked path the scan no longer has falls back
 * to the name match. Otherwise the same cleaned name, or one that
 * contains the other when their lengths are close (a downloaded file is
 * usually named after the video, sometimes with a short suffix). Short keys
 * never match by containment. */
export function matchBeat<B extends { name: string; path?: string }>(lead: { title: string }, beats: B[], manual?: string | null): B | null {
  if (manual === null) return null;
  if (manual !== undefined) {
    const linked = beats.find((b) => b.path === manual);
    if (linked) return linked;
    // The linked file is gone from this scan (moved and not relinked yet,
    // or deleted): the name match below, rather than nothing forever.
  }
  const key = titleKey(lead.title);
  if (!key) return null;
  const exact = beats.find((b) => titleKey(b.name) === key);
  if (exact) return exact;
  if (key.length < 12) return null;
  return (
    beats.find((b) => {
      const k = titleKey(b.name);
      if (k.length < 12) return false;
      const [short, long] = k.length <= key.length ? [k, key] : [key, k];
      return short.length / long.length >= MIN_CONTAIN_RATIO && long.includes(short);
    }) ?? null
  );
}

/**
 * Where a saved prod's file is (C5): a beat in the beats list (playable,
 * linkable by hand) first, as `matchBeat`; else, by name only, another file
 * that confirms it: an AIFF in a beats folder or a file in Downloads
 * (`ProdFile`). A hand-made "not this beat" (`manual === null`) means none.
 */
export function prodMatch<B extends { name: string; path?: string }, F extends { name: string }>(
  lead: { title: string },
  beats: B[],
  files: F[],
  manual?: string | null,
): { beat: B; file?: undefined } | { beat?: undefined; file: F } | null {
  const beat = matchBeat(lead, beats, manual);
  if (beat) return { beat };
  if (manual !== undefined) return null;
  const file = matchBeat(lead, files);
  return file ? { file } : null;
}

/** One address per YouTube video (watch?v=, youtu.be/, /shorts/, m.,
 * extra parameters → `https://www.youtube.com/watch?v=<id>`), anything else
 * trimmed: what a lead is saved and hashed under, so one video is one lead. */
export function canonicalUrl(url: string): string {
  const id = youtubeId(url.trim());
  return id ? `https://www.youtube.com/watch?v=${id}` : url.trim();
}

/** Tempo and key written in a result's title ("… 140 BPM", "F#m", "A minor"),
 * else null: the only bpm and key a lead carries as its own. */
export function titleFacts(title: string): { bpm: number | null; key: string | null } {
  const b = /(?:^|[^\d])(\d{2,3})\s?bpm\b/i.exec(title) ?? /\bbpm\s?[:-]?\s?(\d{2,3})(?!\d)/i.exec(title);
  const n = b ? Number(b[1]) : NaN;
  const bpm = n >= 50 && n <= 220 ? n : null;
  const k = /(?:^|[\s([|,-])([A-G])([#♯b♭]?)\s?([Mm]inor|[Mm]in|[Mm]ajor|[Mm]aj|m)(?![\p{L}\p{N}])/u.exec(title);
  let key: string | null = null;
  if (k) {
    const acc = k[2] === "♯" || k[2] === "#" ? "#" : k[2] === "♭" || k[2] === "b" ? "b" : "";
    const minor = /^(m|[Mm]in(or)?)$/.test(k[3]);
    key = `${k[1].toUpperCase()}${acc}${minor ? "m" : ""}`;
  }
  return { bpm, key };
}

/** Same limit as `MAX_LEAD_SLUG` in src-tauri/src/leads.rs (the file name's title part). */
export const MAX_LEAD_SLUG = 60;

/**
 * FNV-1a (32-bit) of the trimmed url's UTF-8 bytes as 8 lowercase hex
 * digits: the suffix of a saved lead's file name (same as `lead_hash` in
 * src-tauri/src/leads.rs), so "Saved" can be told from the file list.
 */
export function leadHash(url: string): string {
  return fnv1a32(url.trim());
}

/** FNV-1a (32-bit) of the text's UTF-8 bytes as 8 lowercase hex digits, not
 * trimmed ("" → 811c9dc5, "a" → e40c292c). Also the phone sync note hash. */
export function fnv1a32(text: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** What a saved lead carries: the dig's summary and traits (what was
 * searched for), and a bpm and key only when the result's own title says
 * them. Never the picked beats' measured bpm or key: those are the user's
 * beats, not this one. */
export function leadFacts(dig: { analysis: { summary: string; traits: string[]; tempo: string } } | null, title: string): Pick<Lead, "summary" | "traits" | "bpm" | "key"> {
  const own = titleFacts(title);
  if (!dig) return { summary: null, traits: [], ...own };
  return {
    summary: dig.analysis.summary.trim() || null,
    traits: [dig.analysis.tempo, ...dig.analysis.traits].map((t) => t.trim()).filter(Boolean),
    ...own,
  };
}

/**
 * The user's converter link with the video address in its `{url}` slot, or
 * null unless the template is https and has the slot. Opened in the browser
 * by the user: Hivo never calls it and never downloads audio.
 */
export function converterLink(template: string | undefined, url: string): string | null {
  const t = template?.trim() ?? "";
  if (!t.startsWith("https://")) return null;
  return t.includes("{url}") ? t.split("{url}").join(encodeURIComponent(url)) : t;
}

/** A converter link without a `{url}` slot: the page is opened as is and
 * the video address is copied for the user to paste there. */
export function converterNeedsPaste(template: string | undefined): boolean {
  const t = template?.trim() ?? "";
  return t.startsWith("https://") && !t.includes("{url}");
}

/** "140 BPM · Am · 3:05" for one analysed beat; "≈" marks an estimated
 * tempo, "10:00+" a beat longer than the analysis reads. */
export function beatFactsLine(f: { bpm: number | null; bpmSource: string | null; key: string | null; durationSec: number; durationCapped?: boolean }): string {
  const parts: string[] = [];
  if (f.bpm) parts.push(`${f.bpmSource === "audio" ? "≈" : ""}${Math.round(f.bpm)} BPM`);
  if (f.key) parts.push(f.key);
  parts.push(durationLabel(f));
  return parts.join(" · ");
}

/** "3:05", or "10:00+" when the analysis stopped at its cap. */
export function durationLabel(f: { durationSec: number; durationCapped?: boolean }): string {
  const s = Math.round(f.durationSec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}${f.durationCapped ? "+" : ""}`;
}

/** Searches from the picked beats' names, once each (any case): the dig's
 * own when the model wrote none, and the ideas before a dig. */
export function nameQueries(names: string[]): string[] {
  const qs = names.map(beatQuery).filter(Boolean);
  return [...new Set(qs.map((q) => q.toLowerCase()))].map((l) => qs.find((q) => q.toLowerCase() === l)!);
}

/** The dig with searches from the beat names when the model returned none. */
export function withFallbackQueries<D extends { analysis: { queries: string[] } }>(dig: D, names: string[]): D {
  if (dig.analysis.queries.length > 0) return dig;
  return { ...dig, analysis: { ...dig.analysis, queries: nameQueries(names).slice(0, 6) } };
}

export type BeatSort = "newest" | "name" | "bpm" | "key";

/** The beat list in `sort` order; beats without a measure go last. */
export function sortBeats(beats: BeatFile[], facts: Record<string, BeatFacts | null | undefined>, sort: BeatSort): BeatFile[] {
  if (sort === "newest") return beats;
  const out = beats.slice();
  if (sort === "name") return out.sort((a, b) => a.name.localeCompare(b.name));
  const val = (b: BeatFile): number | string | null => {
    const f = facts[b.path];
    return sort === "bpm" ? (f?.bpm ?? null) : (f?.key ?? null);
  };
  return out.sort((a, b) => {
    const [x, y] = [val(a), val(b)];
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
  });
}

/** What follows a beat file around (`Workspace` fields of the same names). */
export interface BeatLinks {
  beatNotes?: Record<string, string>;
  beatNoteSizes?: Record<string, number>;
  beatNoteMoves?: Record<string, BeatMove>;
  leadBeats?: Record<string, string | null>;
}

/** Tombstones kept at most (oldest dropped first). */
export const MAX_BEAT_MOVES = 500;

type ScannedBeat = { path: string; name: string; sizeBytes: number };

const fileStem = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/\.[^.]+$/, "");

/**
 * Notes and lead links that follow their beat when it's moved or renamed.
 * A tracked path (a noted beat, or a beat a saved prod is linked to by hand)
 * the scan no longer finds goes to the one untracked beat with the same file
 * name AND size, only when exactly one fits, and only when the scan is
 * `complete` (not capped, every beats folder read): a beat missing from a
 * partial scan isn't gone. The old key is kept as a tombstone
 * (`beatNoteMoves`) until a later complete scan finds the new path; if the
 * old path comes back first, its note is restored. Sizes are kept for every
 * tracked path. Returns null when nothing changed.
 */
export function relinkBeatNotes(
  links: BeatLinks,
  beats: ScannedBeat[],
  complete: boolean,
  /** Beats phone memos are filed on (`beat:<path>`): tracked like a noted
   * beat (size learnt, followed when moved), so a memo-only beat keeps its
   * memos after a move (review 2026-11-10). */
  memoBeats: string[] = [],
): (Required<BeatLinks> & { moved: { from: string; to: string }[] }) | null {
  const notes = { ...(links.beatNotes ?? {}) };
  const sizes = { ...(links.beatNoteSizes ?? {}) };
  const moves = { ...(links.beatNoteMoves ?? {}) };
  const leadBeats = { ...(links.leadBeats ?? {}) };
  const here = new Map(beats.map((b) => [b.path, b]));
  let changed = false;

  // Tombstones: the old path is back (restore its note), or the new one is
  // confirmed by a complete scan (forget the old one).
  for (const [old, mv] of Object.entries(moves)) {
    const back = here.get(old);
    if (back) {
      if (mv.text !== undefined && notes[old] === undefined) {
        notes[old] = mv.text;
        sizes[old] = back.sizeBytes;
      }
      delete moves[old];
      changed = true;
    } else if (complete && here.has(mv.to)) {
      delete moves[old];
      changed = true;
    }
  }

  const memos = new Set(memoBeats);
  const moved: { from: string; to: string }[] = [];
  const tracked = () => new Set([...Object.keys(notes), ...Object.values(leadBeats).filter((p): p is string => typeof p === "string"), ...memos]);
  if (complete) {
    const taken = tracked();
    const lost = [...taken].filter((p) => !here.has(p));
    const free = beats.filter((b) => !taken.has(b.path));
    for (const old of lost) {
      const size = sizes[old];
      if (size === undefined) continue;
      const name = fileStem(old);
      const fits = (b: ScannedBeat) => b.name === name && b.sizeBytes === size;
      const hits = free.filter(fits);
      // Two lost beats that both fit one file: no guess.
      if (hits.length !== 1 || lost.filter((o) => o !== old && fileStem(o) === name && sizes[o] === size).length > 0) continue;
      const to = hits[0];
      const text = notes[old];
      if (text !== undefined) {
        notes[to.path] = text;
        delete notes[old];
      }
      moves[old] = text !== undefined ? { to: to.path, size, text } : { to: to.path, size };
      for (const [hash, p] of Object.entries(leadBeats)) if (p === old) leadBeats[hash] = to.path;
      if (memos.delete(old)) memos.add(to.path);
      moved.push({ from: old, to: to.path });
      sizes[to.path] = to.sizeBytes;
      delete sizes[old];
      free.splice(free.indexOf(to), 1);
      changed = true;
    }
  }

  // Sizes of tracked beats only; a tracked beat missing from this scan keeps its last size.
  const keep = tracked();
  const nextSizes: Record<string, number> = {};
  for (const p of keep) {
    const s = here.get(p)?.sizeBytes ?? sizes[p];
    if (s !== undefined) nextSizes[p] = s;
  }
  if (JSON.stringify(nextSizes) !== JSON.stringify(links.beatNoteSizes ?? {})) changed = true;

  const ids = Object.keys(moves);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_BEAT_MOVES))) delete moves[old];

  return changed ? { beatNotes: notes, beatNoteSizes: nextSizes, beatNoteMoves: moves, leadBeats, moved } : null;
}

/** What the Digger keeps of the last dig across restarts (`save_last_dig`). */
export interface KeptDig {
  dig: DigResult;
  dugFor: string[];
  rounds: { links: WebLink[]; queries: string[]; seeds: string[] }[];
  roundResults: { query: string; videos: YoutubeVideo[] }[];
  liked: Liked[];
  shownRound: number;
  webQuery: string;
}

const str = (v: unknown, max = 600): string => (typeof v === "string" ? v.slice(0, max) : "");
const strs = (v: unknown, max = 50): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max).map((s) => s.slice(0, 600)) : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const httpsUrl = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
};

function restoreLinks(v: unknown): WebLink[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const o = obj(x);
    const url = httpsUrl(o?.url);
    return o && url ? [{ url, site: str(o.site, 60), text: str(o.text, 200), resolved: o.resolved === true }] : [];
  });
}

function restoreVideos(v: unknown): YoutubeVideo[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const o = obj(x);
    const id = str(o?.id, 11);
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return [];
    // url and thumbnail rebuilt from the checked id, as Rust does.
    return [{ id, title: str(o?.title, 200), channel: str(o?.channel, 100), publishedAt: str(o?.publishedAt, 40), url: `https://www.youtube.com/watch?v=${id}`, thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` }];
  });
}

/** The kept dig read back, every field checked (the file is ours, but
 * only what has the right shape comes back), or null. */
export function restoreDig(raw: unknown): KeptDig | null {
  const o = obj(raw);
  const d = obj(o?.dig);
  const a = obj(d?.analysis);
  if (!o || !d || !a || !str(a.summary)) return null;
  const beats: BeatFacts[] = (Array.isArray(d.beats) ? d.beats : []).flatMap((x) => {
    const b = obj(x);
    if (!b) return [];
    const src = b.bpmSource === "name" || b.bpmSource === "audio" ? b.bpmSource : null;
    return [{ name: str(b.name, 120), durationSec: num(b.durationSec) ?? 0, durationCapped: b.durationCapped === true, bpm: num(b.bpm), bpmSource: src, key: str(b.key, 12) || null, loudnessDb: num(b.loudnessDb), hitsPerSec: num(b.hitsPerSec) }];
  });
  const dig: DigResult = {
    model: str(d.model, 80),
    audioSent: d.audioSent === true,
    beats,
    failed: (Array.isArray(d.failed) ? d.failed : []).flatMap((x) => (obj(x) ? [{ name: str(obj(x)!.name, 120), error: str(obj(x)!.error, 1000) }] : [])),
    analysis: { summary: str(a.summary), traits: strs(a.traits, 6), tempo: str(a.tempo, 40), queries: strs(a.queries, 6), ...(str(a.heard) ? { heard: str(a.heard) } : {}) },
    web: restoreLinks(d.web),
    webSearches: strs(d.webSearches, 6),
    webError: str(d.webError) || null,
  };
  const rounds = (Array.isArray(o.rounds) ? o.rounds : []).slice(0, 50).flatMap((x) => {
    const r = obj(x);
    return r ? [{ links: restoreLinks(r.links), queries: strs(r.queries, 6), seeds: strs(r.seeds, MAX_LIKED) }] : [];
  });
  const roundResults = (Array.isArray(o.roundResults) ? o.roundResults : []).slice(0, 51).map((x) => {
    const r = obj(x);
    return { query: str(r?.query, MAX_QUERY_CHARS), videos: restoreVideos(r?.videos) };
  });
  const liked = (Array.isArray(o.liked) ? o.liked : []).flatMap((x) => {
    const l = obj(x);
    return l && str(l.id) ? [{ id: str(l.id, 2048), title: str(l.title, MAX_TITLE_CHARS) }] : [];
  }).slice(0, MAX_LIKED);
  const shown = num(o.shownRound) ?? 0;
  return {
    dig,
    dugFor: strs(o.dugFor, 5),
    rounds,
    roundResults,
    liked,
    shownRound: Math.max(0, Math.min(rounds.length, Math.floor(shown))),
    webQuery: str(o.webQuery, MAX_QUERY_CHARS),
  };
}

/** Noise YouTube uploaders put in beat titles. */
const NOISE = /\b(free|for profit|non profit|download|hq|hd|official|audio|instrumental|\d{2,3}\s?bpm|20\d\d)\b/gi;

/**
 * A beat file name turned into a search: brackets, `(prod. X)` and upload
 * noise dropped, separators made spaces, "type beat" kept or added.
 * "[FREE] Dark Trap Type Beat - "Night" (prod. X) 140bpm" → "Dark Trap Type Beat Night".
 */
export function beatQuery(name: string): string {
  let q = name
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\((?:prod|produced)[^)]*\)/gi, " ")
    .replace(/\b(?:prod|produced)\.?\s+by\b.*$/i, " ")
    .replace(/\bprod\.\s+.*$/i, " ")
    .replace(/[()"“”|_~*#@]+/g, " ")
    .replace(/\s[-–—]\s|\s[-–—]|[-–—]\s/g, " ")
    .replace(NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!q) return "";
  if (!/\bbeat\b/i.test(q)) q = `${q} type beat`;
  return q.slice(0, MAX_QUERY_CHARS).trim();
}
