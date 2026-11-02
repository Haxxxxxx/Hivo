import type { Person, ProjectInfo, SongStatus, Workspace } from "../types";
import { songsOf } from "./people";
import { isFinished, lastSaveMs } from "./songs";

// Group-level stats for the dashboard (docs/ROADMAP.md, Phase 1a): who's
// working on what, and which tracks are stuck.

const DAY = 24 * 60 * 60 * 1000;
/** No FL save for this long while still being made = stalled. */
export const STALLED_DAYS = 21;

export interface StalledSong {
  song: ProjectInfo;
  status: SongStatus | undefined;
  idleDays: number;
}

/** Unfinished songs (Unsorted, Creation, Production) with no save (backups
 * included) in `days`+ days, most recently dropped first: a song left three
 * weeks ago matters more than an old idea from two years back. Unsorted
 * counts: most songs never get placed in a stage. Songs with no known save
 * date are left out rather than shown as decades old. */
export function stalledSongs(songs: ProjectInfo[], ws: Workspace, now = Date.now(), days = STALLED_DAYS): StalledSong[] {
  return songs
    .map((song) => ({ song, status: ws.songs[song.path]?.status, last: lastSaveMs(song) }))
    .filter((s) => !isFinished(s.status) && s.last > 0)
    .map(({ song, status, last }) => ({ song, status, idleDays: Math.floor((now - last) / DAY) }))
    .filter((s) => s.idleDays >= days)
    .sort((a, b) => a.idleDays - b.idleDays);
}

export interface CrewMember {
  person: Person;
  /** Songs they're credited on or found in, not archived. */
  songs: ProjectInfo[];
  /** Still being made (not Prep or later). */
  active: number;
  byStage: Partial<Record<SongStatus | "unsorted", number>>;
}

/** Each person and their songs, by name. No last-session time and no
 * "most active first" ranking (guardrail 3): a row opens the person. */
export function crewActivity(people: Person[], songs: ProjectInfo[], ws: Workspace): CrewMember[] {
  return people
    .map((person) => {
      const theirs = songsOf(person, songs, ws).map((x) => x.song);
      const byStage: CrewMember["byStage"] = {};
      for (const s of theirs) {
        const st = ws.songs[s.path]?.status ?? "unsorted";
        byStage[st] = (byStage[st] ?? 0) + 1;
      }
      return {
        person,
        songs: theirs,
        active: theirs.filter((s) => !isFinished(ws.songs[s.path]?.status)).length,
        byStage,
      };
    })
    .sort((a, b) => a.person.name.localeCompare(b.person.name));
}
