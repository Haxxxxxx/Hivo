import { describe, expect, it } from "vitest";
import type { ProjectInfo, Workspace } from "../types";
import {
  collaborators,
  firstSaveMs,
  isFromFileDates,
  keyName,
  sampleFolder,
  songShape,
  stageDays,
  tempoKeyTendencies,
  weekdayRun,
  workingHours,
  yourSound,
} from "./tendencies";

const DAY = 864e5;
// A Wednesday at noon, local time (the working-hours read uses local time).
const NOW = new Date(2026, 9, 14, 12).getTime();

type Opts = Partial<Pick<ProjectInfo, "tempoBpm" | "modifiedAtMs" | "backups" | "renders" | "plugins" | "samples">>;
const song = (name: string, opts: Opts = {}): ProjectInfo =>
  ({
    path: `/p/${name}.flp`,
    name,
    modifiedAtMs: NOW - DAY,
    backups: [],
    renders: [],
    plugins: [],
    samples: [],
    tempoBpm: null,
    ...opts,
  }) as unknown as ProjectInfo;
const file = (ms: number) => ({ path: "/p/x", sizeBytes: 1, modifiedAtMs: ms });
const plugins = (...names: string[]) => names.map((name) => ({ name, vendor: null, installed: null }));
const samples = (...paths: string[]) => paths.map((path) => ({ path, status: "ok" as const }));
const ws = (songs: Workspace["songs"] = {}, people: Workspace["people"] = []): Workspace => ({ version: 2, songs, albums: [], people });

describe("tempo & key tendencies", () => {
  it("bins tempos by 10 BPM, empty bins between kept, and picks the modal bin and key", () => {
    const songs = [
      song("a", { tempoBpm: 142 }),
      song("b", { tempoBpm: 149.5 }),
      song("c", { tempoBpm: 140 }),
      song("d", { tempoBpm: 165 }),
      song("e", { tempoBpm: null }),
      song("f", { tempoBpm: 0 }),
    ];
    const meta = ws({ "/p/a.flp": { key: "Am" }, "/p/b.flp": { key: "Am" }, "/p/c.flp": { key: "F#" }, "/p/d.flp": { key: " " } });
    const out = tempoKeyTendencies(songs, meta);
    expect(out.bins).toEqual([
      { from: 140, count: 3 },
      { from: 150, count: 0 },
      { from: 160, count: 1 },
    ]);
    expect(out.withBpm).toBe(4);
    expect(out.typicalBin).toEqual({ from: 140, count: 3 });
    expect(out.keys).toEqual([
      { key: "Am", count: 2 },
      { key: "F#", count: 1 },
    ]);
    expect(out.typicalKey).toBe("Am");
  });

  it("is empty without tempos or keys, and keeps at most 5 keys", () => {
    const out = tempoKeyTendencies([song("a"), song("b")], ws());
    expect(out.bins).toEqual([]);
    expect(out.typicalBin).toBeNull();
    expect(out.typicalKey).toBeNull();
    const many = ["C", "D", "E", "F", "G", "A", "B"].map((k, i) => song(k, { tempoBpm: 120 + i }));
    const meta = ws(Object.fromEntries(many.map((p) => [p.path, { key: p.name }])));
    expect(tempoKeyTendencies(many, meta).keys).toHaveLength(5);
  });

  it("skips tempos outside FL's 10–522 range instead of binning them", () => {
    // A corrupt tempo in a REAPER or Ableton file must not create millions of empty bins.
    const songs = [song("a", { tempoBpm: 99999999 }), song("b", { tempoBpm: 5 }), song("c", { tempoBpm: 140 })];
    const out = tempoKeyTendencies(songs, ws());
    expect(out.bins).toEqual([{ from: 140, count: 1 }]);
    expect(out.withBpm).toBe(1);
    expect(tempoKeyTendencies([song("a", { tempoBpm: 99999999 })], ws()).bins).toEqual([]);
  });

  it("names a key for the headline", () => {
    expect(keyName("Am", "minor", "major")).toBe("A minor");
    expect(keyName("F#", "minor", "major")).toBe("F# major");
  });
});

