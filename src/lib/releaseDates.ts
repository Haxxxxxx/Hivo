import type { Album, SongMeta } from "../types";

// Release dates for the Launch Kit and the Calendar, in one place so both
// say the same thing (docs/REVIEW-2026-11.md B9, B10).
//
// Rules:
// - A song on a dated release takes the release's date. A date pinned on the
//   song only because the kit suggested it (accept or export keeps the
//   suggestion) never beats it. A date the user typed that differs from the
//   release's is kept but flagged, never silently swapped.
// - A song on an undated release suggests the date its siblings already
//   have (one EP, one Friday), and siblings' dates are never "busy" for
//   each other.
// - Anything else gets the first free Friday with enough lead time.

const DAY = 24 * 60 * 60 * 1000;
/** Lead time to deliver to a distributor and pitch to Spotify editorial. */
export const LEAD_DAYS = 28;
/** Fridays skipped at most when looking for a free one. */
const MAX_SKIPS = 12;

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** yyyy-mm-dd → local Date, or null. */
export function parseDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}

/** First Friday at least `days` from today. */
export function fridayAfter(today: Date, days: number): Date {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
  return d;
}

/** Whole days from today to `date` (negative = past), or null. */
export function daysUntil(date: string, today = new Date()): number | null {
  const d = parseDate(date);
  if (!d) return null;
  return Math.round((d.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / DAY);
}

/** The release a song is on: a dated one first, else the first one. */
export function releaseOf(albums: Album[], path: string): Album | undefined {
  const on = albums.filter((a) => a.trackPaths.includes(path));
  return on.find((a) => a.releaseDate) ?? on[0];
}

/** Every other song on the same release(s) as `path`. */
export function siblingsOf(albums: Album[], path: string): string[] {
  const out = new Set<string>();
  for (const a of albums) if (a.trackPaths.includes(path)) a.trackPaths.forEach((p) => p !== path && out.add(p));
  return [...out];
}

/** The date pinned on a song's kit and where it came from. Pins saved
 * before the origin was recorded count as typed: shown, never dropped. */
export function kitPin(meta: SongMeta | undefined): { date: string; origin: "suggested" | "typed" } | null {
  const date = meta?.launchKit?.edits?.releaseDate;
  if (!date) return null;
  return { date, origin: meta?.launchKit?.releaseDatePin === "suggested" ? "suggested" : "typed" };
}

export interface BusyInput {
  path: string;
  albums: Album[];
  songs: Record<string, SongMeta>;
  /** The crew's songs (id = share id). */
  crewSongs?: { id: string; release_date: string | null }[];
}

/** Fridays already taken by other releases, other kits and the crew, but
 * never by the song's own release or its siblings (they share one date). */
export function busyDates({ path, albums, songs, crewSongs = [] }: BusyInput): string[] {
  const family = new Set([path, ...siblingsOf(albums, path)]);
  const familyShares = new Set([...family].map((p) => songs[p]?.shareId).filter((id): id is string => !!id));
  return [
    ...albums.filter((a) => !a.trackPaths.includes(path)).map((a) => a.releaseDate),
    ...Object.entries(songs)
      .filter(([p]) => !family.has(p))
      .map(([, m]) => m.launchKit?.edits?.releaseDate),
    ...crewSongs.filter((s) => !familyShares.has(s.id)).map((s) => s.release_date),
  ].filter((d): d is string => !!d && !!parseDate(d));
}

/** The date most of the siblings' kits have (earliest on a tie). */
export function siblingDate(albums: Album[], songs: Record<string, SongMeta>, path: string): string | null {
  const counts = new Map<string, number>();
  for (const p of siblingsOf(albums, path)) {
    const d = songs[p]?.launchKit?.edits?.releaseDate;
    if (d && parseDate(d)) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best?.[0] ?? null;
}

/** First Friday `LEAD_DAYS` out that isn't busy, and how many were skipped. */
export function firstFreeFriday(today: Date, busy: string[]): { date: string; skipped: number } {
  const taken = new Set(busy);
  let friday = fridayAfter(today, LEAD_DAYS);
  let skipped = 0;
  while (taken.has(isoDate(friday)) && skipped < MAX_SKIPS) {
    friday = new Date(friday.getFullYear(), friday.getMonth(), friday.getDate() + 7);
    skipped++;
  }
  return { date: isoDate(friday), skipped };
}

export type ResolvedDate =
  /** The release's own date. */
  | { from: "release"; value: string; release: Album }
  /** A date pinned on the kit (typed, or a kept suggestion). `mismatch` is
   * the release's date when a typed one differs from it. */
  | { from: "pinned"; value: string; origin: "suggested" | "typed"; release?: Album; mismatch?: string }
  /** The date the release's other tracks already have. */
  | { from: "siblings"; value: string; release: Album }
  /** The first free Friday. */
  | { from: "friday"; value: string; skipped: number; release?: Album };

export interface ResolveInput {
  path: string;
  meta: SongMeta | undefined;
  albums: Album[];
  songs?: Record<string, SongMeta>;
  busy?: string[];
  today?: Date;
}

/** The release date the kit shows and exports, and why. */
export function resolveReleaseDate({ path, meta, albums, songs = {}, busy = [], today = new Date() }: ResolveInput): ResolvedDate {
  const release = releaseOf(albums, path);
  const pin = kitPin(meta);
  if (release?.releaseDate) {
    if (pin && pin.origin === "typed" && pin.date !== release.releaseDate) {
      return { from: "pinned", value: pin.date, origin: "typed", release, mismatch: release.releaseDate };
    }
    return { from: "release", value: release.releaseDate, release };
  }
  if (pin) return { from: "pinned", value: pin.date, origin: pin.origin, release };
  if (release) {
    const shared = siblingDate(albums, songs, path);
    if (shared) return { from: "siblings", value: shared, release };
  }
  const { date, skipped } = firstFreeFriday(today, busy);
  return { from: "friday", value: date, skipped, release };
}

/** The date a song is out on for the Calendar, without the suggestions: the
 * release's date or the kit's pinned date, by the same rules as the kit
 * (so the Calendar and the exported files agree). Null when undated. */
export function datedRelease(path: string, meta: SongMeta | undefined, albums: Album[]): string | null {
  const release = releaseOf(albums, path);
  const pin = kitPin(meta);
  if (release?.releaseDate) return pin?.origin === "typed" ? pin.date : release.releaseDate;
  return pin?.date ?? null;
}
