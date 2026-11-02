import { describe, expect, it } from "vitest";
import type { CrewMemberRow, CrewSongRow, Person, ProjectInfo, Workspace } from "../types";
import { crewActivity, stalledSongs } from "./crew";
import { crewStats, songsOfMember } from "./crewStats";
import { lastSaveMs } from "./songs";

const NOW = Date.UTC(2026, 9, 14, 12);
const DAY = 864e5;
const song = (name: string, savedDaysAgo: number, backupsDaysAgo: number[] = []) =>
  ({
    path: `/p/${name}.flp`,
    name,
    modifiedAtMs: savedDaysAgo < 0 ? 0 : NOW - savedDaysAgo * DAY,
    backups: backupsDaysAgo.map((d, i) => ({ path: `/p/Backup/${name} ${i}.flp`, sizeBytes: 1, modifiedAtMs: NOW - d * DAY })),
    renders: [],
    plugins: [],
    samples: [],
  }) as unknown as ProjectInfo;
const ws = (songs: Workspace["songs"]): Workspace => ({ version: 2, songs, albums: [], people: [] });

describe("stalled songs (no save in 21+ days, not finished)", () => {
  const songs = [
    song("Fresh", 2),
    song("Old file, autosaved yesterday", 60, [1, 40]),
    song("Old", 30),
    song("Older", 90, [70]),
    song("Exactly 21", 21),
    song("20 days", 20),
    song("Old but in Prep", 80),
    song("Old but unsorted", 80),
    song("No date", -1),
  ];
  const meta = ws({
    "/p/Fresh.flp": { status: "creation" },
    "/p/Old file, autosaved yesterday.flp": { status: "production" },
    "/p/Old.flp": { status: "creation" },
    "/p/Older.flp": { status: "production" },
    "/p/Exactly 21.flp": { status: "creation" },
    "/p/20 days.flp": { status: "creation" },
    "/p/Old but in Prep.flp": { status: "prep" },
    "/p/No date.flp": { status: "creation" },
  });

  it("lists exactly the old unfinished ones (Unsorted included), most recently dropped first", () => {
    const got = stalledSongs(songs, meta, NOW).map((s) => [s.song.name, s.idleDays]);
    expect(got).toEqual([
      ["Exactly 21", 21],
      ["Old", 30],
      ["Older", 70],
      ["Old but unsorted", 80],
    ]);
  });

  it("counts FL's backups as saves", () => {
    expect(lastSaveMs(song("x", 60, [1, 40]))).toBe(NOW - DAY);
    expect(lastSaveMs(song("x", -1))).toBe(0);
  });
});

describe("crew stalled card", () => {
  const row = (title: string, stage: CrewSongRow["stage"], saved: number | null, moved: number | null = null) =>
    ({
      id: title,
      title,
      stage,
      owner_id: "u1",
      last_saved_at: saved == null ? null : new Date(NOW - saved * DAY).toISOString(),
      stage_updated_at: moved == null ? null : new Date(NOW - moved * DAY).toISOString(),
    }) as unknown as CrewSongRow;

  it("skips songs with no known date instead of showing them decades old", () => {
    const stats = crewStats(
      [
        row("Old", "creation", 40),
        row("Recent", "production", 3),
        row("Unknown", "creation", null),
        row("Moved lately", "creation", 50, 2),
        row("Old unsorted", null, 25),
        row("Old in Prep", "prep", 60),
      ],
      [],
      NOW,
    );
    expect(stats.stalled.map((s) => [s.song.title, s.days])).toEqual([
      ["Old unsorted", 25],
      ["Old", 40],
    ]);
  });
});

describe("who's on what (no ranking, no activity times)", () => {
  const member = (user_id: string, display_name: string) => ({ user_id, display_name }) as unknown as CrewMemberRow;
  const shared = (id: string, owner_id: string, stage: CrewSongRow["stage"], savedDaysAgo: number) =>
    ({
      id,
      title: id,
      stage,
      owner_id,
      last_saved_at: new Date(NOW - savedDaysAgo * DAY).toISOString(),
      stage_updated_at: new Date(NOW - savedDaysAgo * DAY).toISOString(),
      stage_updated_by: owner_id,
    }) as unknown as CrewSongRow;

  it("lists members by name with counts only", () => {
    const songs = [shared("s1", "u2", "creation", 1), shared("s2", "u2", "prep", 1), shared("s3", "u1", "production", 90), shared("s4", "u1", null, 90)];
    const stats = crewStats(songs, [member("u2", "Zed"), member("u1", "Abe"), member("u3", "Mo")], NOW);
    // By name, not by who saved last (Zed is the most recent).
    expect(stats.members.map((m) => m.name)).toEqual(["Abe", "Mo", "Zed"]);
    expect(stats.members[0]).toEqual({ userId: "u1", name: "Abe", songs: 2, making: 2, finished: 0 });
    expect(stats.members[2]).toEqual({ userId: "u2", name: "Zed", songs: 2, making: 1, finished: 1 });
    for (const m of stats.members) {
      expect(m).not.toHaveProperty("lastActivityMs");
      expect(m).not.toHaveProperty("recentMoves");
    }
  });

  it("scopes the crew board to one member's songs", () => {
    const songs = [shared("s1", "u2", "creation", 1), shared("s2", "u1", "prep", 1)];
    expect(songsOfMember(songs, "u1").map((s) => s.id)).toEqual(["s2"]);
    expect(songsOfMember(songs, "nobody")).toEqual([]);
    expect(songsOfMember(songs, null)).toBe(songs);
  });

  it("lists the people in the workspace by name, without a last session", () => {
    const people = [
      { id: "p1", name: "Zed", aliases: [] },
      { id: "p2", name: "Abe", aliases: [] },
    ] as unknown as Person[];
    const songs = [song("Recent", 1), song("Old", 300)].map((p) => ({ ...p, trackNames: [] }));
    const workspace = { ...ws({}), people, songs: { "/p/Recent.flp": { credits: [{ personId: "p1", role: "" }] }, "/p/Old.flp": { credits: [{ personId: "p2", role: "" }] } } } as unknown as Workspace;
    const out = crewActivity(people, songs, workspace);
    expect(out.map((m) => m.person.name)).toEqual(["Abe", "Zed"]);
    expect(out[0]).not.toHaveProperty("lastSessionMs");
  });
});