describe("working hours", () => {
  const at = (daysAgo: number, hour: number) => {
    const d = new Date(NOW - daysAgo * DAY);
    d.setHours(hour, 30, 0, 0);
    return d.getTime();
  };
  it("counts saves per weekday and hour over the last 12 months", () => {
    // NOW is a Wednesday: 1 day ago = Tuesday, 2 = Monday, 6 = Thursday.
    const songs = [
      song("a", { modifiedAtMs: at(1, 23), backups: [file(at(1, 23)), file(at(2, 1)), file(at(6, 0)), file(at(400, 23))] }),
      song("b", { modifiedAtMs: at(6, 22) }),
    ];
    const out = workingHours(songs, NOW);
    expect(out.total).toBe(5);
    expect(out.grid[1][23]).toBe(2); // Tuesday 23h
    expect(out.grid[0][1]).toBe(1); // Monday 1h
    expect(out.grid[3][0]).toBe(1); // Thursday 0h
    expect(out.grid[3][22]).toBe(1);
    expect(out.max).toBe(2);
    expect(out.topWeekdays).toEqual([1, 3, 0]);
    // The 4-hour window 22:00–02:00 holds every save.
    expect(out.peakHour).toBe(22);
    expect(out.chronotype).toBe("nightOwl");
  });

  it("tells early birds and office hours apart, and has no chronotype without saves", () => {
    expect(workingHours([song("a", { modifiedAtMs: at(1, 7), backups: [file(at(2, 8))] })], NOW).chronotype).toBe("earlyBird");
    expect(workingHours([song("a", { modifiedAtMs: at(1, 14) })], NOW).chronotype).toBe("officeHours");
    const none = workingHours([song("a", { modifiedAtMs: 0 })], NOW);
    expect(none.total).toBe(0);
    expect(none.chronotype).toBeNull();
    expect(none.topWeekdays).toEqual([]);
  });

  it("joins consecutive top weekdays into a run", () => {
    expect(weekdayRun([3, 1, 2])).toEqual({ from: 1, to: 3 });
    expect(weekdayRun([1, 3, 5])).toBeNull();
    expect(weekdayRun([2])).toBeNull();
  });
});

describe("your sound", () => {
  it("ranks plugins and sample folders by distinct songs, never by instances or full paths", () => {
    const songs = [
      song("a", { plugins: plugins("Serum", "Serum", "Gross Beat"), samples: samples("C:\\Packs\\Drums\\Kicks\\k1.wav", "C:\\Packs\\Drums\\Kicks\\k2.wav") }),
      song("b", { plugins: plugins("Serum"), samples: samples("/Users/x/Packs/808s/sub.wav") }),
      song("c", { plugins: plugins("Omnisphere"), samples: samples("/Users/x/Packs/Kicks/k9.wav", "loose.wav") }),
    ];
    const out = yourSound(songs);
    expect(out.plugins).toEqual([
      { name: "Serum", songs: 2 },
      { name: "Gross Beat", songs: 1 },
      { name: "Omnisphere", songs: 1 },
    ]);
    expect(out.folders).toEqual([
      { name: "Kicks", songs: 2 },
      { name: "808s", songs: 1 },
    ]);
    expect(sampleFolder("loose.wav")).toBeNull();
  });

  it("names no folder for a sample at a drive root, the filesystem root or a home directory", () => {
    expect(sampleFolder("C:\\kick.wav")).toBeNull();
    expect(sampleFolder("/kick.wav")).toBeNull();
    expect(sampleFolder("/Users/kick.wav")).toBeNull();
    expect(sampleFolder("C:\\Packs\\kick.wav")).toBe("Packs");
    expect(sampleFolder("/Users/x/Packs/Kicks/kick.wav")).toBe("Kicks");
  });

  it("splits regulars (half of the last 10 saved songs) from what was dropped (3+ songs, none recent)", () => {
    // 13 songs: the 10 newest were saved 1–10 days ago, the 3 oldest 100+ days ago.
    const songs = Array.from({ length: 13 }, (_, i) =>
      song(`s${i}`, {
        modifiedAtMs: NOW - (i < 10 ? i + 1 : 100 + i) * DAY,
        plugins: plugins(...(i < 10 && i % 2 === 0 ? ["Serum"] : []), ...(i >= 10 ? ["Old Synth"] : []), ...(i === 0 ? ["Rare"] : [])),
        samples: samples(...(i >= 10 ? ["/old/Vinyl/crackle.wav"] : []), ...(i < 10 ? ["/new/Drums/x.wav"] : [])),
      }),
    );
    const out = yourSound(songs);
    expect(out.recentCount).toBe(10);
    expect(out.regulars).toEqual([
      { name: "Drums", kind: "folder", songs: 10 },
      { name: "Serum", kind: "plugin", songs: 5 },
    ]);
    expect(out.dropped).toEqual([
      { name: "Old Synth", kind: "plugin", songs: 3 },
      { name: "Vinyl", kind: "folder", songs: 3 },
    ]);
    // "Rare" is in one recent song: neither a regular nor dropped.
    expect(out.regulars.map((x) => x.name)).not.toContain("Rare");
    expect(out.dropped.map((x) => x.name)).not.toContain("Rare");
  });

  it("is empty without plugins or samples", () => {
    const out = yourSound([song("a")]);
    expect(out.plugins).toEqual([]);
    expect(out.folders).toEqual([]);
    expect(out.regulars).toEqual([]);
    expect(out.dropped).toEqual([]);
  });
});

