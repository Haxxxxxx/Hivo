import type { CrewMemberRow, CrewSongRow, SongStatus } from "../types";
import { dict, tr } from "../i18n";
import { STALLED_DAYS } from "./crew";
import { isFinished } from "./songs";

// Roadmap 1a: "stats that matter to the group vs only to me". Group stats are
// built only from what members chose to share (crew songs), never from local
// files: pipeline, who's moving what, what's stuck, what's coming out.
// Personal stats (studio activity, plugins, storage, health) stay on "Me".

const DAY = 24 * 60 * 60 * 1000;
export const RECENT_DAYS = 7;

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);
/** Latest sign of life: a save in FL or a stage move. */
export const lastActivityMs = (s: CrewSongRow) => Math.max(ms(s.last_saved_at), ms(s.stage_updated_at));

/** One member's shared songs, as counts only. No activity times and no
 * ranking (guardrail 3: coordination, never monitoring): each row is a way
 * into that member's songs on the crew board (`songsOfMember`). */
export interface CrewMemberStats {
  userId: string;
  name: string;
  songs: number;
  /** Still being made (Unsorted, Creation, Production). */
  making: number;
  finished: number;
}

export interface CrewStats {
  total: number;
  byStage: { id: SongStatus | null; count: number }[];
  inProgress: number;
  finished: number;
  /** Prep with a mixdown and an accepted Launch Kit: the next things to ship. */
  readyToShip: CrewSongRow[];
  movedRecently: number;
  stalled: { song: CrewSongRow; days: number; owner: string }[];
  upcoming: { song: CrewSongRow; owner: string; date: string }[];
  members: CrewMemberStats[];
}

const T = dict({ formerMember: "Former member" }, { formerMember: "Ancien membre" });

const STAGES: (SongStatus | null)[] = [null, "creation", "production", "prep", "release", "promotion"];

/** `today` is a local YYYY-MM-DD (release dates are plain dates). */
export function crewStats(songs: CrewSongRow[], members: CrewMemberRow[], now = Date.now(), today = localDay(now)): CrewStats {
  const nameOf = (id: string | null | undefined) => members.find((m) => m.user_id === id)?.display_name ?? tr(T).formerMember;
  const recent = now - RECENT_DAYS * DAY;

  const stalled = songs
    // No save or move date known: can't tell, so not "20,000 days" stalled.
    .filter((s) => (!s.stage || s.stage === "creation" || s.stage === "production") && lastActivityMs(s) > 0)
    .map((s) => ({ song: s, days: Math.floor((now - lastActivityMs(s)) / DAY), owner: nameOf(s.owner_id) }))
    .filter((x) => x.days >= STALLED_DAYS)
    // Most recently dropped first (same as the personal card).
    .sort((a, b) => a.days - b.days);

  const upcoming = songs
    .filter((s) => s.release_date && s.release_date >= today)
    .map((s) => ({ song: s, owner: nameOf(s.owner_id), date: s.release_date! }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const memberStats: CrewMemberStats[] = members.map((m) => {
    const own = songs.filter((s) => s.owner_id === m.user_id);
    return {
      userId: m.user_id,
      name: m.display_name,
      songs: own.length,
      making: own.filter((s) => !isFinished(s.stage ?? undefined)).length,
      finished: own.filter((s) => isFinished(s.stage ?? undefined)).length,
    };
  });
  // By name: the crew in a fixed order, never "most active first".
  memberStats.sort((a, b) => a.name.localeCompare(b.name));

  return {
    total: songs.length,
    byStage: STAGES.map((id) => ({ id, count: songs.filter((s) => (s.stage ?? null) === id).length })),
    inProgress: songs.filter((s) => s.stage === "creation" || s.stage === "production").length,
    finished: songs.filter((s) => isFinished(s.stage ?? undefined)).length,
    readyToShip: songs.filter((s) => s.stage === "prep" && s.has_mixdown && s.kit_accepted),
    movedRecently: songs.filter((s) => ms(s.stage_updated_at) >= recent && s.stage_updated_by).length,
    stalled,
    upcoming,
    members: memberStats,
  };
}

/** The songs one member shares (the crew board's member filter); every
 * song when `memberId` is null. */
export function songsOfMember<S extends Pick<CrewSongRow, "owner_id">>(songs: S[], memberId: string | null): S[] {
  return memberId ? songs.filter((s) => s.owner_id === memberId) : songs;
}

export function localDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