describe("collaborators", () => {
  const people = [
    { id: "p1", name: "Ana", aliases: [], contact: "", notes: "" },
    { id: "p2", name: "Ben", aliases: [], contact: "", notes: "" },
    { id: "p3", name: "Cy", aliases: [], contact: "", notes: "" },
  ];
  it("counts songs per person with their most common role, and sorts recent from not lately", () => {
    const songs = [
      song("a", { modifiedAtMs: NOW - 10 * DAY }),
      song("b", { modifiedAtMs: NOW - 100 * DAY }),
      song("c", { modifiedAtMs: NOW - 200 * DAY, backups: [file(NOW - 300 * DAY)] }),
    ];
    const meta = ws(
      {
        "/p/a.flp": { credits: [{ personId: "p1", role: "Vocals" }, { personId: "p2", role: "Mix" }] },
        "/p/b.flp": { credits: [{ personId: "p1", role: "Vocals" }, { personId: "gone", role: "Beat" }] },
        "/p/c.flp": { credits: [{ personId: "p1", role: "Beat" }, { personId: "p3", role: "" }] },
      },
      people,
    );
    const out = collaborators(songs, meta, NOW);
    expect(out.hasCredits).toBe(true);
    expect(out.top.map((c) => [c.name, c.songs, c.role])).toEqual([
      ["Ana", 3, "Vocals"],
      ["Ben", 1, "Mix"],
      ["Cy", 1, ""],
    ]);
    expect(out.recent.map((c) => c.name)).toEqual(["Ana", "Ben"]);
    expect(out.notLately.map((c) => c.name)).toEqual(["Cy"]);
  });

  it("has no credits for a solo user", () => {
    const out = collaborators([song("a")], ws({ "/p/a.flp": { credits: [] } }, people), NOW);
    expect(out.hasCredits).toBe(false);
    expect(out.top).toEqual([]);
  });
});

describe("song shape", () => {
  it("medians versions and days to the first mixdown, and the share with one", () => {
    const songs = [
      song("a", { modifiedAtMs: NOW, backups: [file(NOW - 10 * DAY), file(NOW - 20 * DAY)], renders: [file(NOW - 5 * DAY), file(NOW - 12 * DAY)] }),
      song("b", { modifiedAtMs: NOW - 3 * DAY, renders: [file(NOW - 5 * DAY)] }),
      song("c", { modifiedAtMs: NOW - DAY, backups: [file(NOW - 2 * DAY)] }),
    ];
    const out = songShape(songs, ws(), NOW);
    expect(firstSaveMs(songs[0])).toBe(NOW - 20 * DAY);
    expect(out.medianVersions).toBe(2); // 3, 1, 2
    // a: 20 days back → first render 12 days back = 8 days; b: render before the first save = 0.
    expect(out.medianDaysToMixdown).toBe(4);
    expect(out.withMixdown).toBe(2);
    expect(out.total).toBe(3);
  });

  it("counts songs started per month over 12 months, with the finished ones", () => {
    const monthsAgo = (n: number, day = 15) => new Date(2026, 9 - n, day).getTime();
    const songs = [
      song("a", { modifiedAtMs: NOW, backups: [file(monthsAgo(2))] }),
      song("b", { modifiedAtMs: monthsAgo(2, 20) }),
      song("c", { modifiedAtMs: monthsAgo(0, 2) }),
      song("d", { modifiedAtMs: monthsAgo(13) }),
      song("e", { modifiedAtMs: 0 }),
    ];
    const out = songShape(songs, ws({ "/p/a.flp": { status: "prep" }, "/p/b.flp": { status: "creation" }, "/p/c.flp": { status: "release" } }), NOW);
    expect(out.starts).toHaveLength(12);
    expect(out.starts[0].month.getMonth()).toBe(10); // November last year
    expect(out.starts[11].month.getMonth()).toBe(9); // this October
    expect(out.starts[9]).toMatchObject({ started: 2, finished: 1 });
    expect(out.starts[11]).toMatchObject({ started: 1, finished: 1 });
    expect(out.starts.reduce((t, m) => t + m.started, 0)).toBe(3);
    expect(songShape([], ws(), NOW).medianVersions).toBeNull();
    expect(songShape([], ws(), NOW).medianDaysToMixdown).toBeNull();
  });
});

describe("tendency sources", () => {
  it("flags the blocks read from file dates", () => {
    expect(isFromFileDates("workingHours")).toBe(true);
    expect(isFromFileDates("songShape")).toBe(true);
    expect(isFromFileDates("tempoKey")).toBe(false);
    expect(isFromFileDates("yourSound")).toBe(false);
    expect(isFromFileDates("collaborators")).toBe(false);
  });

  it("reads days in each stage from the stage log, finished stays only", () => {
    const songs = [song("a"), song("b"), song("c")];
    const out = stageDays(
      songs,
      ws({
        "/p/a.flp": { stageLog: [{ stage: "creation", atMs: NOW - 30 * DAY }, { stage: "production", atMs: NOW - 20 * DAY }, { stage: "prep", atMs: NOW - 5 * DAY }] },
        "/p/b.flp": { stageLog: [{ stage: "creation", atMs: NOW - 10 * DAY }, { stage: "production", atMs: NOW - 6 * DAY }] },
        // One entry only: still in its first logged stage, nothing finished.
        "/p/c.flp": { stageLog: [{ stage: "creation", atMs: NOW - 3 * DAY }] },
      }),
    );
    // Creation: 10 and 4 days → 7; Production: 15 days; Prep is open, not counted.
    expect(out).toEqual([
      { stage: "creation", medianDays: 7, songs: 2 },
      { stage: "production", medianDays: 15, songs: 1 },
    ]);
  });

  it("prefers the stage log when it has data, else file dates", () => {
    const songs = [song("a", { renders: [file(NOW)] })];
    expect(songShape(songs, ws(), NOW)).toMatchObject({ timingSource: "fileDates", stageDays: [] });
    const logged = ws({ "/p/a.flp": { stageLog: [{ stage: "creation", atMs: NOW - 2 * DAY }, { stage: "production", atMs: NOW }] } });
    expect(songShape(songs, logged, NOW)).toMatchObject({ timingSource: "stageLog", stageDays: [{ stage: "creation", medianDays: 2, songs: 1 }] });
  });
});
